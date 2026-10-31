// Sync step (plan 002 sections 7.9 and 8, ADR 0018, ADR 0032): fetches the Roster repo and every
// registered project, refreshes the registrations (T09) and reads the state of every task PR Roster has
// not yet seen closed. Merged ─► task `done` with `merged_at`; closed unmerged ─► task `rejected` with a
// reason; open ─► unchanged. Each change writes an `execution_events` row on the task's latest execution
// (the store has no task event table). A failure on one project or one PR is reported and does not stop
// the others. Hire, spec and plan PR transitions belong to later tasks.

import type { Task } from '../domain/task.ts';
import { formatMessage } from '../messages/format.ts';
import type { Language } from '../messages/language.ts';
import type { ForgePort } from '../../ports/forge.ts';
import { readProjects } from './projects.ts';
import type { RegistryDeps, RegistryReadResult } from './projects.ts';

export interface SyncDeps extends RegistryDeps {
  readonly forge: ForgePort;
  /** `human_language`, for the stored rejection reason. */
  readonly language: Language;
}

/** What went wrong during one sync, without stopping it. */
export interface SyncError {
  readonly kind: 'fetch' | 'pr';
  /** Project name for `fetch`; task id for `pr`. */
  readonly subject: string;
  /** Error class name and a length-limited message. */
  readonly message: string;
}

export interface TaskPrChange {
  readonly taskId: string;
  readonly change: 'merged' | 'closed';
}

export interface SyncResult {
  readonly registry: RegistryReadResult;
  /** Number of task PRs whose state was read. */
  readonly pullRequestsChecked: number;
  readonly changes: readonly TaskPrChange[];
  readonly errors: readonly SyncError[];
}

const MAX_ERROR_TEXT = 200;

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const text = error instanceof Error ? error.message : '';
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_ERROR_TEXT);
  return oneLine === '' ? name : `${name}: ${oneLine}`;
}

/** Tasks that have a PR and are waiting for its outcome. */
function awaitingPr(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.status === 'in_review' && t.prNumber !== null);
}

export async function sync(deps: SyncDeps): Promise<SyncResult> {
  const { vcs, store, clock, forge, language, rosterRepoPath } = deps;
  const errors: SyncError[] = [];

  await vcs.fetch(rosterRepoPath);
  const registry = await readProjects(deps);
  for (const loaded of registry.projects) {
    if (loaded.isRosterRepo) continue;
    try {
      await vcs.fetch(loaded.project.repoPath);
    } catch (error) {
      errors.push({ kind: 'fetch', subject: loaded.project.name, message: describeError(error) });
    }
  }

  const changes: TaskPrChange[] = [];
  let pullRequestsChecked = 0;
  for (const task of awaitingPr(store.listTasks())) {
    const prNumber = task.prNumber as number;
    try {
      const feature = store.getFeature(task.featureId);
      const project = feature === undefined ? undefined : store.getProject(feature.project);
      if (project === undefined) throw new Error('project of the task is not registered');
      const pr = await forge.prState(project.ownerRepo, prNumber);
      pullRequestsChecked += 1;
      if (pr.state === 'open') continue;

      const at = clock.now().toISOString();
      const execution = store.listExecutions({ taskId: task.id, limit: 1 })[0];
      store.transaction(() => {
        if (pr.state === 'merged') {
          store.updateTask(task.id, { status: 'done', mergedAt: pr.mergedAt, stopReason: null, updatedAt: at });
        } else {
          const reason = formatMessage(language, 'stop.prClosedUnmerged', {
            prUrl: task.prUrl ?? `#${prNumber}`,
            task: task.id,
          });
          store.updateTask(task.id, { status: 'rejected', stopReason: reason, updatedAt: at });
        }
        if (execution !== undefined) {
          store.appendEvent({
            executionId: execution.id,
            at,
            type: pr.state === 'merged' ? 'pr_merged' : 'pr_closed_unmerged',
            payload: {
              task: task.id,
              prNumber,
              prUrl: task.prUrl,
              ...(pr.state === 'merged' ? { mergedAt: pr.mergedAt } : {}),
            },
          });
        }
      });
      changes.push({ taskId: task.id, change: pr.state === 'merged' ? 'merged' : 'closed' });
    } catch (error) {
      errors.push({ kind: 'pr', subject: task.id, message: describeError(error) });
    }
  }

  return { registry, pullRequestsChecked, changes, errors };
}
