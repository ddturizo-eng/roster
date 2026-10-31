// `roster run [--dry-run]` (plan 002 section 7.4, ADR 0015).
//
//   lock (busy -> exit 0) -> recover interrupted -> night limit (exit 0) -> Docker check (exit 2)
//   -> sync -> policy -> one unit of work (`runNext`) -> release lock
//
// Exit code: 0 on every handled outcome (busy, night limit, nothing to do, any stop of a task, a
// failed fetch or an invalid policy), 2 when Docker is unavailable, and 1 only for a bug (an error
// that is not a RosterError, which is rethrown) or a usage error. The lock is released in `finally`;
// `guardLockOnExit` (lock.ts) covers Ctrl+C and uncaught errors.
//
// `--dry-run` takes no lock, recovers nothing and starts nothing. It fetches and refreshes the
// registration cache (the only write), reads PR states without applying them (a task whose PR is
// merged counts as done for the selection), and prints the selected task and the planned steps.

import { RosterError } from '../../core/domain/errors.ts';
import { withDependencies, selectNext } from '../../core/dag/select.ts';
import { messagesFor } from '../../core/messages/format.ts';
import type { Language } from '../../core/messages/language.ts';
import { recoverInterrupted, runNext } from '../../core/orchestrator/run.ts';
import type { RunDeps } from '../../core/orchestrator/run.ts';
import { readProjects } from '../../core/orchestrator/projects.ts';
import type { LoadedProject } from '../../core/orchestrator/projects.ts';
import { sync } from '../../core/orchestrator/sync.ts';
import type { Policy } from '../../core/policy/policy.ts';
import type { ClockPort } from '../../ports/clock.ts';
import type { ConsolePort } from '../../ports/console.ts';
import type { FileSystemPort } from '../../ports/file-system.ts';
import type { ForgePort } from '../../ports/forge.ts';
import type { RuntimePort } from '../../ports/runtime.ts';
import type { SandboxPort } from '../../ports/sandbox.ts';
import type { SecretsPort } from '../../ports/secrets.ts';
import type { StorePort } from '../../ports/store.ts';
import type { CommitAuthor, VcsPort } from '../../ports/vcs.ts';
import type { NightWindow } from '../config.ts';
import { describeError } from '../describe-error.ts';
import type { RunLock } from '../lock.ts';
import { currentWindowStart } from '../night-window.ts';
import { loadPolicy } from '../policy-files.ts';

export const RUN_USAGE = 'Usage: roster run [--dry-run]';

/** Steps `runNext` performs for a task today (plan 002 section 8). */
export const PLANNED_STEPS: readonly string[] = ['workspace', 'agent', 'policy', 'commit', 'push', 'pr'];

export interface RunCommandDeps {
  readonly vcs: VcsPort;
  readonly store: StorePort;
  readonly clock: ClockPort;
  readonly forge: ForgePort;
  readonly sandbox: SandboxPort;
  readonly fs: FileSystemPort;
  readonly secrets: SecretsPort;
  readonly console: ConsolePort;
  readonly language: Language;
  readonly rosterRepoPath: string;
  readonly logRoot: string;
  readonly commitAuthor: CommitAuthor;
  readonly pid: number;
  readonly quotaCooldownMinutes: number;
  readonly maxRunsPerNight: number;
  readonly nightWindow: NightWindow;
  readonly lock: RunLock;
  readonly isProcessAlive: (pid: number) => boolean;
  /** Builds the runtime from the policy read at `origin/main` (its operation classes gate the managed settings). */
  readonly runtimeFor: (policy: Policy) => RuntimePort;
}

/** Executions started in the current night window; 0 outside every window (a manual daytime run). */
function startedInWindow(deps: RunCommandDeps): number {
  const start = currentWindowStart(deps.clock.now(), deps.nightWindow);
  if (start === null) return 0;
  const startIso = start.toISOString();
  return deps.store.listExecutions({}).filter((execution) => execution.startedAt >= startIso).length;
}

export async function runRun(args: readonly string[], deps: RunCommandDeps): Promise<number> {
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  if (!dryRun && args.length > 0) {
    deps.console.printError(RUN_USAGE);
    return 1;
  }
  if (dryRun) return runStages(deps, true);

  const taken = deps.lock.acquire();
  if (taken.kind === 'busy') {
    deps.console.print(messagesFor(deps.language)('run.busy', { pid: taken.pid }));
    return 0;
  }
  try {
    return await runStages(deps, false);
  } finally {
    deps.lock.release();
  }
}

