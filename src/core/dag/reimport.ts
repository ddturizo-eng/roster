// Re-import of `tasks.md` after a later plan PR merged (ADR 0019). Pure: compares the tasks the
// store has for one feature with the freshly parsed file and returns what to do. The caller applies
// the changes in one transaction; a rejected plan writes nothing.
//
// Tasks are matched by key (`Tnn`), the same as the id suffix of `<project>:<NNN>-<Tnn>`.

import type { TaskStatus } from '../domain/task.ts';
import type { ParsedTask } from './parse.ts';
import type { DagTask } from './select.ts';

/** Statuses of tasks that have not started: their definition follows the file (ADR 0019). */
const NOT_STARTED: ReadonlySet<TaskStatus> = new Set([
  'todo',
  'waiting_hire',
  'blocked',
  'failed',
  'stopped',
  'rejected',
]);

/** Statuses that keep their state; changed text is recorded as an event (ADR 0019). */
const KEEP_STATE: ReadonlySet<TaskStatus> = new Set(['done', 'in_review', 'running']);

/** Fields of a not-started task that differ from the file. Only changed fields are present. */
export interface TaskFieldChanges {
  readonly title?: string;
  readonly profile?: string | null;
  readonly agentSlug?: string | null;
  readonly needsHuman?: string | null;
  readonly bodyMd?: string;
  /** New dependency keys (`Tnn`); the caller turns them into full ids and edges. */
  readonly dependsOn?: readonly string[];
}

export type ReimportChange =
  /** New in the file: create it. `task.done` imports it as `done` (first import of that task). */
  | { readonly kind: 'add'; readonly task: ParsedTask }
  /** Not started and different from the file: update the listed fields. */
  | { readonly kind: 'update'; readonly taskId: string; readonly key: string; readonly changes: TaskFieldChanges }
  /** `done`, `in_review` or `running` and its text changed: keep the state, record an event. */
  | { readonly kind: 'text_changed'; readonly taskId: string; readonly key: string; readonly bodyMd: string }
  /** The position in the file moved (any task still in the file except `cancelled`). */
  | { readonly kind: 'reorder'; readonly taskId: string; readonly key: string; readonly ord: number }
  /** Removed from the file and never started: set `cancelled`. */
  | { readonly kind: 'cancel'; readonly taskId: string; readonly key: string }
  /** Removed from the file but already `done`: keep it; record an event. */
  | { readonly kind: 'removed_kept'; readonly taskId: string; readonly key: string };

/** A removed task that is running or in review; it rejects the whole re-import. */
export interface ReimportBlocker {
  readonly taskId: string;
  readonly key: string;
  readonly status: TaskStatus;
}

export interface ReimportWarning {
  readonly taskId: string;
  readonly key: string;
  readonly code: 'cancelled_reappeared';
}

export type ReimportPlan =
  | {
      readonly ok: true;
      /** Order: file order for tasks in the file, then removed tasks in store order. */
      readonly changes: readonly ReimportChange[];
      readonly warnings: readonly ReimportWarning[];
    }
  | { readonly ok: false; readonly blockers: readonly ReimportBlocker[] };

/**
 * Decides the re-import of one feature. `existing` are the feature's task rows with their
 * dependency ids; `parsed` is a valid result of `parseTasksMd` (no errors).
 */
export function planReimport(existing: readonly DagTask[], parsed: readonly ParsedTask[]): ReimportPlan {
  const byKey = new Map(existing.map((task) => [task.key, task] as const));
  const keyOfId = new Map(existing.map((task) => [task.id, task.key] as const));
  const inFile = new Set(parsed.map((task) => task.key));

  const blockers: ReimportBlocker[] = existing
    .filter((task) => !inFile.has(task.key) && (task.status === 'running' || task.status === 'in_review'))
    .map((task) => ({ taskId: task.id, key: task.key, status: task.status }));
  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const changes: ReimportChange[] = [];
  const warnings: ReimportWarning[] = [];

  for (const task of parsed) {
    const row = byKey.get(task.key);
    if (row === undefined) {
      changes.push({ kind: 'add', task });
      continue;
    }
    if (row.status === 'cancelled') {
      // ADR 0020 gives `cancelled` no way out and ADR 0019 is silent: leave it and say so.
      warnings.push({ taskId: row.id, key: row.key, code: 'cancelled_reappeared' });
      continue;
    }
    if (row.ord !== task.ord) {
      changes.push({ kind: 'reorder', taskId: row.id, key: row.key, ord: task.ord });
    }
    if (NOT_STARTED.has(row.status)) {
      const fieldChanges = diffFields(row, task, keyOfId);
      if (Object.keys(fieldChanges).length > 0) {
        changes.push({ kind: 'update', taskId: row.id, key: row.key, changes: fieldChanges });
      }
    } else if (KEEP_STATE.has(row.status) && comparableBody(row.bodyMd) !== comparableBody(task.bodyMd)) {
      changes.push({ kind: 'text_changed', taskId: row.id, key: row.key, bodyMd: task.bodyMd });
    }
  }

  for (const row of existing) {
    if (inFile.has(row.key) || row.status === 'cancelled') {
      continue;
    }
    changes.push(
      row.status === 'done'
        ? { kind: 'removed_kept', taskId: row.id, key: row.key }
        : { kind: 'cancel', taskId: row.id, key: row.key },
    );
  }

  return { ok: true, changes, warnings };
}

function diffFields(row: DagTask, task: ParsedTask, keyOfId: ReadonlyMap<string, string>): TaskFieldChanges {
  const changes: { -readonly [K in keyof TaskFieldChanges]: TaskFieldChanges[K] } = {};
  if (row.title !== task.title) {
    changes.title = task.title;
  }
  if (row.profile !== task.profile) {
    changes.profile = task.profile;
  }
  if (row.agentSlug !== task.agent) {
    changes.agentSlug = task.agent;
  }
  if (row.needsHuman !== task.needsHuman) {
    changes.needsHuman = task.needsHuman;
  }
  if (comparableBody(row.bodyMd) !== comparableBody(task.bodyMd)) {
    changes.bodyMd = task.bodyMd;
  }
  const currentKeys = row.dependsOn.map((id) => keyOfId.get(id) ?? id);
  if (!sameSet(currentKeys, task.dependsOn)) {
    changes.dependsOn = task.dependsOn;
  }
  return changes;
}

/**
 * The `Done` checkbox is ignored for tasks the store already has (ADR 0019), so ticking it in a PR
 * is not a change of text.
 */
function comparableBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/^- \[[xX]\] Done[ \t]*$/m, '- [ ] Done');
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}
