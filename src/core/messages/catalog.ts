// Message keys and the parameters of each template (plan 002 sections 4.2, 7.4 and 8).
//
// Rules for every template, checked by test/core/messages:
// - Parameters carry ids, names, paths, counts, times and short English reasons. No parameter ever
//   carries a secret, and no parameter name refers to one (token, secret, password, credential).
// - Every string parameter is made safe before rendering (safe-text.ts); templates never read
//   anything but their parameters.
// - Times are passed already formatted by the caller (ISO 8601 or local time).

import type { ParamValue } from './safe-text.ts';

/** Parameters of every template, by message key. */
export interface MessageParams {
  // Stop reasons: why an execution or task stopped, stored with it and shown by status and run.

  /** The job's `result.json` is missing or does not match its contract (ADR 0026). */
  readonly 'stop.invalidResult': { readonly contract: string; readonly problems: readonly string[] };
  /** The agent finished without changing any file (plan 002 section 8, step 5). */
  readonly 'stop.noChanges': Record<string, never>;
  /** Changes touch protected or disallowed paths; the commit stays local (ADR 0024, 0025). */
  readonly 'stop.protectedPath': {
    readonly paths: readonly string[];
    readonly branch: string;
    readonly workspace: string;
  };
  /** Dependency manifests changed without an approval for their hash (ADR 0024). */
  readonly 'stop.dependencyApproval': {
    readonly manifests: readonly string[];
    readonly hash: string;
    readonly task: string;
  };
  /** A verify command failed; the branch is pushed without a PR (plan 002 section 17, answer 5). */
  readonly 'stop.verificationFailed': {
    readonly command: string;
    readonly exitCode: number | null;
    readonly branch: string;
    readonly tail: string;
  };
  /** A job reached its time limit. */
  readonly 'stop.timeout': { readonly job: string; readonly minutes: number };
  /** A job ended with an error; `reason` is the adapter's short English reason (e.g. `turn limit`). */
  readonly 'stop.error': { readonly job: string; readonly reason: string };
  /** The `roster run` process ended while the execution was running. */
  readonly 'stop.interrupted': Record<string, never>;
  /** The human stopped the execution with `roster stop`. */
  readonly 'stop.stopped': Record<string, never>;
  /** Docker is not reachable; `roster run` exits 2. `reason` is written by the adapter. */
  readonly 'stop.dockerUnavailable': { readonly reason: string };
  /** The runtime's quota is exhausted; WIP pushed, task back to `todo` (ADR 0028, ADR 0030). */
  readonly 'stop.quotaCooldown': {
    readonly runtime: string;
    readonly branch: string;
    readonly until: string;
    /** The exhausted window, for example `seven_day`; null when the fallback duration is used. */
    readonly window: string | null;
  };
  /** A hire PR for the task's agent is open; the task waits for it (ADR 0027). */
  readonly 'stop.hirePrOpened': { readonly agent: string; readonly prUrl: string };
  /** The task's PR was closed without merging; the task is `rejected` (plan 002 section 17, answer 6). */
  readonly 'stop.prClosedUnmerged': { readonly prUrl: string; readonly task: string };

  // Console lines of `roster run` (plan 002 section 7.4).

  readonly 'run.busy': { readonly pid: number };
  readonly 'run.recoveredInterrupted': { readonly executionId: string };
  readonly 'run.nightLimitReached': { readonly started: number; readonly max: number };
  readonly 'run.dockerUnavailable': { readonly reason: string };
  readonly 'run.syncing': Record<string, never>;
  readonly 'run.syncDone': { readonly projects: number; readonly pullRequests: number };
  readonly 'run.nothingToDo': Record<string, never>;
  readonly 'run.selectedTask': { readonly task: string; readonly title: string };
  readonly 'run.selectedStageJob': { readonly feature: string; readonly job: string };
  readonly 'run.hiring': { readonly task: string };
  readonly 'run.agentReused': { readonly agent: string; readonly task: string };
  readonly 'run.noRuntime': { readonly agent: string };
  readonly 'run.runtimeCooldown': { readonly runtime: string; readonly until: string };
  readonly 'run.executionStarted': {
    readonly executionId: string;
    readonly task: string;
    readonly agent: string;
    readonly runtime: string;
  };
  readonly 'run.resuming': { readonly branch: string };
  readonly 'run.stepStarted': { readonly step: string };
  readonly 'run.prOpened': { readonly prUrl: string };
  readonly 'run.executionFinished': { readonly executionId: string; readonly status: string };
  readonly 'run.stopReason': { readonly reason: string };
  readonly 'run.dryRun': Record<string, never>;
  readonly 'run.dryRunPlan': { readonly steps: readonly string[] };
}

export type MessageKey = keyof MessageParams;

/** One language's templates: a pure function per key, from safe parameters to text. */
export type Catalog = { readonly [K in MessageKey]: (params: MessageParams[K]) => string };

/** Compile-time check: every parameter of every template is a ParamValue. */
type OnlyParamValues<T extends { readonly [K in MessageKey]: Readonly<Record<string, ParamValue>> }> = T;
export type CheckedMessageParams = OnlyParamValues<MessageParams>;
