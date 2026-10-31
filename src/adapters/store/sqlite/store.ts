// SQLite store (plan 002 section 5, ADR 0017, ADR 0018): one file, WAL, foreign keys on, numbered
// migrations applied in one transaction at open. Explicit SQL with bound parameters only; column
// names in dynamic `SET` clauses come from fixed maps in this file, never from callers.
//
// T06 implements projects, features, grilling and tasks. T07 adds the rest of `StorePort` (executions,
// steps, events, approvals, runtime state) with a new migration and widens `CoreStore` to `StorePort`.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { NotFoundError, RosterError } from '../../../core/domain/errors.ts';
import type { Feature, FeatureEvent, GrillingEntry, Stage, Step } from '../../../core/domain/feature.ts';
import type { Project } from '../../../core/domain/project.ts';
import type { Task, TaskDependency, TaskStatus } from '../../../core/domain/task.ts';
import type {
  FeatureTransition,
  NewGrillingQuestion,
  StorePort,
  TaskFilter,
  TaskPatch,
} from '../../../ports/store.ts';
import { StoreMigrationError, StoreOpenError, StoreOperationError } from './errors.ts';
import { loadSqlite } from './load.ts';
import { MIGRATIONS } from './migrations.ts';
import type { Migration } from './migrations.ts';

/** The part of `StorePort` implemented so far (T06). */
export type CoreStore = Pick<
  StorePort,
  | 'transaction'
  | 'close'
  | 'upsertProject'
  | 'getProject'
  | 'listProjects'
  | 'createFeature'
  | 'getFeature'
  | 'listFeatures'
  | 'applyFeatureTransition'
  | 'listFeatureEvents'
  | 'addGrillingQuestion'
  | 'answerGrillingQuestion'
  | 'listGrilling'
  | 'importTasks'
  | 'getTask'
  | 'listTasks'
  | 'updateTask'
  | 'listTaskDependencies'
>;

export interface OpenStoreOptions {
  /** ISO 8601 UTC clock for `schema_migrations.applied_at`. Defaults to the system clock. */
  readonly now?: () => string;
  /** Migrations to apply. Defaults to the shipped list; tests pass a longer or broken list. */
  readonly migrations?: readonly Migration[];
}

type Row = Record<string, unknown>;

const TASK_COLUMNS = {
  ord: 'ord',
  title: 'title',
  status: 'status',
  needsHuman: 'needs_human',
  agentSlug: 'agent_slug',
  profile: 'profile',
  bodyMd: 'body_md',
  sourceCommit: 'source_commit',
  branch: 'branch',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  mergedAt: 'merged_at',
  stopReason: 'stop_reason',
  retryNote: 'retry_note',
} as const;

const PATCHABLE = Object.keys(TASK_COLUMNS) as (keyof typeof TASK_COLUMNS)[];

const str = (value: unknown): string => value as string;
const strOrNull = (value: unknown): string | null => (value === null ? null : (value as string));
const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => (value === null ? null : Number(value));

const toProject = (row: Row): Project => ({
  name: str(row.name),
  repoPath: str(row.repo_path),
  remoteUrl: str(row.remote_url),
  ownerRepo: str(row.owner_repo),
  registrationCommit: str(row.registration_commit),
  syncedAt: str(row.synced_at),
});

const toFeature = (row: Row): Feature => ({
  id: str(row.id),
  project: str(row.project),
  number: str(row.number),
  slug: str(row.slug),
  stage: str(row.stage) as Stage,
  step: str(row.step) as Step,
  ideaText: strOrNull(row.idea_text),
  createdAt: str(row.created_at),
  updatedAt: str(row.updated_at),
});

const toFeatureEvent = (row: Row): FeatureEvent => ({
  id: num(row.id),
  featureId: str(row.feature_id),
  fromStage: strOrNull(row.from_stage) as Stage | null,
  toStage: str(row.to_stage) as Stage,
  step: str(row.step) as Step,
  at: str(row.at),
  prUrl: strOrNull(row.pr_url),
  mergedAt: strOrNull(row.merged_at),
  evidenceCommit: strOrNull(row.evidence_commit),
  reason: strOrNull(row.reason),
});

