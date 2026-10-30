// SandboxPort (ADR 0023, plan 002 section 9): runs one job container with the isolation of its
// profile. The Docker adapter keeps the flags in the protected `isolation.ts`.

import type { JobProfile } from '../core/domain/execution.ts';
import type { ContainerExit, ContainerInvocation, WorkspacePaths } from '../core/domain/runtime.ts';

/** Container resource limits, from the policy (ADR 0024). */
export interface ContainerLimits {
  /** Docker memory value, for example `4g`. */
  readonly memory: string;
  readonly cpus: number;
  readonly pids: number;
}

export interface SandboxRunRequest {
  readonly executionId: string;
  /** Container name suffix: the container is `roster-<execution-id>-<job>`. */
  readonly job: string;
  readonly profile: JobProfile;
  readonly invocation: ContainerInvocation;
  /** Mount sources; which ones are mounted, and how, depends on the profile. */
  readonly workspace: WorkspacePaths;
  /** stdout and stderr are streamed here, with secret values redacted. */
  readonly logPath: string;
  readonly timeoutMs: number;
  readonly limits: ContainerLimits;
  /** `host` names the egress proxy allows on port 443; ignored for `verify` (no network). */
  readonly egressHosts: readonly string[];
  /**
   * Values for the names in `invocation.env`. They reach only the environment of the `docker`
   * child process and never appear in an argument, a log line or an error.
   */
  readonly envValues: Readonly<Record<string, string>>;
}

export type SandboxAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

export interface SandboxPort {
  /** `docker info` with a 20 s timeout. */
  available(): Promise<SandboxAvailability>;
  /**
   * Creates the per-execution network and egress proxy when the profile has network, runs the job
   * container, kills it at the timeout, and removes network and proxy at the end, also on errors.
   */
  run(request: SandboxRunRequest): Promise<ContainerExit>;
  /** Kills every container named `roster-<execution-id>-*` and removes the execution's network. */
  kill(executionId: string): Promise<void>;
}
