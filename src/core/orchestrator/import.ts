// Feature import (adopt) and `tasks.md` import (plan 002 section 7.3, ADR 0019, ADR 0020, ADR 0032).
//
// `importFeature` adopts a feature whose spec and plan were approved before the store existed, or
// re-imports `tasks.md` of a feature already in execution after a later plan PR merged. Files are read
// from `origin/<baseBranch>` of the project, never from a work tree. Nothing is fetched here; the
// caller (`sync`, T18) fetches first. Any rejection (missing file, parser error, cycle, re-import
// blocked by a running task) writes nothing: all store writes happen in one transaction after every
// check passed.
//
// The stage record uses the commit returned by `VcsPort.lastCommitTouching` as evidence: the latest
// commit on the base branch that changed the file. For a file that was never edited again, this is the
// commit that brought it to the base branch.

import { featureId as makeFeatureId, taskId as makeTaskId, FEATURE_NUMBER_PATTERN, SLUG_PATTERN } from '../domain/ids.ts';
import type { Feature, Stage, Step } from '../domain/feature.ts';
import type { Task, TaskDependency } from '../domain/task.ts';
import { parseTasksMd } from '../dag/parse.ts';
import type { ParsedTask } from '../dag/parse.ts';
import type { TasksMdIssue } from '../dag/issue.ts';
import { planReimport } from '../dag/reimport.ts';
import type { ReimportBlocker, ReimportWarning } from '../dag/reimport.ts';
import { withDependencies } from '../dag/select.ts';
import type { ClockPort } from '../../ports/clock.ts';
import type { StorePort, TaskPatch } from '../../ports/store.ts';
import type { VcsPort } from '../../ports/vcs.ts';
import type { LoadedProject } from './projects.ts';

export interface ImportDeps {
  readonly vcs: VcsPort;
  readonly store: StorePort;
  readonly clock: ClockPort;
}

/** Files an adopted feature must have on the base branch. */
export const FEATURE_FILES = ['spec.md', 'plan.md', 'tasks.md'] as const;

export type ImportRejection =
  /** `NNN-slug` is not `<three digits>-<slug>`. */
  | { readonly ok: false; readonly reason: 'invalid_feature_name' }
  /** Some of `spec.md`, `plan.md`, `tasks.md` are not on `origin/<baseBranch>`. `missing` holds repo paths. */
  | { readonly ok: false; readonly reason: 'files_missing'; readonly ref: string; readonly missing: readonly string[] }
  /** `tasks.md` has errors (including cycles); `errors` are the parser's, with line and task id. */
  | { readonly ok: false; readonly reason: 'invalid_tasks'; readonly errors: readonly TasksMdIssue[] }
  /** The feature exists but is not in `execution`; its stages move through the gates, not through import. */
  | { readonly ok: false; readonly reason: 'feature_not_in_execution'; readonly stage: Stage }
  /** Re-import rejected: removed tasks that are running or in review (ADR 0019). */
  | { readonly ok: false; readonly reason: 'reimport_blocked'; readonly blockers: readonly ReimportBlocker[] };

export interface ImportSuccess {
  readonly ok: true;
  readonly mode: 'created' | 'reimported';
  readonly featureId: string;
  /** Commit of `origin/<baseBranch>` every file was read at. */
  readonly commit: string;
  /** Parser warnings (unknown keys and similar). */
  readonly warnings: readonly TasksMdIssue[];
  readonly reimportWarnings: readonly ReimportWarning[];
  /** Keys of the tasks created by this call. */
  readonly added: readonly string[];
  /** Keys of the tasks created already `done` (`[x] Done` on first import). */
  readonly addedDone: readonly string[];
  /** Keys of not-started tasks whose definition changed. */
  readonly updated: readonly string[];
  /** Keys set to `cancelled` because they left the file. */
  readonly cancelled: readonly string[];
  /** Keys of started tasks whose text changed in the file; their state is kept. */
  readonly textChanged: readonly string[];
  /** Keys of `done` tasks that left the file; kept as they are. */
  readonly removedKept: readonly string[];
}

export type ImportResult = ImportSuccess | ImportRejection;

const FEATURE_NAME = /^(\d{3})-([a-z0-9-]+)$/;