const toGrilling = (row: Row): GrillingEntry => ({
  id: num(row.id),
  featureId: str(row.feature_id),
  round: num(row.round),
  questionHuman: str(row.question_human),
  questionEn: str(row.question_en),
  answerHuman: strOrNull(row.answer_human),
  askedAt: str(row.asked_at),
  answeredAt: strOrNull(row.answered_at),
});

const toTask = (row: Row): Task => ({
  id: str(row.id),
  featureId: str(row.feature_id),
  key: str(row.key),
  ord: num(row.ord),
  title: str(row.title),
  status: str(row.status) as TaskStatus,
  needsHuman: strOrNull(row.needs_human),
  agentSlug: strOrNull(row.agent_slug),
  profile: strOrNull(row.profile),
  bodyMd: str(row.body_md),
  sourceCommit: str(row.source_commit),
  branch: strOrNull(row.branch),
  prNumber: numOrNull(row.pr_number),
  prUrl: strOrNull(row.pr_url),
  mergedAt: strOrNull(row.merged_at),
  stopReason: strOrNull(row.stop_reason),
  retryNote: strOrNull(row.retry_note),
  updatedAt: str(row.updated_at),
});

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

/** Opens (creating if needed) the store file, enables WAL and foreign keys, and migrates it. */
export function openSqliteStore(path: string, options: OpenStoreOptions = {}): SqliteStore {
  const { DatabaseSync: Database } = loadSqlite();
  let db: DatabaseSync;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
  } catch (error) {
    throw new StoreOpenError('the database file cannot be opened', errorCode(error));
  }
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, options.migrations ?? MIGRATIONS, options.now ?? (() => new Date().toISOString()));
  } catch (error) {
    db.close();
    if (error instanceof RosterError) throw error;
    throw new StoreOpenError('the database cannot be configured', errorCode(error));
  }
  return new SqliteStore(db);
}

function migrate(db: DatabaseSync, migrations: readonly Migration[], now: () => string): void {
  db.exec('BEGIN IMMEDIATE');
  let version: number | null = null;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(
      (db.prepare('SELECT version FROM schema_migrations').all() as Row[]).map((row) => num(row.version)),
    );
    const known = new Set(migrations.map((migration) => migration.version));
    for (const old of applied) {
      if (!known.has(old)) throw new StoreMigrationError('the database is newer than this build', old);
    }
    const pending = migrations.filter((migration) => !applied.has(migration.version));
    for (const migration of [...pending].sort((a, b) => a.version - b.version)) {
      version = migration.version;
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, now());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (error instanceof StoreMigrationError) throw error;
    throw new StoreMigrationError(`SQLite error ${errorCode(error) ?? 'unknown'}`, version);
  }
}

