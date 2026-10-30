// Fake StorePort: an in-memory store with the semantics documented on the port. Tests seed it through
// the port methods and then call `log.clear()`. `transaction` rolls every table back when `fn` throws.
// A scripted response replaces the in-memory behavior of one call; a scripted error makes it throw.

import type { ApprovalRequest, ApprovalResolution } from '../../src/core/domain/approval.ts';
import { NotFoundError } from '../../src/core/domain/errors.ts';
import type { Execution, ExecutionEvent, ExecutionStep } from '../../src/core/domain/execution.ts';
import type { Feature, FeatureEvent, GrillingEntry } from '../../src/core/domain/feature.ts';
import type { Project } from '../../src/core/domain/project.ts';
import type { RateLimitSnapshot, RuntimeState } from '../../src/core/domain/runtime.ts';
import type { Task, TaskDependency } from '../../src/core/domain/task.ts';
import type {
  ApprovalFilter,
  ExecutionFilter,
  ExecutionFinish,
  ExecutionPatch,
  FeatureTransition,
  LatestRateLimit,
  NewApprovalRequest,
  NewExecution,
  NewExecutionEvent,
  NewGrillingQuestion,
  StorePort,
  TaskFilter,
  TaskPatch,
} from '../../src/ports/store.ts';
import { CallLog, Responses } from './recorder.ts';

interface State {
  projects: Map<string, Project>;
  features: Map<string, Feature>;
  featureEvents: FeatureEvent[];
  grilling: GrillingEntry[];
  tasks: Map<string, Task>;
  dependencies: TaskDependency[];
  executions: Map<string, Execution>;
  steps: ExecutionStep[];
  events: ExecutionEvent[];
  approvals: ApprovalRequest[];
  runtimeStates: Map<string, RuntimeState>;
  sequence: number;
}

function emptyState(): State {
  return {
    projects: new Map(),
    features: new Map(),
    featureEvents: [],
    grilling: [],
    tasks: new Map(),
    dependencies: [],
    executions: new Map(),
    steps: [],
    events: [],
    approvals: [],
    runtimeStates: new Map(),
    sequence: 0,
  };
}

const copy = <T>(value: T): T => structuredClone(value);

/** `2026-11-01T03:00:00.000Z` -> `20261101030000` */
function compactTime(iso: string): string {
  return iso.replace(/\D/g, '').slice(0, 14);
}

export class FakeStore implements StorePort {
  readonly log: CallLog;
  readonly responses = new Responses<StorePort>();
  closed = false;
  #state: State = emptyState();

  constructor(log: CallLog = new CallLog()) {
    this.log = log;
  }