function featureName(name: string): { readonly number: string; readonly slug: string } | undefined {
  const match = FEATURE_NAME.exec(name);
  const number = match?.[1];
  const slug = match?.[2];
  if (number === undefined || slug === undefined) return undefined;
  if (!FEATURE_NUMBER_PATTERN.test(number) || !SLUG_PATTERN.test(slug)) return undefined;
  return { number, slug };
}

function newTask(project: string, number: string, fid: string, parsed: ParsedTask, commit: string, at: string): Task {
  return {
    id: makeTaskId(project, number, parsed.key),
    featureId: fid,
    key: parsed.key,
    ord: parsed.ord,
    title: parsed.title,
    status: parsed.done ? 'done' : 'todo',
    needsHuman: parsed.needsHuman,
    agentSlug: parsed.agent,
    profile: parsed.profile,
    bodyMd: parsed.bodyMd,
    sourceCommit: commit,
    branch: null,
    prNumber: null,
    prUrl: null,
    mergedAt: null,
    stopReason: null,
    retryNote: null,
    updatedAt: at,
  };
}

/**
 * Imports feature `featureName` (`NNN-slug`) of `loaded` from `origin/<baseBranch>`. First import
 * adopts the feature; when the feature is already in `execution` it re-imports `tasks.md`.
 */
