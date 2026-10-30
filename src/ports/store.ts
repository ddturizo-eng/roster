// StorePort (plan 002 section 5, ADR 0018): Roster's local store of progress. The SQLite adapter
// (`node:sqlite`, synchronous) implements it. Times are ISO 8601 UTC strings. Methods return copies;
// changing a returned object never changes the store.

import type { ApprovalDetail, ApprovalKind, ApprovalRequest, ApprovalResolution } from '../core/domain/approval.ts';
import type {
  Execution,
  ExecutionEvent,
  ExecutionStatus,
  ExecutionStep,
  JobKind,
} from '../core/domain/execution.ts';
import type { Feature, FeatureEvent, GrillingEntry, Stage, Step } from '../core/domain/feature.ts';
import type { Project } from '../core/domain/project.ts';
import type { RateLimitSnapshot, RuntimeState } from '../core/domain/runtime.ts';
import type { Task, TaskDependency, TaskStatus } from '../core/domain/task.ts';

/** A stage or step change of a feature and the evidence of ADR 0020. */
export interface FeatureTransition {
  readonly featureId: string;
  readonly toStage: Stage;
  readonly toStep: Step;
  readonly at: string;
  readonly prUrl?: string;
  readonly mergedAt?: string;
  readonly evidenceCommit?: string;
  readonly reason?: string;
}

export interface NewGrillingQuestion {
  readonly featureId: string;
  readonly round: number;
  readonly questionHuman: string;
  readonly questionEn: string;
  readonly askedAt: string;
}

export interface TaskFilter {
  readonly featureId?: string;
  readonly project?: string;
  readonly status?: TaskStatus;
}

/** Mutable task columns. Fields left out are unchanged; `null` clears a column. */
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'status'
    | 'agentSlug'
    | 'branch'
    | 'prNumber'
    | 'prUrl'
    | 'mergedAt'
    | 'stopReason'
    | 'retryNote'
    | 'title'
    | 'bodyMd'
    | 'needsHuman'
    | 'profile'
    | 'ord'
    | 'sourceCommit'
  >
> & { readonly updatedAt: string };

/** A new execution; it starts with status `running`. */
export interface NewExecution {
  readonly taskId: string | null;
  readonly featureId: string;
  readonly jobKind: JobKind;
  readonly agentSlug: string | null;
  readonly runtime: string | null;
  readonly startedAt: string;
  readonly pid: number | null;
}

/** Mutable execution columns. Fields left out are unchanged; `null` clears a column. */
export type ExecutionPatch = Partial<
  Pick<
    Execution,
    | 'agentSlug'
    | 'runtime'
    | 'baseCommit'
    | 'headCommit'
    | 'branch'
    | 'prUrl'
    | 'logDir'
    | 'containerName'
    | 'resultJson'
    | 'reason'
    | 'stopRequestedAt'
    | 'pid'
  >
>;

/** Final columns of an execution. `status` must not be `running`. */
export interface ExecutionFinish {
  readonly status: Exclude<ExecutionStatus, 'running'>;
  readonly endedAt: string;
  readonly reason?: string;
  readonly headCommit?: string;
  readonly prUrl?: string;
}

export interface ExecutionFilter {
  readonly status?: ExecutionStatus;
  readonly featureId?: string;
  readonly taskId?: string;
  readonly project?: string;
  /** Newest first; at most this many. */
  readonly limit?: number;
}

export interface NewExecutionEvent {
  readonly executionId: string;
  readonly at: string;
  readonly type: string;
  /** Stored as `payload_json`. */
  readonly payload: unknown;
}

export interface NewApprovalRequest {
  readonly taskId: string;
  readonly kind: ApprovalKind;
  readonly detail: ApprovalDetail;
  readonly contentHash: string | null;
  readonly createdAt: string;
}

export interface ApprovalFilter {
  readonly taskId?: string;
  readonly kind?: ApprovalKind;
  /** true: only unresolved; false: only resolved; absent: both. */
  readonly pending?: boolean;
}

