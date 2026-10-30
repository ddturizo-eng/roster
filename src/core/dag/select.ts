// Readiness and selection (ADR 0019). Pure; the store supplies the rows.
//
// Ready = status `todo`, no `Needs human`, and every dependency has status `done` (its PR merged).
// Selection = oldest feature in stage `execution` first, then file order (`ord`).

import type { Feature } from '../domain/feature.ts';
import type { Task, TaskDependency, TaskStatus } from '../domain/task.ts';

/**
 * A task row with the full ids (`<project>:<NNN>-<Tnn>`) of the tasks it depends on. The `tasks`
 * table has no such column; the edges live in `task_dependencies`, see `withDependencies`.
 */
export interface DagTask extends Task {
  readonly dependsOn: readonly string[];
}

/** Joins task rows with the edges of `task_dependencies`. Edge order follows the given list. */
export function withDependencies(tasks: readonly Task[], edges: readonly TaskDependency[]): DagTask[] {
  const byTask = new Map<string, string[]>();
  for (const edge of edges) {
    const list = byTask.get(edge.taskId);
    if (list === undefined) {
      byTask.set(edge.taskId, [edge.dependsOnId]);
    } else {
      list.push(edge.dependsOnId);
    }
  }
  return tasks.map((task) => ({ ...task, dependsOn: byTask.get(task.id) ?? [] }));
}

/** Index by full task id. */
export function indexTasks<T extends Pick<Task, 'id'>>(tasks: readonly T[]): Map<string, T> {
  return new Map(tasks.map((task) => [task.id, task] as const));
}

/**
 * ADR 0019 readiness. A dependency missing from `tasksById` counts as not done, so a dangling edge
 * never makes a task ready. `cancelled` does not satisfy a dependency: only `done` does.
 */
export function isReady(task: DagTask, tasksById: ReadonlyMap<string, { readonly status: TaskStatus }>): boolean {
  if (task.status !== 'todo' || task.needsHuman !== null) {
    return false;
  }
  return task.dependsOn.every((id) => tasksById.get(id)?.status === 'done');
}

/**
 * The next task to run, or null. Features not in stage `execution` are ignored. Features are taken
 * oldest first (`createdAt`, an ISO 8601 UTC string; ties by `number`, then `id`), tasks in file
 * order. A feature without a ready task does not block the next feature.
 */
export function selectNext(features: readonly Feature[], tasks: readonly DagTask[]): DagTask | null {
  const byId = indexTasks(tasks);
  const executing = features
    .filter((feature) => feature.stage === 'execution')
    .sort(
      (a, b) =>
        compareText(a.createdAt, b.createdAt) || compareText(a.number, b.number) || compareText(a.id, b.id),
    );
  for (const feature of executing) {
    const ready = tasks
      .filter((task) => task.featureId === feature.id && isReady(task, byId))
      .sort((a, b) => a.ord - b.ord);
    const [next] = ready;
    if (next !== undefined) {
      return next;
    }
  }
  return null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
