// Tasks and their states (ADR 0019, ADR 0020) as stored in the `tasks` and `task_dependencies`
// tables (plan 002 section 5). "Ready" is computed, never stored.

export const TASK_STATUSES = [
  'todo',
  'waiting_hire',
  'running',
  'in_review',
  'done',
  'blocked',
  'failed',
  'stopped',
  'rejected',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Row of the `tasks` table. */
export interface Task {
  /** `<project>:<NNN>-<Tnn>` */
  readonly id: string;
  readonly featureId: string;
  /** `Tnn` */
  readonly key: string;
  /** Position in `tasks.md`; selection follows it (ADR 0019). */
  readonly ord: number;
  readonly title: string;
  readonly status: TaskStatus;
  /** The `Needs human` reason; null when the task is not `needs-human`. */
  readonly needsHuman: string | null;
  readonly agentSlug: string | null;
  readonly profile: string | null;
  /** Full task text given to the agent, captured at import. */
  readonly bodyMd: string;
  readonly sourceCommit: string;
  readonly branch: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly mergedAt: string | null;
  readonly stopReason: string | null;
  readonly retryNote: string | null;
  readonly updatedAt: string;
}

/** Row of the `task_dependencies` table: `taskId` depends on `dependsOnId`. */
export interface TaskDependency {
  readonly taskId: string;
  readonly dependsOnId: string;
}
