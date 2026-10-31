// `roster sync` (plan 002 section 7.9): fetch, refresh registrations, read PR states.

import { sync } from '../../core/orchestrator/sync.ts';
import type { SyncDeps } from '../../core/orchestrator/sync.ts';
import type { ConsolePort } from '../../ports/console.ts';
import { describeError } from '../describe-error.ts';

export const SYNC_USAGE = 'Usage: roster sync';

export interface SyncCommandDeps extends SyncDeps {
  readonly console: ConsolePort;
}

/** Returns 0 when the sync ran (problems of single projects or PRs are listed), 1 on a usage error or a failed fetch. */
export async function runSyncCommand(args: readonly string[], deps: SyncCommandDeps): Promise<number> {
  const out = deps.console;
  if (args.length > 0) {
    out.printError(SYNC_USAGE);
    return 1;
  }
  let result;
  try {
    result = await sync(deps);
  } catch (error) {
    out.printError(`Sync failed: ${describeError(error)}`);
    return 1;
  }
  out.print(
    `Synced ${result.registry.projects.length} project(s) at ${result.registry.commit}; ` +
      `${result.pullRequestsChecked} pull request(s) checked.`,
  );
  for (const change of result.changes) {
    out.print(`${change.taskId}: pull request ${change.change === 'merged' ? 'merged, task done' : 'closed without merge, task rejected'}.`);
  }
  for (const issue of result.registry.issues) out.printError(`${issue.file}: ${issue.field} ${issue.message}`);
  for (const error of result.errors) out.printError(`${error.kind} ${error.subject}: ${error.message}`);
  return 0;
}
