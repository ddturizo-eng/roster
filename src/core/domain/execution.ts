// Executions, their steps and events (plan 002 sections 5 and 8), job kinds (ADR 0024) and job
// profiles (plan 002 section 9.2).

import type { RateLimitSnapshot } from './runtime.ts';

/** Job kinds of ADR 0024; each has its own allowed paths. */
export const JOB_KINDS = ['specialist', 'analyst', 'architect', 'hr-director', 'reviewer'] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/** Container profiles of plan 002 section 9.2. */
export const JOB_PROFILES = ['agent', 'review', 'setup', 'verify'] as const;

export type JobProfile = (typeof JOB_PROFILES)[number];

export const EXECUTION_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'blocked',
  'quota_exhausted',
  'stopped',
  'interrupted',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Pipeline steps recorded in `execution_steps` (plan 002 section 5). */
export const EXECUTION_STEP_NAMES = [
  'workspace',
  'setup',
  'agent',
  'policy',
  'commit',
  'verify',
  'review',
  'push',
  'pr',
] as const;

export type ExecutionStepName = (typeof EXECUTION_STEP_NAMES)[number];

export const EXECUTION_STEP_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;

export type ExecutionStepStatus = (typeof EXECUTION_STEP_STATUSES)[number];

/** Row of the `executions` table. */
export interface Execution {
  /** `<yyyymmddhhmmss>-<6 hex>` */
  readonly id: string;
  /** Null for stage jobs (analyst, architect). */
  readonly taskId: string | null;
  readonly featureId: string;
  readonly jobKind: JobKind;
  readonly agentSlug: string | null;
  readonly runtime: string | null;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly logDir: string | null;
  readonly containerName: string | null;
  /** The validated result file, as JSON text. */
  readonly resultJson: string | null;
  readonly reason: string | null;
  readonly stopRequestedAt: string | null;
  readonly pid: number | null;
  /** Latest snapshot of any runtime job of the execution (ADR 0030); null when none was seen. */
  readonly rateLimit: RateLimitSnapshot | null;
}

/** Row of the `execution_steps` table: one per pipeline step. */
export interface ExecutionStep {
  readonly executionId: string;
  readonly step: ExecutionStepName;
  readonly status: ExecutionStepStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly detail: string | null;
}

/** Row of the `execution_events` table: key events; the full stream is in the log file. */
export interface ExecutionEvent {
  readonly id: number;
  readonly executionId: string;
  readonly at: string;
  /** For example `outcome`, `egress_denied`, `policy_violation`. */
  readonly type: string;
  /** Parsed `payload_json`. */
  readonly payload: unknown;
}