async function runStages(deps: RunCommandDeps, dryRun: boolean): Promise<number> {
  const say = messagesFor(deps.language);
  const out = deps.console;

  if (dryRun) out.print(say('run.dryRun', {}));
  else await recoverInterrupted(deps, deps.isProcessAlive);

  const started = startedInWindow(deps);
  if (started >= deps.maxRunsPerNight) {
    out.print(say('run.nightLimitReached', { started, max: deps.maxRunsPerNight }));
    return 0;
  }

  const availability = await deps.sandbox.available();
  if (!availability.available) {
    out.printError(say('run.dockerUnavailable', { reason: availability.reason }));
    return 2;
  }

  try {
    out.print(say('run.syncing', {}));
    if (dryRun) return await dryRunSelection(deps);

    const synced = await sync(deps);
    out.print(say('run.syncDone', { projects: synced.registry.projects.length, pullRequests: synced.pullRequestsChecked }));
    for (const issue of synced.registry.issues) out.printError(`${issue.file}: ${issue.field} ${issue.message}`);
    for (const error of synced.errors) out.printError(`sync ${error.kind} ${error.subject}: ${error.message}`);

    const policy = await loadPolicy(deps.vcs, deps.rosterRepoPath);
    const runDeps: RunDeps = {
      vcs: deps.vcs,
      store: deps.store,
      clock: deps.clock,
      forge: deps.forge,
      sandbox: deps.sandbox,
      runtime: deps.runtimeFor(policy),
      fs: deps.fs,
      secrets: deps.secrets,
      console: deps.console,
      language: deps.language,
      rosterRepoPath: deps.rosterRepoPath,
      logRoot: deps.logRoot,
      commitAuthor: deps.commitAuthor,
      policy,
      pid: deps.pid,
      quotaCooldownMinutes: deps.quotaCooldownMinutes,
    };
    await runNext(runDeps, { projects: synced.registry.projects });
    return 0;
  } catch (error) {
    // A typed Roster error (network down, invalid policy, git failure) is a handled outcome; anything
    // else is a bug and reaches the caller, which exits non-zero.
    if (!(error instanceof RosterError)) throw error;
    out.printError(describeError(error));
    return 0;
  }
}

/** Dry-run: fetch, refresh the registration cache, select the unit, print the plan. */
async function dryRunSelection(deps: RunCommandDeps): Promise<number> {
  const say = messagesFor(deps.language);
  const { vcs, store, forge, console: out } = deps;

  await vcs.fetch(deps.rosterRepoPath);
  const registry = await readProjects(deps);
  for (const loaded of registry.projects) {
    if (loaded.isRosterRepo) continue;
    try {
      await vcs.fetch(loaded.project.repoPath);
    } catch (error) {
      out.printError(`sync fetch ${loaded.project.name}: ${describeError(error)}`);
    }
  }
  for (const issue of registry.issues) out.printError(`${issue.file}: ${issue.field} ${issue.message}`);

  // Merged PRs are read, not applied.
  const merged = new Set<string>();
  let checked = 0;
  for (const task of store.listTasks()) {
    if (task.status !== 'in_review' || task.prNumber === null) continue;
    const feature = store.getFeature(task.featureId);
    const project = feature === undefined ? undefined : store.getProject(feature.project);
    if (project === undefined) continue;
    try {
      const pr = await forge.prState(project.ownerRepo, task.prNumber);
      checked += 1;
      if (pr.state === 'merged') merged.add(task.id);
    } catch (error) {
      out.printError(`sync pr ${task.id}: ${describeError(error)}`);
    }
  }
  out.print(say('run.syncDone', { projects: registry.projects.length, pullRequests: checked }));

  const registered = new Set(registry.projects.map((loaded: LoadedProject) => loaded.project.name));
  const features = store.listFeatures().filter((feature) => registered.has(feature.project));
  const tasks = withDependencies(
    store.listTasks().map((task) => (merged.has(task.id) ? { ...task, status: 'done' as const } : task)),
    store.listTaskDependencies(),
  );
  const task = selectNext(features, tasks);
  if (task === null) {
    out.print(say('run.nothingToDo', {}));
    return 0;
  }
  out.print(say('run.selectedTask', { task: task.id, title: task.title }));
  out.print(say('run.dryRunPlan', { steps: PLANNED_STEPS }));
  return 0;
}
