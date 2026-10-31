// Runtime and container types shared by RuntimePort and SandboxPort (ADR 0022, ADR 0023, ADR 0030).

import type { AgentDefinition } from './agent.ts';
import type { JobKind, JobProfile } from './execution.ts';

/** One rate-limit window as reported by the runtime. */
export interface RateLimitWindow {
  /** Reported fraction: 0.6 means 60 %. */
  readonly utilization?: number;
  /** ISO 8601 UTC. */
  readonly resetsAt?: string;
}

/**
 * The last rate-limit report of a runtime job (ADR 0030). Every field except `observedAt` is
 * optional: the adapter leaves out what is missing or malformed.
 */
export interface RateLimitSnapshot {
  /** For example `allowed`. */
  readonly status?: string;
  /** For example `five_hour`. */
  readonly limitType?: string;
  readonly fiveHour?: RateLimitWindow;
  readonly sevenDay?: RateLimitWindow;
  /** ISO 8601 UTC. */
  readonly observedAt: string;
}

export const RUNTIME_OUTCOME_KINDS = ['completed', 'quota_exhausted', 'timeout', 'error', 'stopped'] as const;

export type RuntimeOutcomeKind = (typeof RUNTIME_OUTCOME_KINDS)[number];

export interface RuntimeOutcomeDetail {
  /** Short English reason written by the adapter, for example `turn limit`. Never agent text. */
  readonly reason?: string;
  /** Last rate-limit snapshot of the job, whatever the outcome (ADR 0030). */
  readonly rateLimit?: RateLimitSnapshot;
  /** Only for `quota_exhausted`: ISO 8601 UTC reset time of the exhausted window (ADR 0030). */
  readonly quotaResetsAt?: string;
  /** Only for `quota_exhausted`: the window `quotaResetsAt` belongs to, for example `seven_day`. */
  readonly quotaWindow?: string;
}

export interface RuntimeOutcome {
  readonly kind: RuntimeOutcomeKind;
  readonly detail: RuntimeOutcomeDetail;
}

/** Limits of one job, already capped by the policy (T08 `limitsFor`). */
export interface JobLimits {
  readonly maxTurns: number;
  readonly timeoutMinutes: number;
}

/**
 * The text of one approved skill (ADR 0005, ADR 0021), resolved by the orchestrator from the pinned
 * install. Runtime adapters inline it into the agent's instructions (human decision on T16, option
 * 1): no skill directory is mounted and no skill script runs.
 */
export interface SkillText {
  /** The skill name as listed in the agent's `skills:`. */
  readonly name: string;
  /** The skill's `SKILL.md`, as read; adapters drop its frontmatter. */
  readonly content: string;
}

/** What a runtime adapter needs to describe one agent or review job (ADR 0022). */
export interface RuntimeJob {
  readonly executionId: string;
  readonly jobKind: JobKind;
  /** Runtime jobs use only the `agent` and `review` profiles. */
  readonly profile: Extract<JobProfile, 'agent' | 'review'>;
  readonly agent: AgentDefinition;
  /** Content of `/roster/in/prompt.md`. */
  readonly prompt: string;
  readonly limits: JobLimits;
  /**
   * Exactly one entry per name in `agent.skills`, and nothing else. Only skills `approved` in
   * `skills/registry.md` of the pinned install; empty when the agent lists none.
   */
  readonly skills: readonly SkillText[];
}

/** A file Roster writes into the job's `in` directory, mounted read-only at `/roster/in`. */
export interface InFile {
  /** File name relative to `/roster/in`, for example `prompt.md`. */
  readonly name: string;
  readonly content: string;
}

/** The description of one container run (ADR 0022): built by a runtime adapter or by the orchestrator. */
export interface ContainerInvocation {
  readonly image: string;
  /** Command and arguments run inside the container. */
  readonly argv: readonly string[];
  /** Names of the environment variables passed to the container; values never appear here. */
  readonly env: readonly string[];
  readonly inFiles: readonly InFile[];
  /** Name of an `inFiles` entry piped to the process's stdin (spike finding 1). */
  readonly stdinFile?: string;
}

/** How a container run ended, as reported by SandboxPort. */
export interface ContainerExit {
  /** Null when the process was killed before it exited. */
  readonly exitCode: number | null;
  /** True when the sandbox killed the container at its timeout. */
  readonly timedOut: boolean;
  /** True when the container was killed by a stop request. */
  readonly stopped: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** Host paths of one execution's workspace (plan 002 section 4.5). */
export interface WorkspacePaths {
  /** `workspaces\<project>\<execution-id>` */
  readonly root: string;
  /** Separate git dir; never mounted. */
  readonly gitDir: string;
  /** Work tree mounted at `/workspace`; contains no `.git`. */
  readonly tree: string;
  /** Mounted read-only at `/roster/in`. */
  readonly inDir: string;
  /** Mounted at `/roster/out` for agent and review jobs. */
  readonly outDir: string;
}

export type CooldownSource = 'resets_at' | 'fallback';

/** Row of the `runtime_state` table (ADR 0028, ADR 0030). */
export interface RuntimeState {
  readonly runtime: string;
  readonly quotaExhaustedAt: string | null;
  readonly cooldownUntil: string | null;
  readonly cooldownSource: CooldownSource | null;
  /** For example `five_hour` or `seven_day`; null for the fallback. */
  readonly cooldownWindow: string | null;
}