export class SqliteStore implements CoreStore {
  readonly #db: DatabaseSync;
  #depth = 0;
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Runs `fn` as the named operation; SQLite failures become `StoreOperationError`. */
  #op<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof RosterError) throw error;
      throw new StoreOperationError(operation, errorCode(error), { cause: error });
    }
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #run(sql: string, ...params: SQLInputValue[]): { readonly changes: number; readonly id: number } {
    const result = this.#prepare(sql).run(...params);
    return { changes: Number(result.changes), id: Number(result.lastInsertRowid) };
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#prepare(sql).get(...params) as Row | undefined;
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#prepare(sql).all(...params) as Row[];
  }

  /** Outermost call is a transaction; nested calls are savepoints, so inner failures roll back alone. */
  transaction<T>(fn: () => T): T {
    const nested = this.#depth > 0;
    const savepoint = `roster_${this.#depth}`;
    this.#op('transaction', () => this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'));
    this.#depth += 1;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.#depth -= 1;
      // SQLite can roll back by itself on severe errors; only undo what is still open.
      if (this.#db.isTransaction) {
        this.#db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      }
      throw error;
    }
    this.#depth -= 1;
    this.#op('transaction', () => this.#db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'));
    return result;
  }

  close(): void {
    this.#statements.clear();
    if (this.#db.isOpen) this.#db.close();
  }

  // Projects

  upsertProject(project: Project): void {
    this.#op('upsertProject', () => {
      this.#run(
        `INSERT INTO projects (name, repo_path, remote_url, owner_repo, registration_commit, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET repo_path = excluded.repo_path, remote_url = excluded.remote_url,
           owner_repo = excluded.owner_repo, registration_commit = excluded.registration_commit,
           synced_at = excluded.synced_at`,
        project.name,
        project.repoPath,
        project.remoteUrl,
        project.ownerRepo,
        project.registrationCommit,
        project.syncedAt,
      );
    });
  }

  getProject(name: string): Project | undefined {
    return this.#op('getProject', () => {
      const row = this.#get('SELECT * FROM projects WHERE name = ?', name);
      return row === undefined ? undefined : toProject(row);
    });
  }

  listProjects(): readonly Project[] {
    return this.#op('listProjects', () => this.#all('SELECT * FROM projects ORDER BY name').map(toProject));
  }

  // Features

  createFeature(feature: Feature): void {
    this.#op('createFeature', () => {
      this.#run(
        `INSERT INTO features (id, project, number, slug, stage, step, idea_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        feature.id,
        feature.project,
        feature.number,
        feature.slug,
        feature.stage,
        feature.step,
        feature.ideaText,
        feature.createdAt,
        feature.updatedAt,
      );
    });
  }

  getFeature(id: string): Feature | undefined {
    return this.#op('getFeature', () => {
      const row = this.#get('SELECT * FROM features WHERE id = ?', id);
      return row === undefined ? undefined : toFeature(row);
    });
  }

  listFeatures(filter: { readonly project?: string } = {}): readonly Feature[] {
    return this.#op('listFeatures', () =>
      this.#all(
        'SELECT * FROM features WHERE (?1 IS NULL OR project = ?1) ORDER BY created_at, id',
        filter.project ?? null,
      ).map(toFeature),
    );
  }

  applyFeatureTransition(transition: FeatureTransition): FeatureEvent {
    return this.#op('applyFeatureTransition', () =>
      this.transaction(() => {
        const current = this.#get('SELECT stage FROM features WHERE id = ?', transition.featureId);
        if (current === undefined) throw new NotFoundError('feature', transition.featureId);
        this.#run(
          'UPDATE features SET stage = ?, step = ?, updated_at = ? WHERE id = ?',
          transition.toStage,
          transition.toStep,
          transition.at,
          transition.featureId,
        );
        const inserted = this.#run(
          `INSERT INTO feature_events
             (feature_id, from_stage, to_stage, step, at, pr_url, merged_at, evidence_commit, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          transition.featureId,
          str(current.stage),
          transition.toStage,
          transition.toStep,
          transition.at,
          transition.prUrl ?? null,
          transition.mergedAt ?? null,
          transition.evidenceCommit ?? null,
          transition.reason ?? null,
        );
        return toFeatureEvent(this.#get('SELECT * FROM feature_events WHERE id = ?', inserted.id) as Row);
      }),
    );
  }

  listFeatureEvents(featureId: string): readonly FeatureEvent[] {
    return this.#op('listFeatureEvents', () =>
      this.#all('SELECT * FROM feature_events WHERE feature_id = ? ORDER BY id', featureId).map(toFeatureEvent),
    );
  }

  // Grilling

  addGrillingQuestion(question: NewGrillingQuestion): GrillingEntry {
    return this.#op('addGrillingQuestion', () => {
      const inserted = this.#run(
        `INSERT INTO grilling (feature_id, round, question_human, question_en, asked_at)
         VALUES (?, ?, ?, ?, ?)`,
        question.featureId,
        question.round,
        question.questionHuman,
        question.questionEn,
        question.askedAt,
      );
      return toGrilling(this.#get('SELECT * FROM grilling WHERE id = ?', inserted.id) as Row);
    });
  }

  answerGrillingQuestion(id: number, answerHuman: string, answeredAt: string): void {
    this.#op('answerGrillingQuestion', () => {
      const result = this.#run(
        'UPDATE grilling SET answer_human = ?, answered_at = ? WHERE id = ?',
        answerHuman,
        answeredAt,
        id,
      );
      if (result.changes === 0) throw new NotFoundError('grilling question', String(id));
    });
  }

  listGrilling(featureId: string): readonly GrillingEntry[] {
    return this.#op('listGrilling', () =>
      this.#all('SELECT * FROM grilling WHERE feature_id = ? ORDER BY id', featureId).map(toGrilling),
    );
  }

  // Tasks

  importTasks(featureId: string, tasks: readonly Task[], dependencies: readonly TaskDependency[]): void {
    this.#op('importTasks', () => {
      if (tasks.some((task) => task.featureId !== featureId)) {
        throw new StoreOperationError('importTasks', 'TASK_OUTSIDE_FEATURE');
      }
      this.transaction(() => {
        // The feature's edges are replaced as a whole; the foreign keys reject unknown tasks.
        this.#run(
          'DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE feature_id = ?)',
          featureId,
        );
        for (const task of tasks) {
          this.#run(
            `INSERT INTO tasks (id, feature_id, key, ord, title, status, needs_human, agent_slug, profile, body_md,
               source_commit, branch, pr_number, pr_url, merged_at, stop_reason, retry_note, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET key = excluded.key, ord = excluded.ord, title = excluded.title,
               status = excluded.status, needs_human = excluded.needs_human, agent_slug = excluded.agent_slug,
               profile = excluded.profile, body_md = excluded.body_md, source_commit = excluded.source_commit,
               branch = excluded.branch, pr_number = excluded.pr_number, pr_url = excluded.pr_url,
               merged_at = excluded.merged_at, stop_reason = excluded.stop_reason,
               retry_note = excluded.retry_note, updated_at = excluded.updated_at`,
            task.id,
            task.featureId,
            task.key,
            task.ord,
            task.title,
            task.status,
            task.needsHuman,
            task.agentSlug,
            task.profile,
            task.bodyMd,
            task.sourceCommit,
            task.branch,
            task.prNumber,
            task.prUrl,
            task.mergedAt,
            task.stopReason,
            task.retryNote,
            task.updatedAt,
          );
        }
        for (const edge of dependencies) {
          const owner = this.#get('SELECT feature_id FROM tasks WHERE id = ?', edge.taskId);
          if (owner === undefined || owner.feature_id !== featureId) {
            throw new StoreOperationError('importTasks', 'EDGE_OUTSIDE_FEATURE');
          }
          this.#run(
            'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)',
            edge.taskId,
            edge.dependsOnId,
          );
        }
      });
    });
  }

  getTask(id: string): Task | undefined {
    return this.#op('getTask', () => {
      const row = this.#get('SELECT * FROM tasks WHERE id = ?', id);
      return row === undefined ? undefined : toTask(row);
    });
  }

  listTasks(filter: TaskFilter = {}): readonly Task[] {
    return this.#op('listTasks', () =>
      this.#all(
        `SELECT t.* FROM tasks t JOIN features f ON f.id = t.feature_id
         WHERE (?1 IS NULL OR t.feature_id = ?1) AND (?2 IS NULL OR f.project = ?2) AND (?3 IS NULL OR t.status = ?3)
         ORDER BY f.created_at, t.feature_id, t.ord`,
        filter.featureId ?? null,
        filter.project ?? null,
        filter.status ?? null,
      ).map(toTask),
    );
  }

  updateTask(id: string, patch: TaskPatch): Task {
    return this.#op('updateTask', () => {
      const sets: string[] = ['updated_at = ?'];
      const values: SQLInputValue[] = [patch.updatedAt];
      for (const key of PATCHABLE) {
        const value = patch[key];
        if (value === undefined) continue;
        sets.push(`${TASK_COLUMNS[key]} = ?`);
        values.push(value);
      }
      const result = this.#run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
      if (result.changes === 0) throw new NotFoundError('task', id);
      return toTask(this.#get('SELECT * FROM tasks WHERE id = ?', id) as Row);
    });
  }

  listTaskDependencies(featureId?: string): readonly TaskDependency[] {
    return this.#op('listTaskDependencies', () =>
      this.#all(
        `SELECT d.task_id, d.depends_on_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
         WHERE (?1 IS NULL OR t.feature_id = ?1) ORDER BY d.rowid`,
        featureId ?? null,
      ).map((row) => ({ taskId: str(row.task_id), dependsOnId: str(row.depends_on_id) })),
    );
  }
}