  #nextId(): number {
    this.#state.sequence += 1;
    return this.#state.sequence;
  }

  transaction<T>(fn: () => T): T {
    this.log.record('store', 'transaction', []);
    const before = structuredClone(this.#state);
    try {
      return fn();
    } catch (error) {
      this.#state = before;
      throw error;
    }
  }

  close(): void {
    this.log.record('store', 'close', []);
    this.responses.answer('close', [], () => {
      this.closed = true;
    });
  }

  // Projects

  upsertProject(project: Project): void {
    this.log.record('store', 'upsertProject', [project]);
    this.responses.answer('upsertProject', [project], () => {
      this.#state.projects.set(project.name, copy(project));
    });
  }

  getProject(name: string): Project | undefined {
    this.log.record('store', 'getProject', [name]);
    return this.responses.answer('getProject', [name], () => copy(this.#state.projects.get(name)));
  }

  listProjects(): readonly Project[] {
    this.log.record('store', 'listProjects', []);
    return this.responses.answer('listProjects', [], () =>
      copy([...this.#state.projects.values()].sort((a, b) => compare(a.name, b.name))),
    );
  }

  // Features

  createFeature(feature: Feature): void {
    this.log.record('store', 'createFeature', [feature]);
    this.responses.answer('createFeature', [feature], () => {
      if (this.#state.features.has(feature.id)) throw new Error(`FakeStore: feature ${feature.id} already exists`);
      this.#state.features.set(feature.id, copy(feature));
    });
  }

  getFeature(id: string): Feature | undefined {
    this.log.record('store', 'getFeature', [id]);
    return this.responses.answer('getFeature', [id], () => copy(this.#state.features.get(id)));
  }

  listFeatures(filter: { readonly project?: string } = {}): readonly Feature[] {
    this.log.record('store', 'listFeatures', [filter]);
    return this.responses.answer('listFeatures', [filter], () =>
      copy(
        [...this.#state.features.values()]
          .filter((feature) => filter.project === undefined || feature.project === filter.project)
          .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id)),
      ),
    );
  }

  applyFeatureTransition(transition: FeatureTransition): FeatureEvent {
    this.log.record('store', 'applyFeatureTransition', [transition]);
    return this.responses.answer('applyFeatureTransition', [transition], () => {
      const feature = this.#state.features.get(transition.featureId);
      if (feature === undefined) throw new NotFoundError('feature', transition.featureId);
      const event: FeatureEvent = {
        id: this.#nextId(),
        featureId: feature.id,
        fromStage: feature.stage,
        toStage: transition.toStage,
        step: transition.toStep,
        at: transition.at,
        prUrl: transition.prUrl ?? null,
        mergedAt: transition.mergedAt ?? null,
        evidenceCommit: transition.evidenceCommit ?? null,
        reason: transition.reason ?? null,
      };
      this.#state.features.set(feature.id, {
        ...feature,
        stage: transition.toStage,
        step: transition.toStep,
        updatedAt: transition.at,
      });
      this.#state.featureEvents.push(event);
      return copy(event);
    });
  }

  listFeatureEvents(featureId: string): readonly FeatureEvent[] {
    this.log.record('store', 'listFeatureEvents', [featureId]);
    return this.responses.answer('listFeatureEvents', [featureId], () =>
      copy(this.#state.featureEvents.filter((event) => event.featureId === featureId)),
    );
  }

  // Grilling

  addGrillingQuestion(question: NewGrillingQuestion): GrillingEntry {
    this.log.record('store', 'addGrillingQuestion', [question]);
    return this.responses.answer('addGrillingQuestion', [question], () => {
      const entry: GrillingEntry = { id: this.#nextId(), ...question, answerHuman: null, answeredAt: null };
      this.#state.grilling.push(entry);
      return copy(entry);
    });
  }

  answerGrillingQuestion(id: number, answerHuman: string, answeredAt: string): void {
    this.log.record('store', 'answerGrillingQuestion', [id, answerHuman, answeredAt]);
    this.responses.answer('answerGrillingQuestion', [id, answerHuman, answeredAt], () => {
      const index = this.#state.grilling.findIndex((entry) => entry.id === id);
      const entry = this.#state.grilling[index];
      if (entry === undefined) throw new NotFoundError('grilling question', String(id));
      this.#state.grilling[index] = { ...entry, answerHuman, answeredAt };
    });
  }

  listGrilling(featureId: string): readonly GrillingEntry[] {
    this.log.record('store', 'listGrilling', [featureId]);
    return this.responses.answer('listGrilling', [featureId], () =>
      copy(this.#state.grilling.filter((entry) => entry.featureId === featureId)),
    );
  }

  // Tasks

  importTasks(featureId: string, tasks: readonly Task[], dependencies: readonly TaskDependency[]): void {
    this.log.record('store', 'importTasks', [featureId, tasks, dependencies]);
    this.responses.answer('importTasks', [featureId, tasks, dependencies], () => {
      const foreign = tasks.find((task) => task.featureId !== featureId);
      if (foreign !== undefined) throw new Error(`FakeStore: task ${foreign.id} is not in feature ${featureId}`);
      const next = new Map(this.#state.tasks);
      for (const task of tasks) next.set(task.id, copy(task));
      const inFeature = (id: string): boolean => next.get(id)?.featureId === featureId;
      for (const edge of dependencies) {
        if (!inFeature(edge.taskId) || !next.has(edge.dependsOnId)) {
          throw new Error(`FakeStore: dependency ${edge.taskId} -> ${edge.dependsOnId} names an unknown task`);
        }
      }
      this.#state.tasks = next;
      this.#state.dependencies = [
        ...this.#state.dependencies.filter((edge) => !inFeature(edge.taskId)),
        ...copy([...dependencies]),
      ];
    });
  }

  getTask(id: string): Task | undefined {
    this.log.record('store', 'getTask', [id]);
    return this.responses.answer('getTask', [id], () => copy(this.#state.tasks.get(id)));
  }

  listTasks(filter: TaskFilter = {}): readonly Task[] {
    this.log.record('store', 'listTasks', [filter]);
    return this.responses.answer('listTasks', [filter], () => {
      const featureOrder = (task: Task): string => this.#state.features.get(task.featureId)?.createdAt ?? '';
      return copy(
        [...this.#state.tasks.values()]
          .filter((task) => filter.featureId === undefined || task.featureId === filter.featureId)
          .filter((task) => filter.status === undefined || task.status === filter.status)
          .filter((task) => filter.project === undefined || this.#projectOf(task.featureId) === filter.project)
          .sort(
            (a, b) =>
              compare(featureOrder(a), featureOrder(b)) || compare(a.featureId, b.featureId) || a.ord - b.ord,
          ),
      );
    });
  }

  updateTask(id: string, patch: TaskPatch): Task {
    this.log.record('store', 'updateTask', [id, patch]);
    return this.responses.answer('updateTask', [id, patch], () => {
      const task = this.#state.tasks.get(id);
      if (task === undefined) throw new NotFoundError('task', id);
      const updated: Task = { ...task, ...copy(patch) };
      this.#state.tasks.set(id, updated);
      return copy(updated);
    });
  }

  listTaskDependencies(featureId?: string): readonly TaskDependency[] {
    this.log.record('store', 'listTaskDependencies', [featureId]);
    return this.responses.answer('listTaskDependencies', [featureId], () =>
      copy(
        this.#state.dependencies.filter(
          (edge) => featureId === undefined || this.#state.tasks.get(edge.taskId)?.featureId === featureId,
        ),
      ),
    );
  }

  // Executions

  startExecution(execution: NewExecution): Execution {
    this.log.record('store', 'startExecution', [execution]);
    return this.responses.answer('startExecution', [execution], () => {
      const id = `${compactTime(execution.startedAt)}-${this.#nextId().toString(16).padStart(6, '0')}`;
      const row: Execution = {
        id,
        ...execution,
        status: 'running',
        endedAt: null,
        baseCommit: null,
        headCommit: null,
        branch: null,
        prUrl: null,
        logDir: null,
        containerName: null,
        resultJson: null,
        reason: null,
        stopRequestedAt: null,
        rateLimit: null,
      };
      this.#state.executions.set(id, row);
      return copy(row);
    });
  }

  getExecution(id: string): Execution | undefined {
    this.log.record('store', 'getExecution', [id]);
    return this.responses.answer('getExecution', [id], () => copy(this.#state.executions.get(id)));
  }

  updateExecution(id: string, patch: ExecutionPatch): Execution {
    this.log.record('store', 'updateExecution', [id, patch]);
    return this.responses.answer('updateExecution', [id, patch], () => this.#patchExecution(id, copy(patch)));
  }

  finishExecution(id: string, finish: ExecutionFinish): Execution {
    this.log.record('store', 'finishExecution', [id, finish]);
    return this.responses.answer('finishExecution', [id, finish], () => {
      const current = this.#state.executions.get(id);
      if (current === undefined) throw new NotFoundError('execution', id);
      return this.#patchExecution(id, {
        status: finish.status,
        endedAt: finish.endedAt,
        reason: finish.reason ?? current.reason,
        headCommit: finish.headCommit ?? current.headCommit,
        prUrl: finish.prUrl ?? current.prUrl,
      });
    });
  }

  listExecutions(filter: ExecutionFilter = {}): readonly Execution[] {
    this.log.record('store', 'listExecutions', [filter]);
    return this.responses.answer('listExecutions', [filter], () => {
      const rows = [...this.#state.executions.values()]
        .filter((row) => filter.status === undefined || row.status === filter.status)
        .filter((row) => filter.featureId === undefined || row.featureId === filter.featureId)
        .filter((row) => filter.taskId === undefined || row.taskId === filter.taskId)
        .filter((row) => filter.project === undefined || this.#projectOf(row.featureId) === filter.project)
        .sort((a, b) => compare(b.startedAt, a.startedAt) || compare(b.id, a.id));
      return copy(filter.limit === undefined ? rows : rows.slice(0, filter.limit));
    });
  }

  countExecutionsStarted(from: string, to: string): number {
    this.log.record('store', 'countExecutionsStarted', [from, to]);
    return this.responses.answer('countExecutionsStarted', [from, to], () => {
      const start = Date.parse(from);
      const end = Date.parse(to);
      return [...this.#state.executions.values()].filter((row) => {
        const at = Date.parse(row.startedAt);
        return at >= start && at < end;
      }).length;
    });
  }

  recordStep(step: ExecutionStep): void {
    this.log.record('store', 'recordStep', [step]);
    this.responses.answer('recordStep', [step], () => {
      if (!this.#state.executions.has(step.executionId)) throw new NotFoundError('execution', step.executionId);
      const index = this.#state.steps.findIndex(
        (row) => row.executionId === step.executionId && row.step === step.step,
      );
      if (index === -1) this.#state.steps.push(copy(step));
      else this.#state.steps[index] = copy(step);
    });
  }

  listSteps(executionId: string): readonly ExecutionStep[] {
    this.log.record('store', 'listSteps', [executionId]);
    return this.responses.answer('listSteps', [executionId], () =>
      copy(this.#state.steps.filter((row) => row.executionId === executionId)),
    );
  }

  appendEvent(event: NewExecutionEvent): ExecutionEvent {
    this.log.record('store', 'appendEvent', [event]);
    return this.responses.answer('appendEvent', [event], () => {
      if (!this.#state.executions.has(event.executionId)) throw new NotFoundError('execution', event.executionId);
      const row: ExecutionEvent = { id: this.#nextId(), ...copy(event) };
      this.#state.events.push(row);
      return copy(row);
    });
  }

  listEvents(executionId: string): readonly ExecutionEvent[] {
    this.log.record('store', 'listEvents', [executionId]);
    return this.responses.answer('listEvents', [executionId], () =>
      copy(this.#state.events.filter((row) => row.executionId === executionId)),
    );
  }

  recordRateLimit(executionId: string, snapshot: RateLimitSnapshot): void {
    this.log.record('store', 'recordRateLimit', [executionId, snapshot]);
    this.responses.answer('recordRateLimit', [executionId, snapshot], () => {
      const current = this.#state.executions.get(executionId);
      if (current === undefined) throw new NotFoundError('execution', executionId);
      this.#state.executions.set(executionId, { ...current, rateLimit: copy(snapshot) });
    });
  }

  latestRateLimit(runtime: string): LatestRateLimit | undefined {
    this.log.record('store', 'latestRateLimit', [runtime]);
    return this.responses.answer('latestRateLimit', [runtime], () => {
      let latest: LatestRateLimit | undefined;
      for (const row of this.#state.executions.values()) {
        if (row.runtime !== runtime || row.rateLimit === null) continue;
        if (latest === undefined || Date.parse(row.rateLimit.observedAt) > Date.parse(latest.snapshot.observedAt)) {
          latest = { executionId: row.id, snapshot: row.rateLimit };
        }
      }
      return copy(latest);
    });
  }

  // Approvals

  requestApproval(request: NewApprovalRequest): ApprovalRequest {
    this.log.record('store', 'requestApproval', [request]);
    return this.responses.answer('requestApproval', [request], () => {
      const row: ApprovalRequest = { id: this.#nextId(), ...copy(request), resolvedAt: null, resolution: null };
      this.#state.approvals.push(row);
      return copy(row);
    });
  }

  resolveApproval(id: number, resolution: ApprovalResolution, resolvedAt: string): ApprovalRequest {
    this.log.record('store', 'resolveApproval', [id, resolution, resolvedAt]);
    return this.responses.answer('resolveApproval', [id, resolution, resolvedAt], () => {
      const index = this.#state.approvals.findIndex((row) => row.id === id);
      const row = this.#state.approvals[index];
      if (row === undefined) throw new NotFoundError('approval request', String(id));
      const updated: ApprovalRequest = { ...row, resolution, resolvedAt };
      this.#state.approvals[index] = updated;
      return copy(updated);
    });
  }

  listApprovals(filter: ApprovalFilter = {}): readonly ApprovalRequest[] {
    this.log.record('store', 'listApprovals', [filter]);
    return this.responses.answer('listApprovals', [filter], () =>
      copy(
        this.#state.approvals
          .filter((row) => filter.taskId === undefined || row.taskId === filter.taskId)
          .filter((row) => filter.kind === undefined || row.kind === filter.kind)
          .filter((row) => filter.pending === undefined || (row.resolvedAt === null) === filter.pending),
      ),
    );
  }

  // Runtime state

  getRuntimeState(runtime: string): RuntimeState | undefined {
    this.log.record('store', 'getRuntimeState', [runtime]);
    return this.responses.answer('getRuntimeState', [runtime], () => copy(this.#state.runtimeStates.get(runtime)));
  }

  setRuntimeState(state: RuntimeState): void {
    this.log.record('store', 'setRuntimeState', [state]);
    this.responses.answer('setRuntimeState', [state], () => {
      this.#state.runtimeStates.set(state.runtime, copy(state));
    });
  }

  listRuntimeStates(): readonly RuntimeState[] {
    this.log.record('store', 'listRuntimeStates', []);
    return this.responses.answer('listRuntimeStates', [], () =>
      copy([...this.#state.runtimeStates.values()].sort((a, b) => compare(a.runtime, b.runtime))),
    );
  }

  #patchExecution(id: string, patch: Partial<Execution>): Execution {
    const current = this.#state.executions.get(id);
    if (current === undefined) throw new NotFoundError('execution', id);
    const updated: Execution = { ...current, ...patch };
    this.#state.executions.set(id, updated);
    return copy(updated);
  }

  #projectOf(featureId: string): string {
    return this.#state.features.get(featureId)?.project ?? featureId.split(':')[0] ?? '';
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