export interface LatestRateLimit {
  readonly executionId: string;
  readonly snapshot: RateLimitSnapshot;
}

export interface StorePort {
  /** Runs `fn` in one transaction: every write inside it happens, or none. */
  transaction<T>(fn: () => T): T;
  close(): void;

  // Projects (cache of `projects/<name>.json` on `origin/main`).
  upsertProject(project: Project): void;
  getProject(name: string): Project | undefined;
  listProjects(): readonly Project[];

  // Features and their events (ADR 0020).
  createFeature(feature: Feature): void;
  getFeature(id: string): Feature | undefined;
  /** Oldest first (`created_at`, then id). */
  listFeatures(filter?: { readonly project?: string }): readonly Feature[];
  /** Sets stage, step and `updated_at`, and appends a `feature_events` row, atomically. */
  applyFeatureTransition(transition: FeatureTransition): FeatureEvent;
  /** In insertion order. */
  listFeatureEvents(featureId: string): readonly FeatureEvent[];

  // Grilling questions and answers.
  addGrillingQuestion(question: NewGrillingQuestion): GrillingEntry;
  answerGrillingQuestion(id: number, answerHuman: string, answeredAt: string): void;
  /** In insertion order. */
  listGrilling(featureId: string): readonly GrillingEntry[];

  // Tasks and the DAG (ADR 0019).
  /**
   * Atomically upserts every given task of the feature by id and replaces the dependency edges of the
   * feature's tasks with `dependencies`. Writes everything or nothing.
   */
  importTasks(featureId: string, tasks: readonly Task[], dependencies: readonly TaskDependency[]): void;
  getTask(id: string): Task | undefined;
  /** Ordered by feature (oldest first), then `ord`. */
  listTasks(filter?: TaskFilter): readonly Task[];
  /** Throws NotFoundError when the task does not exist. */
  updateTask(id: string, patch: TaskPatch): Task;
  listTaskDependencies(featureId?: string): readonly TaskDependency[];

  // Executions, steps and events.
  /** Creates the execution with a new id `<yyyymmddhhmmss>-<6 hex>` from `startedAt`. */
  startExecution(execution: NewExecution): Execution;
  getExecution(id: string): Execution | undefined;
  /** Throws NotFoundError when the execution does not exist. */
  updateExecution(id: string, patch: ExecutionPatch): Execution;
  /** Throws NotFoundError when the execution does not exist. */
  finishExecution(id: string, finish: ExecutionFinish): Execution;
  /** Newest first. */
  listExecutions(filter?: ExecutionFilter): readonly Execution[];
  /** Executions with `from <= started_at < to`. */
  countExecutionsStarted(from: string, to: string): number;
  /** Inserts or replaces the row of `(executionId, step)`. */
  recordStep(step: ExecutionStep): void;
  /** In insertion order. */
  listSteps(executionId: string): readonly ExecutionStep[];
  appendEvent(event: NewExecutionEvent): ExecutionEvent;
  /** In insertion order. */
  listEvents(executionId: string): readonly ExecutionEvent[];
  /** Overwrites the execution's previous snapshot (ADR 0030). */
  recordRateLimit(executionId: string, snapshot: RateLimitSnapshot): void;
  /** The most recently observed snapshot of an execution that used `runtime`, or undefined. */
  latestRateLimit(runtime: string): LatestRateLimit | undefined;

  // Approval requests (ADR 0024, ADR 0025).
  requestApproval(request: NewApprovalRequest): ApprovalRequest;
  /** Throws NotFoundError when the request does not exist. */
  resolveApproval(id: number, resolution: ApprovalResolution, resolvedAt: string): ApprovalRequest;
  /** In insertion order. */
  listApprovals(filter?: ApprovalFilter): readonly ApprovalRequest[];

  // Runtime cooldowns (ADR 0028, ADR 0030).
  getRuntimeState(runtime: string): RuntimeState | undefined;
  /** Inserts or replaces the runtime's row. */
  setRuntimeState(state: RuntimeState): void;
  listRuntimeStates(): readonly RuntimeState[];
}