export async function importFeature(deps: ImportDeps, loaded: LoadedProject, name: string): Promise<ImportResult> {
  const { vcs, store, clock } = deps;
  const parsedName = featureName(name);
  if (parsedName === undefined) return { ok: false, reason: 'invalid_feature_name' };
  const { number, slug } = parsedName;
  const { project } = loaded;
  const repoPath = project.repoPath;
  const ref = `origin/${loaded.registration.baseBranch}`;

  const commit = await vcs.resolveRef(repoPath, ref);
  const contents = new Map<string, string>();
  const missing: string[] = [];
  for (const file of FEATURE_FILES) {
    const path = `specs/${name}/${file}`;
    const text = await vcs.showFile(repoPath, commit, path);
    if (text === null) missing.push(path);
    else contents.set(file, text);
  }
  if (missing.length > 0) return { ok: false, reason: 'files_missing', ref, missing };

  const parsed = parseTasksMd(contents.get('tasks.md') as string);
  if (!parsed.ok) return { ok: false, reason: 'invalid_tasks', errors: parsed.errors };

  const fid = makeFeatureId(project.name, number);
  const existing = store.getFeature(fid);
  if (existing !== undefined && existing.stage !== 'execution') {
    return { ok: false, reason: 'feature_not_in_execution', stage: existing.stage };
  }

  // The latest commit touching each file; falls back to the commit read at when git reports none.
  const evidence = new Map<string, string>();
  for (const file of FEATURE_FILES) {
    evidence.set(file, (await vcs.lastCommitTouching(repoPath, commit, `specs/${name}/${file}`)) ?? commit);
  }
  const specCommit = evidence.get('spec.md') as string;
  const planCommit = evidence.get('plan.md') as string;
  const tasksCommit = evidence.get('tasks.md') as string;
  const at = clock.now().toISOString();

  if (existing === undefined) {
    const tasks = parsed.tasks.map((task) => newTask(project.name, number, fid, task, tasksCommit, at));
    const edges = edgesOf(project.name, number, parsed.tasks);
    const feature: Feature = {
      id: fid,
      project: project.name,
      number,
      slug,
      stage: 'idea',
      step: 'recorded',
      ideaText: null,
      createdAt: at,
      updatedAt: at,
    };
    const stages: readonly (readonly [Stage, Step, string])[] = [
      ['analysis', 'spec_pr_open', specCommit],
      ['spec_approved', 'plan_pr_open', specCommit],
      ['plan_approved', 'importing', planCommit],
      ['execution', 'running', tasksCommit],
    ];
    store.transaction(() => {
      if (store.getProject(project.name) === undefined) store.upsertProject(project);
      store.createFeature(feature);
      for (const [toStage, toStep, evidenceCommit] of stages) {
        if (toStage === 'execution') store.importTasks(fid, tasks, edges);
        store.applyFeatureTransition({ featureId: fid, toStage, toStep, at, evidenceCommit });
      }
    });
    return {
      ok: true,
      mode: 'created',
      featureId: fid,
      commit,
      warnings: parsed.warnings,
      reimportWarnings: [],
      added: parsed.tasks.map((task) => task.key),
      addedDone: parsed.tasks.filter((task) => task.done).map((task) => task.key),
      updated: [],
      cancelled: [],
      textChanged: [],
      removedKept: [],
    };
  }

  // Re-import (ADR 0019).
  const rows = store.listTasks({ featureId: fid });
  const currentEdges = store.listTaskDependencies(fid);
  const plan = planReimport(withDependencies(rows, currentEdges), parsed.tasks);
  if (!plan.ok) return { ok: false, reason: 'reimport_blocked', blockers: plan.blockers };

  const idOf = (key: string): string => makeTaskId(project.name, number, key);
  const added: Task[] = [];
  const patches = new Map<string, { -readonly [K in keyof TaskPatch]: TaskPatch[K] }>();
  const patchOf = (taskId: string): { -readonly [K in keyof TaskPatch]: TaskPatch[K] } => {
    let patch = patches.get(taskId);
    if (patch === undefined) {
      patch = { updatedAt: at };
      patches.set(taskId, patch);
    }
    return patch;
  };
  // Dependency keys per task id for tasks whose edges change.
  const edgeKeys = new Map<string, readonly string[]>();
  const result = { addedDone: [] as string[], updated: [] as string[], cancelled: [] as string[], textChanged: [] as string[], removedKept: [] as string[] };
  const noted: { readonly taskId: string; readonly type: string; readonly key: string }[] = [];

  for (const change of plan.changes) {
    switch (change.kind) {
      case 'add':
        added.push(newTask(project.name, number, fid, change.task, tasksCommit, at));
        edgeKeys.set(idOf(change.task.key), change.task.dependsOn);
        if (change.task.done) result.addedDone.push(change.task.key);
        break;
      case 'update': {
        const patch = patchOf(change.taskId);
        const c = change.changes;
        if (c.title !== undefined) patch.title = c.title;
        if (c.profile !== undefined) patch.profile = c.profile;
        if (c.agentSlug !== undefined) patch.agentSlug = c.agentSlug;
        if (c.needsHuman !== undefined) patch.needsHuman = c.needsHuman;
        if (c.bodyMd !== undefined) patch.bodyMd = c.bodyMd;
        if (c.dependsOn !== undefined) edgeKeys.set(change.taskId, c.dependsOn);
        patch.sourceCommit = tasksCommit;
        result.updated.push(change.key);
        break;
      }
      case 'reorder':
        patchOf(change.taskId).ord = change.ord;
        break;
      case 'cancel':
        patchOf(change.taskId).status = 'cancelled';
        result.cancelled.push(change.key);
        break;
      case 'text_changed':
        result.textChanged.push(change.key);
        noted.push({ taskId: change.taskId, type: 'task_text_changed', key: change.key });
        break;
      case 'removed_kept':
        result.removedKept.push(change.key);
        noted.push({ taskId: change.taskId, type: 'task_removed_kept', key: change.key });
        break;
    }
  }

  // Final edge set: current edges, with the edges of added and updated tasks replaced.
  const edges: TaskDependency[] = [
    ...currentEdges.filter((edge) => !edgeKeys.has(edge.taskId)),
    ...[...edgeKeys].flatMap(([taskId, keys]) => keys.map((key) => ({ taskId, dependsOnId: idOf(key) }))),
  ];

  store.transaction(() => {
    store.importTasks(fid, added, edges);
    for (const [taskId, patch] of patches) store.updateTask(taskId, patch);
    for (const note of noted) {
      const execution = store.listExecutions({ taskId: note.taskId, limit: 1 })[0];
      if (execution === undefined) continue;
      store.appendEvent({
        executionId: execution.id,
        at,
        type: note.type,
        payload: { task: note.taskId, commit: tasksCommit },
      });
    }
  });

  return {
    ok: true,
    mode: 'reimported',
    featureId: fid,
    commit,
    warnings: parsed.warnings,
    reimportWarnings: plan.warnings,
    added: added.map((task) => task.key),
    addedDone: result.addedDone,
    updated: result.updated,
    cancelled: result.cancelled,
    textChanged: result.textChanged,
    removedKept: result.removedKept,
  };
}

function edgesOf(project: string, number: string, tasks: readonly ParsedTask[]): TaskDependency[] {
  return tasks.flatMap((task) =>
    task.dependsOn.map((key) => ({
      taskId: makeTaskId(project, number, task.key),
      dependsOnId: makeTaskId(project, number, key),
    })),
  );
}
