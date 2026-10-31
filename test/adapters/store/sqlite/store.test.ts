import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  StoreMigrationError,
  StoreOperationError,
  openSqliteStore,
} from '../../../../src/adapters/store/sqlite/index.ts';
import type { SqliteStore } from '../../../../src/adapters/store/sqlite/index.ts';
import { NotFoundError } from '../../../../src/core/domain/errors.ts';
import type { Feature } from '../../../../src/core/domain/feature.ts';
import type { Project } from '../../../../src/core/domain/project.ts';
import type { Task } from '../../../../src/core/domain/task.ts';

// Each test gets a fresh directory under the OS temp dir. The store is closed before the directory
// is removed, because Windows keeps `roster.db`, `-wal` and `-shm` locked while the file is open.
const dirs: string[] = [];
const open: SqliteStore[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roster-store-'));
  dirs.push(dir);
  return join(dir, 'data', 'roster.db');
}

function openStore(path: string = tempDb(), options?: Parameters<typeof openSqliteStore>[1]): SqliteStore {
  const store = openSqliteStore(path, options);
  open.push(store);
  return store;
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const project: Project = {
  name: 'roster',
  repoPath: 'C:\\roster',
  remoteUrl: 'https://github.com/ddturizo-eng/roster',
  ownerRepo: 'ddturizo-eng/roster',
  registrationCommit: 'abc1234',
  syncedAt: '2026-10-30T10:00:00.000Z',
};

const feature = (number: string, createdAt: string, overrides: Partial<Feature> = {}): Feature => ({
  id: `roster:${number}`,
  project: 'roster',
  number,
  slug: `feature-${number}`,
  stage: 'idea',
  step: 'recorded',
  ideaText: 'An idea',
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

const task = (featureId: string, key: string, ord: number, overrides: Partial<Task> = {}): Task => ({
  id: `${featureId}-${key}`,
  featureId,
  key,
  ord,
  title: `Task ${key}`,
  status: 'todo',
  needsHuman: null,
  agentSlug: null,
  profile: 'TS core',
  bodyMd: `## ${key}\n\nBody with 'quotes' and "double quotes"; DROP TABLE tasks;`,
  sourceCommit: 'def5678',
  branch: null,
  prNumber: null,
  prUrl: null,
  mergedAt: null,
  stopReason: null,
  retryNote: null,
  updatedAt: '2026-10-30T10:00:00.000Z',
  ...overrides,
});

function seed(store: SqliteStore): void {
  store.upsertProject(project);
  store.createFeature(feature('002', '2026-10-30T10:00:00.000Z'));
}

describe('open: engine, pragmas, migrations', () => {
  it('creates the parent directory and the file, and turns on WAL and foreign keys', () => {
    const path = tempDb();
    openStore(path).close();
    expect(existsSync(path)).toBe(true);
    const raw = new DatabaseSync(path);
    try {
      expect((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    } finally {
      raw.close();
    }
  });

  it('applies the migrations once and records them', () => {
    const path = tempDb();
    let tick = 0;
    openStore(path, { now: () => `2026-10-30T10:00:0${tick++}.000Z` }).close();
    openStore(path, { now: () => `2026-10-30T11:00:0${tick++}.000Z` }).close();
    const raw = new DatabaseSync(path);
    try {
      const rows = raw.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
      expect(rows.map((row) => Number(row.version))).toEqual(MIGRATIONS.map((m) => m.version));
      expect(rows[0]?.applied_at).toBe('2026-10-30T10:00:00.000Z');
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual([
        'approval_requests',
        'execution_events',
        'execution_steps',
        'executions',
        'feature_events',
        'features',
        'grilling',
        'projects',
        'runtime_state',
        'schema_migrations',
        'task_dependencies',
        'tasks',
      ]);
    } finally {
      raw.close();
    }
  });

  it('keeps data across re-open and applies only a new migration', () => {
    const path = tempDb();
    const first = openStore(path);
    first.upsertProject(project);
    first.close();
    const extra = { version: 3, name: 'extra', sql: 'CREATE TABLE extra (id INTEGER PRIMARY KEY)' };
    const second = openStore(path, { migrations: [...MIGRATIONS, extra] });
    expect(second.getProject('roster')).toEqual(project);
    second.close();
    openStore(path, { migrations: [...MIGRATIONS, extra] }).close();
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: MIGRATIONS.length + 1 });
    } finally {
      raw.close();
    }
  });

  it('rolls back every migration when one fails, and the file stays openable', () => {
    const path = tempDb();
    const broken = { version: 3, name: 'broken', sql: 'CREATE TABLE ok_table (id INTEGER); CREATE TABLE ok_table (id INTEGER)' };
    expect(() => openStore(path, { migrations: [...MIGRATIONS, broken] })).toThrow(StoreMigrationError);
    const raw = new DatabaseSync(path);
    try {
      // One transaction: on a fresh file, versions 1 and 2 are rolled back with the broken version 3.
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables).toEqual([]);
    } finally {
      raw.close();
    }
    openStore(path).close();
  });

  it('refuses a database newer than this build', () => {
    const path = tempDb();
    openStore(path, { migrations: [...MIGRATIONS, { version: 3, name: 'later', sql: 'SELECT 1' }] }).close();
    expect(() => openStore(path)).toThrow(StoreMigrationError);
  });

  it('prints no ExperimentalWarning while loading', () => {
    const warnings: string[] = [];
    const listener = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on('warning', listener);
    openStore().close();
    process.off('warning', listener);
    expect(warnings).not.toContain('ExperimentalWarning');
  });
});

describe('projects', () => {
  it('round-trips and upserts', () => {
    const store = openStore();
    expect(store.getProject('roster')).toBeUndefined();
    store.upsertProject(project);
    expect(store.getProject('roster')).toEqual(project);
    const updated = { ...project, registrationCommit: 'fff0000', syncedAt: '2026-10-31T00:00:00.000Z' };
    store.upsertProject(updated);
    store.upsertProject({ ...project, name: 'alpha' });
    expect(store.getProject('roster')).toEqual(updated);
    expect(store.listProjects().map((p) => p.name)).toEqual(['alpha', 'roster']);
  });
});

describe('features, events and grilling', () => {
  it('round-trips a feature and lists oldest first, filtered by project', () => {
    const store = openStore();
    store.upsertProject(project);
    store.upsertProject({ ...project, name: 'other' });
    const second = feature('003', '2026-10-31T10:00:00.000Z', { ideaText: null });
    const first = feature('002', '2026-10-30T10:00:00.000Z');
    store.createFeature(second);
    store.createFeature(first);
    store.createFeature({ ...feature('001', '2026-10-29T10:00:00.000Z'), id: 'other:001', project: 'other' });
    expect(store.getFeature('roster:002')).toEqual(first);
    expect(store.getFeature('roster:003')).toEqual(second);
    expect(store.getFeature('roster:999')).toBeUndefined();
    expect(store.listFeatures({ project: 'roster' }).map((f) => f.id)).toEqual(['roster:002', 'roster:003']);
    expect(store.listFeatures().map((f) => f.id)).toEqual(['other:001', 'roster:002', 'roster:003']);
  });

  it('enforces foreign keys and unique ids', () => {
    const store = openStore();
    expect(() => store.createFeature(feature('002', '2026-10-30T10:00:00.000Z'))).toThrow(StoreOperationError);
    store.upsertProject(project);
    store.createFeature(feature('002', '2026-10-30T10:00:00.000Z'));
    expect(() => store.createFeature(feature('002', '2026-10-30T10:00:00.000Z'))).toThrow(StoreOperationError);
    expect(() =>
      store.addGrillingQuestion({
        featureId: 'roster:404',
        round: 1,
        questionHuman: 'q',
        questionEn: 'q',
        askedAt: '2026-10-30T10:00:00.000Z',
      }),
    ).toThrow(StoreOperationError);
  });

  it('error messages name the operation and never the row content', () => {
    const store = openStore();
    const secret = 'sk-secret-idea-text';
    try {
      store.createFeature(feature('002', '2026-10-30T10:00:00.000Z', { ideaText: secret }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StoreOperationError);
      expect((error as StoreOperationError).name).toBe('StoreOperationError');
      expect((error as StoreOperationError).operation).toBe('createFeature');
      expect((error as StoreOperationError).message).not.toContain(secret);
    }
  });

  it('applies a transition: updates the feature and appends an event with its evidence', () => {
    const store = openStore();
    seed(store);
    const event = store.applyFeatureTransition({
      featureId: 'roster:002',
      toStage: 'analysis',
      toStep: 'questions_pending',
      at: '2026-10-30T11:00:00.000Z',
    });
    expect(event).toEqual({
      id: event.id,
      featureId: 'roster:002',
      fromStage: 'idea',
      toStage: 'analysis',
      step: 'questions_pending',
      at: '2026-10-30T11:00:00.000Z',
      prUrl: null,
      mergedAt: null,
      evidenceCommit: null,
      reason: null,
    });
    const gate = store.applyFeatureTransition({
      featureId: 'roster:002',
      toStage: 'spec_approved',
      toStep: 'plan_job_pending',
      at: '2026-10-30T12:00:00.000Z',
      prUrl: 'https://github.com/ddturizo-eng/roster/pull/1',
      mergedAt: '2026-10-30T11:59:00.000Z',
      evidenceCommit: 'abc1234',
      reason: 'spec merged',
    });
    expect(gate.fromStage).toBe('analysis');
    expect(gate.prUrl).toBe('https://github.com/ddturizo-eng/roster/pull/1');
    expect(gate.evidenceCommit).toBe('abc1234');
    expect(store.getFeature('roster:002')).toMatchObject({
      stage: 'spec_approved',
      step: 'plan_job_pending',
      updatedAt: '2026-10-30T12:00:00.000Z',
    });
    expect(store.listFeatureEvents('roster:002')).toEqual([event, gate]);
  });

  it('throws NotFoundError for a transition of a missing feature and writes nothing', () => {
    const store = openStore();
    expect(() =>
      store.applyFeatureTransition({ featureId: 'roster:404', toStage: 'analysis', toStep: 'drafting', at: 'x' }),
    ).toThrow(NotFoundError);
    expect(store.listFeatureEvents('roster:404')).toEqual([]);
  });

  it('rolls back the feature update when the event insert fails', () => {
    const path = tempDb();
    const store = openStore(path);
    seed(store);
    // Force a failure of the second statement: a raw connection adds a trigger that aborts event inserts.
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER fail_events BEFORE INSERT ON feature_events BEGIN SELECT RAISE(ABORT, 'forced'); END");
    raw.close();
    expect(() =>
      store.applyFeatureTransition({
        featureId: 'roster:002',
        toStage: 'analysis',
        toStep: 'drafting',
        at: '2026-10-30T11:00:00.000Z',
      }),
    ).toThrow(StoreOperationError);
    expect(store.getFeature('roster:002')).toMatchObject({ stage: 'idea', step: 'recorded' });
    expect(store.listFeatureEvents('roster:002')).toEqual([]);
  });

  it('stores grilling questions and answers in insertion order', () => {
    const store = openStore();
    seed(store);
    const q1 = store.addGrillingQuestion({
      featureId: 'roster:002',
      round: 1,
      questionHuman: 'Cual es el alcance?',
      questionEn: 'What is the scope?',
      askedAt: '2026-10-30T11:00:00.000Z',
    });
    const q2 = store.addGrillingQuestion({
      featureId: 'roster:002',
      round: 1,
      questionHuman: 'Y los plazos?',
      questionEn: 'And the deadlines?',
      askedAt: '2026-10-30T11:00:01.000Z',
    });
    expect(q1).toMatchObject({ round: 1, answerHuman: null, answeredAt: null });
    expect(q2.id).toBeGreaterThan(q1.id);
    store.answerGrillingQuestion(q1.id, 'Todo el nucleo local', '2026-10-30T11:05:00.000Z');
    expect(store.listGrilling('roster:002')).toEqual([
      { ...q1, answerHuman: 'Todo el nucleo local', answeredAt: '2026-10-30T11:05:00.000Z' },
      q2,
    ]);
    expect(() => store.answerGrillingQuestion(999, 'a', 'b')).toThrow(NotFoundError);
  });
});

describe('tasks and dependencies', () => {
  it('round-trips every task column, including nulls and special characters', () => {
    const store = openStore();
    seed(store);
    const full = task('roster:002', 'T01', 1, {
      status: 'in_review',
      needsHuman: 'Writes a protected path',
      agentSlug: 'roster-core-ts-engineer',
      branch: 'agent/002-T01',
      prNumber: 12,
      prUrl: 'https://github.com/ddturizo-eng/roster/pull/12',
      mergedAt: '2026-10-30T12:00:00.000Z',
      stopReason: 'reason',
      retryNote: 'note',
    });
    const bare = task('roster:002', 'T02', 2);
    store.importTasks('roster:002', [bare, full], [{ taskId: bare.id, dependsOnId: full.id }]);
    expect(store.getTask(full.id)).toEqual(full);
    expect(store.getTask(bare.id)).toEqual(bare);
    expect(store.getTask('roster:002-T99')).toBeUndefined();
    expect(store.listTasks({ featureId: 'roster:002' }).map((t) => t.key)).toEqual(['T01', 'T02']);
    expect(store.listTaskDependencies('roster:002')).toEqual([{ taskId: bare.id, dependsOnId: full.id }]);
  });

  it('filters by project, feature and status and orders by feature then ord', () => {
    const store = openStore();
    seed(store);
    store.upsertProject({ ...project, name: 'other' });
    store.createFeature(feature('001', '2026-10-31T00:00:00.000Z', { id: 'other:001', project: 'other' }));
    store.createFeature(feature('003', '2026-10-29T00:00:00.000Z'));
    store.importTasks('roster:002', [task('roster:002', 'T02', 2), task('roster:002', 'T01', 1, { status: 'done' })], []);
    store.importTasks('other:001', [task('other:001', 'T01', 1)], []);
    store.importTasks('roster:003', [task('roster:003', 'T01', 1)], []);
    expect(store.listTasks().map((t) => t.id)).toEqual([
      'roster:003-T01',
      'roster:002-T01',
      'roster:002-T02',
      'other:001-T01',
    ]);
    expect(store.listTasks({ project: 'other' }).map((t) => t.id)).toEqual(['other:001-T01']);
    expect(store.listTasks({ status: 'done' }).map((t) => t.id)).toEqual(['roster:002-T01']);
    expect(store.listTasks({ featureId: 'roster:002', status: 'todo' }).map((t) => t.id)).toEqual(['roster:002-T02']);
    expect(store.listTaskDependencies()).toEqual([]);
  });

  it('upserts by id and replaces the feature edges', () => {
    const store = openStore();
    seed(store);
    const [a, b, c] = [task('roster:002', 'T01', 1), task('roster:002', 'T02', 2), task('roster:002', 'T03', 3)] as [
      Task,
      Task,
      Task,
    ];
    store.importTasks('roster:002', [a, b], [{ taskId: b.id, dependsOnId: a.id }]);
    store.importTasks(
      'roster:002',
      [{ ...a, title: 'Renamed', ord: 5 }, c],
      [
        { taskId: c.id, dependsOnId: a.id },
        { taskId: c.id, dependsOnId: b.id },
      ],
    );
    expect(store.getTask(a.id)).toMatchObject({ title: 'Renamed', ord: 5 });
    expect(store.getTask(b.id)).toEqual(b);
    expect(store.listTaskDependencies('roster:002')).toEqual([
      { taskId: c.id, dependsOnId: a.id },
      { taskId: c.id, dependsOnId: b.id },
    ]);
  });

  it('rolls back every task and edge when an edge names an unknown task', () => {
    const store = openStore();
    seed(store);
    const a = task('roster:002', 'T01', 1);
    store.importTasks('roster:002', [a], []);
    const b = task('roster:002', 'T02', 2);
    expect(() =>
      store.importTasks(
        'roster:002',
        [{ ...a, title: 'Changed' }, b],
        [{ taskId: b.id, dependsOnId: 'roster:002-T99' }],
      ),
    ).toThrow(StoreOperationError);
    expect(store.getTask(a.id)).toEqual(a);
    expect(store.getTask(b.id)).toBeUndefined();
    expect(store.listTaskDependencies()).toEqual([]);
  });

  it('keeps the old edges when the import fails after they were deleted', () => {
    const store = openStore();
    seed(store);
    const [a, b] = [task('roster:002', 'T01', 1), task('roster:002', 'T02', 2)] as [Task, Task];
    store.importTasks('roster:002', [a, b], [{ taskId: b.id, dependsOnId: a.id }]);
    // A task in a missing feature violates the foreign key after the edges were already deleted.
    const lost = task('roster:002', 'T03', 3);
    expect(() =>
      store.importTasks('roster:002', [lost, { ...a, status: 'done' }], [{ taskId: 'nope', dependsOnId: a.id }]),
    ).toThrow(StoreOperationError);
    expect(store.listTaskDependencies()).toEqual([{ taskId: b.id, dependsOnId: a.id }]);
    expect(store.getTask(a.id)?.status).toBe('todo');
    expect(store.getTask(lost.id)).toBeUndefined();
  });

  it('rolls back on a task of another feature and on a missing feature', () => {
    const store = openStore();
    seed(store);
    const a = task('roster:002', 'T01', 1);
    expect(() => store.importTasks('roster:002', [a, task('roster:003', 'T01', 1)], [])).toThrow(StoreOperationError);
    expect(() => store.importTasks('roster:404', [task('roster:404', 'T01', 1)], [])).toThrow(StoreOperationError);
    expect(store.listTasks()).toEqual([]);
  });

  it('rolls back an import inside an outer transaction without losing the outer work', () => {
    const store = openStore();
    seed(store);
    store.transaction(() => {
      store.upsertProject({ ...project, name: 'kept' });
      expect(() =>
        store.importTasks(
          'roster:002',
          [task('roster:002', 'T01', 1)],
          [{ taskId: 'roster:002-T01', dependsOnId: 'missing' }],
        ),
      ).toThrow(StoreOperationError);
    });
    expect(store.getProject('kept')).toBeDefined();
    expect(store.listTasks()).toEqual([]);
  });

  it('updates only the given columns, clears with null and refreshes updated_at', () => {
    const store = openStore();
    seed(store);
    const a = task('roster:002', 'T01', 1, { agentSlug: 'x', branch: 'agent/002-T01', retryNote: 'n' });
    store.importTasks('roster:002', [a], []);
    const updated = store.updateTask(a.id, {
      status: 'running',
      branch: null,
      prNumber: 7,
      updatedAt: '2026-10-30T13:00:00.000Z',
    });
    expect(updated).toEqual({
      ...a,
      status: 'running',
      branch: null,
      prNumber: 7,
      updatedAt: '2026-10-30T13:00:00.000Z',
    });
    expect(store.getTask(a.id)).toEqual(updated);
    expect(() => store.updateTask('roster:002-T99', { status: 'done', updatedAt: 'x' })).toThrow(NotFoundError);
  });
});

describe('transaction', () => {
  it('commits on success and rolls back everything when fn throws, returning the value', () => {
    const store = openStore();
    expect(store.transaction(() => (store.upsertProject(project), 42))).toBe(42);
    expect(() =>
      store.transaction(() => {
        store.upsertProject({ ...project, name: 'gone' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getProject('gone')).toBeUndefined();
    expect(store.getProject('roster')).toBeDefined();
  });

  it('nested failure rolls back only the inner work when the outer catches it', () => {
    const store = openStore();
    store.transaction(() => {
      store.upsertProject({ ...project, name: 'outer' });
      try {
        store.transaction(() => {
          store.upsertProject({ ...project, name: 'inner' });
          throw new Error('inner');
        });
      } catch {
        // expected
      }
    });
    expect(store.listProjects().map((p) => p.name)).toEqual(['outer']);
  });
});
