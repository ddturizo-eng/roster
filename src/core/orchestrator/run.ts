// Task pipeline, happy path (plan 002 sections 7.4 and 8, ADR 0019, ADR 0026, ADR 0028, ADR 0030,
// ADR 0032). `runNext` takes the registrations loaded by sync, picks the next ready task, and runs
// steps 1, 3, 4, 5, 6, 9, 10 and 11: workspace, agent job, result validation, policy check, commit,
// push, PR, record. Setup, verify and review come in T25, T26 and T36; hiring in T28; the capability
// router in T17 (until then the only runtime is the injected one, in quota cooldown or not).
//
// Lock, the night window, the Docker check and sync belong to the CLI (T22). Every stop path of
// plan 002 section 8 is finalized here (T21): the step that stopped is recorded as failed, then the
// execution, the task, the approval request and the runtime cooldown are written in one transaction
// and `runNext` returns the outcome (exit code 0). Nothing is pushed on any of them except the WIP
// push of `quota_exhausted` (ADR 0028), because the push step runs only after the result is valid and
// the policy check of the whole range `origin/<baseBranch>..HEAD` is clean. `recoverInterrupted`
// handles executions left `running` by a dead process at the start of a run.
//
// Every runtime job (agent now; review, hire and stage jobs later) goes through `runRuntimeJob`, which
// stores the rate-limit snapshot of the job on the execution right after `interpret`, whatever the
// outcome (ADR 0030).

import type { AgentDefinition } from '../domain/agent.ts';
import { RosterError } from '../domain/errors.ts';
import { taskBranch } from '../domain/branches.ts';
import type { NewApprovalRequest } from '../../ports/store.ts';
import type { Execution, ExecutionStepName, JobProfile } from '../domain/execution.ts';
import type { Feature } from '../domain/feature.ts';
import { SLUG_PATTERN } from '../domain/ids.ts';
import { parseResult } from '../domain/result-validators.ts';
import type { SpecialistResult } from '../domain/results.ts';
import type {
  ContainerExit,
  CooldownSource,
  RuntimeJob,
  RuntimeOutcome,
  RuntimeState,
  SkillText,
  WorkspacePaths,
} from '../domain/runtime.ts';
import type { Task, TaskStatus } from '../domain/task.ts';
import { parseAgentDefinition } from '../agents/parse.ts';
import { withDependencies, selectNext } from '../dag/select.ts';
import { messagesFor } from '../messages/format.ts';
import type { Messages } from '../messages/format.ts';
import type { Language } from '../messages/language.ts';
import { inlineText, redactTokens } from '../messages/safe-text.ts';
import { checkChanges, limitsFor } from '../policy/policy.ts';
import type { Policy } from '../policy/policy.ts';
import type { ClockPort } from '../../ports/clock.ts';
import type { ConsolePort } from '../../ports/console.ts';
import type { FileSystemPort } from '../../ports/file-system.ts';
import type { ForgePort } from '../../ports/forge.ts';
import type { RuntimePort } from '../../ports/runtime.ts';
import type { ContainerLimits, SandboxPort } from '../../ports/sandbox.ts';
import type { SecretName, SecretsPort } from '../../ports/secrets.ts';
import type { StorePort } from '../../ports/store.ts';
import type { CommitAuthor, GitWorkspace, VcsPort } from '../../ports/vcs.ts';
import { buildPrompt } from './prompt.ts';
import { projectPolicy } from './projects.ts';
import type { LoadedProject } from './projects.ts';

/** Ref of the Roster repo agents, skills and the registry are read from (plan 002 section 6). */
export const ROSTER_REF = 'origin/main';

/** Environment names a runtime may ask for, and the secret that fills each (ADR 0016, ADR 0029). */
const SECRET_ENV: Readonly<Record<string, SecretName>> = {
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-token',
};

const MAX_FREE_TEXT = 4000;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// C0 except tab, line feed and carriage return; DEL; C1.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export interface RunDeps {
  readonly vcs: VcsPort;
  readonly store: StorePort;
  readonly clock: ClockPort;
  readonly forge: ForgePort;
  readonly sandbox: SandboxPort;
  /** The only runtime of the skeleton (T17 replaces this with the router). */
  readonly runtime: RuntimePort;
  readonly fs: FileSystemPort;
  readonly secrets: SecretsPort;
  readonly console: ConsolePort;
  readonly language: Language;
  /** Local path of the Roster repo (`config.json`). */
  readonly rosterRepoPath: string;
  /** `%LOCALAPPDATA%\Roster\logs`; each execution logs under `<logRoot>\<execution-id>`. */
  readonly logRoot: string;
  /** Identity of the commits Roster makes (`config.json`). */
  readonly commitAuthor: CommitAuthor;
  /** Parsed `policies/*.json` of `origin/main`. */
  readonly policy: Policy;
  /** PID of the `roster run` process, stored on the execution for recovery. */
  readonly pid: number;
  /** `quotaCooldownMinutes` of `config.json`: the cooldown when the runtime reports no usable reset (ADR 0030). */
  readonly quotaCooldownMinutes: number;
}

export interface RunInput {
  /** Valid registrations read by this run's sync step. */
  readonly projects: readonly LoadedProject[];
}

export type RunOutcome =
  | { readonly kind: 'nothing_to_do' }
  /** The selected task has no usable approved agent; it is `blocked` (hiring replaces this in T28). */
  | { readonly kind: 'no_agent'; readonly taskId: string }
  /** The agent cannot run on the runtime. */
  | { readonly kind: 'no_runtime'; readonly taskId: string; readonly agent: string }
  | { readonly kind: 'quota_cooldown'; readonly taskId: string; readonly runtime: string; readonly until: string }
  | {
      readonly kind: 'pr_opened';
      readonly taskId: string;
      readonly executionId: string;
      readonly branch: string;
      readonly headCommit: string;
      readonly prNumber: number;
      readonly prUrl: string;
    }
  | RunOutcomeStopped;

/** Why a task stopped without a PR, for the outcomes that end blocked, failed or stopped. */
export type BlockedReason = 'agent_blocked' | 'protected_path' | 'dependencies';

export type RunOutcomeStopped =
  /** The agent returned `blocked` with questions, or a policy stop needs the human; task `blocked`. */
  | { readonly kind: 'blocked'; readonly taskId: string; readonly executionId: string; readonly reason: BlockedReason }
  /** Failure, timeout, error, missing or invalid result, no changes, or an exception; task `failed`. */
  | { readonly kind: 'failed'; readonly taskId: string; readonly executionId: string; readonly reason: string }
  /** The runtime job was stopped; task `stopped`. */
  | { readonly kind: 'stopped'; readonly taskId: string; readonly executionId: string }
  /** Quota exhausted (ADR 0028, ADR 0030); task back to `todo`. `pushed` is false when nothing was pushed. */
  | {
      readonly kind: 'quota_exhausted';
      readonly taskId: string;
      readonly executionId: string;
      readonly branch: string;
      readonly pushed: boolean;
      readonly cooldownUntil: string;
      readonly cooldownSource: CooldownSource;
      readonly cooldownWindow: string | null;
    };

/** What stopped the pipeline; thrown inside the pipeline and finalized by `runPipeline`. */
type StopInfo =
  | { readonly kind: 'agent_outcome'; readonly outcome: RuntimeOutcome; readonly timeoutMinutes: number }
  | { readonly kind: 'result_missing' }
  | { readonly kind: 'result_invalid'; readonly problems: readonly string[] }
  | { readonly kind: 'result_blocked'; readonly questions: readonly string[] }
  | { readonly kind: 'no_changes' }
  | { readonly kind: 'protected_path'; readonly paths: readonly string[]; readonly committed: boolean }
  | {
      readonly kind: 'dependency_manifests';
      readonly manifests: readonly string[];
      readonly hash: string;
      readonly committed: boolean;
    };

class StopSignal extends RosterError {
  override readonly name = 'StopSignal';
  readonly info: StopInfo;

  constructor(info: StopInfo) {
    super(`Pipeline stop: ${info.kind}`);
    this.info = info;
  }
}

/** The longest cooldown taken from a reported reset time (ADR 0030). */
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;

export interface Cooldown {
  readonly until: string;
  readonly source: CooldownSource;
  readonly window: string | null;
}

/**
 * Cooldown end after quota exhaustion (ADR 0030): the reported reset when it is later than `now` and
 * at most 8 days ahead (source `resets_at`, with its window); otherwise `now + fallbackMinutes`.
 */
export function cooldownFor(
  now: Date,
  detail: { readonly quotaResetsAt?: string; readonly quotaWindow?: string },
  fallbackMinutes: number,
): Cooldown {
  const reset = detail.quotaResetsAt === undefined ? Number.NaN : Date.parse(detail.quotaResetsAt);
  const t = now.getTime();
  if (Number.isFinite(reset) && reset > t && reset <= t + MAX_RESET_AHEAD_MS) {
    return { until: new Date(reset).toISOString(), source: 'resets_at', window: detail.quotaWindow ?? null };
  }
  return { until: new Date(t + fallbackMinutes * 60_000).toISOString(), source: 'fallback', window: null };
}

// ---------------------------------------------------------------------------------------------
// Runtime job helper (ADR 0030)

export interface RuntimeJobDeps {
  readonly store: StorePort;
  readonly sandbox: SandboxPort;
  readonly runtime: RuntimePort;
  readonly secrets: SecretsPort;
}

export interface RuntimeJobRequest {
  readonly executionId: string;
  /** Container name suffix and log file stem, for example `agent` or `review`. */
  readonly job: string;
  readonly profile: Extract<JobProfile, 'agent' | 'review'>;
  readonly runtimeJob: RuntimeJob;
  readonly workspace: WorkspacePaths;
  /** Absolute path of the job's stdout log (`<job>.jsonl`). */
  readonly logPath: string;
  readonly timeoutMs: number;
  readonly limits: ContainerLimits;
  readonly egressHosts: readonly string[];
}

export interface RuntimeJobResult {
  readonly exit: ContainerExit;
  readonly outcome: RuntimeOutcome;
}

/**
 * Builds the invocation, runs the container, interprets the exit and, right after `interpret` and
 * whatever the outcome, stores `detail.rateLimit` on the execution with `recordRateLimit`.
 */
export async function runRuntimeJob(deps: RuntimeJobDeps, request: RuntimeJobRequest): Promise<RuntimeJobResult> {
  const invocation = deps.runtime.buildInvocation(request.runtimeJob);
  const envValues: Record<string, string> = {};
  for (const name of invocation.env) {
    const secret = SECRET_ENV[name];
    if (secret !== undefined) envValues[name] = await deps.secrets.get(secret);
  }
  const exit = await deps.sandbox.run({
    executionId: request.executionId,
    job: request.job,
    profile: request.profile,
    invocation,
    workspace: request.workspace,
    logPath: request.logPath,
    timeoutMs: request.timeoutMs,
    limits: request.limits,
    egressHosts: request.egressHosts,
    envValues,
  });
  const outcome = deps.runtime.interpret(exit, request.logPath);
  if (outcome.detail.rateLimit !== undefined) deps.store.recordRateLimit(request.executionId, outcome.detail.rateLimit);
  return { exit, outcome };
}

// ---------------------------------------------------------------------------------------------
// Agent loading

/** Names of the skills with status `approved` in the table of `skills/registry.md`. */
export function approvedSkillNames(registryText: string): string[] {
  const names: string[] = [];
  let statusColumn = -1;
  for (const line of registryText.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells[0]?.toLowerCase() === 'skill') {
      statusColumn = cells.findIndex((cell) => cell.toLowerCase() === 'status');
      continue;
    }
    if (statusColumn < 0 || cells.length <= statusColumn || /^:?-{3,}:?$/.test(cells[0] ?? '')) continue;
    if (cells[statusColumn]?.toLowerCase() === 'approved' && cells[0] !== '') names.push(cells[0] as string);
  }
  return names;
}

interface LoadedAgent {
  readonly definition: AgentDefinition;
  readonly skills: readonly SkillText[];
}

/**
 * The approved agent `slug` from `origin/main` of the Roster repo (plan 002 section 6), or undefined
 * when the slug is unsafe, the file is missing or invalid, it does not use the `specialist` contract,
 * or one of its skills has no text. The slug is task text, so it is checked before it names a path.
 */
async function loadAgent(deps: RunDeps, rosterCommit: string, slug: string | null): Promise<LoadedAgent | undefined> {
  if (slug === null || !SLUG_PATTERN.test(slug)) return undefined;
  const text = await deps.vcs.showFile(deps.rosterRepoPath, rosterCommit, `agents/${slug}.md`);
  if (text === null) return undefined;
  const registry = await deps.vcs.showFile(deps.rosterRepoPath, rosterCommit, 'skills/registry.md');
  const parsed = parseAgentDefinition(text, { slug, approvedSkills: registry === null ? [] : approvedSkillNames(registry) });
  const definition = parsed.definition;
  if (definition === null || definition.contract !== 'specialist') return undefined;
  const skills: SkillText[] = [];
  for (const name of definition.skills) {
    if (!SKILL_NAME.test(name)) return undefined;
    const content = await deps.vcs.showFile(deps.rosterRepoPath, rosterCommit, `.claude/skills/${name}/SKILL.md`);
    if (content === null) return undefined;
    skills.push({ name, content });
  }
  return { definition, skills };
}

// ---------------------------------------------------------------------------------------------
// Pipeline

/** Free text from an agent result for a PR body: secrets redacted, control characters replaced, cut. */
function bodyText(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '(none)';
  const cleaned = redactTokens(value).replace(CONTROL, '�').replace(/\r\n?/g, '\n').trim();
  return cleaned.length <= MAX_FREE_TEXT ? cleaned : `${cleaned.slice(0, MAX_FREE_TEXT - 1)}…`;
}

function prBody(task: Task, executionId: string, result: SpecialistResult): string {
  return [
    `Task: ${task.id}`,
    `Execution: ${executionId}`,
    '',
    '## Summary',
    '',
    bodyText(result.summary),
    '',
    '## Agent verification',
    '',
    bodyText(result.verification),
    '',
    '## Notes',
    '',
    bodyText(result.notes),
    '',
  ].join('\n');
}

export async function runNext(deps: RunDeps, input: RunInput): Promise<RunOutcome> {
  const { store, clock, vcs } = deps;
  const say = messagesFor(deps.language);
  const out = deps.console;
  const nowIso = (): string => clock.now().toISOString();

  const loadedByName = new Map(input.projects.map((loaded) => [loaded.project.name, loaded] as const));
  const features = store.listFeatures().filter((feature) => loadedByName.has(feature.project));
  const tasks = withDependencies(store.listTasks(), store.listTaskDependencies());
  const task = selectNext(features, tasks);
  if (task === null) {
    out.print(say('run.nothingToDo', {}));
    return { kind: 'nothing_to_do' };
  }
  const feature = features.find((candidate) => candidate.id === task.featureId) as Feature;
  const loaded = loadedByName.get(feature.project) as LoadedProject;
  out.print(say('run.selectedTask', { task: task.id, title: task.title }));

  // Agent (hiring replaces the blocked path in T28).
  const rosterCommit = await vcs.resolveRef(deps.rosterRepoPath, ROSTER_REF);
  const agent = await loadAgent(deps, rosterCommit, task.agentSlug);
  if (agent === undefined) {
    const reason = say('stop.noAgent', {});
    store.updateTask(task.id, { status: 'blocked', stopReason: reason, updatedAt: nowIso() });
    out.print(say('run.stopReason', { reason }));
    return { kind: 'no_agent', taskId: task.id };
  }
  const { definition } = agent;

  // Runtime resolution of the skeleton (T17 replaces it).
  const { runtime } = deps;
  if (!definition.runtimes.includes(runtime.name) || !definition.capabilities.every((c) => runtime.capabilities.has(c))) {
    out.print(say('run.noRuntime', { agent: definition.name }));
    return { kind: 'no_runtime', taskId: task.id, agent: definition.name };
  }
  const cooldown = store.getRuntimeState(runtime.name);
  if (cooldown?.cooldownUntil != null && Date.parse(cooldown.cooldownUntil) > clock.now().getTime()) {
    out.print(say('run.runtimeCooldown', { runtime: runtime.name, until: cooldown.cooldownUntil }));
    return { kind: 'quota_cooldown', taskId: task.id, runtime: runtime.name, until: cooldown.cooldownUntil };
  }

  return runPipeline(deps, say, { task, feature, loaded, agent });
}

interface PipelineInput {
  readonly task: Task;
  readonly feature: Feature;
  readonly loaded: LoadedProject;
  readonly agent: LoadedAgent;
}

/** Lines present on only one side, as a small `-`/`+` diff (display data for the approval request). */
function lineDiff(path: string, before: string | null, after: string | undefined): string {
  const a = before === null ? [] : before.replace(/\r\n?/g, '\n').split('\n');
  const b = after === undefined ? [] : after.replace(/\r\n?/g, '\n').split('\n');
  const inB = new Set(b);
  const inA = new Set(a);
  const header = before === null ? `+++ ${path} (new)` : after === undefined ? `--- ${path} (removed)` : `*** ${path}`;
  return [header, ...a.filter((l) => !inB.has(l)).map((l) => `-${l}`), ...b.filter((l) => !inA.has(l)).map((l) => `+${l}`)].join('\n');
}

type PolicyStopInfo = Extract<StopInfo, { kind: 'protected_path' | 'dependency_manifests' }>;

async function runPipeline(deps: RunDeps, say: Messages, input: PipelineInput): Promise<RunOutcome> {
  const { store, clock, fs, secrets, forge } = deps;
  const { task, feature, loaded, agent } = input;
  const { runtime } = deps;
  const out = deps.console;
  const rules = loaded.registration;
  const nowIso = (): string => clock.now().toISOString();
  const branch = taskBranch(rules, feature.number, task.key);
  const range = `origin/${rules.baseBranch}`;
  const pair = `${feature.number}-${task.key}`;
  const commitTitle = `${pair}: ${inlineText(task.title, 200)}`;
  const policyOfProject = projectPolicy(deps.policy, loaded);

  // Start: execution and task state in one transaction (a task is `running` only with an execution).
  const startedAt = nowIso();
  const execution: Execution = store.transaction(() => {
    const started = store.startExecution({
      taskId: task.id,
      featureId: feature.id,
      jobKind: 'specialist',
      agentSlug: agent.definition.name,
      runtime: runtime.name,
      startedAt,
      pid: deps.pid,
    });
    store.updateTask(task.id, { status: 'running', branch, stopReason: null, updatedAt: startedAt });
    return started;
  });
  const executionId = execution.id;
  out.print(
    say('run.executionStarted', {
      executionId,
      task: task.id,
      agent: agent.definition.name,
      runtime: runtime.name,
    }),
  );
  const logDir = fs.join(deps.logRoot, executionId);
  store.updateExecution(executionId, { branch, logDir });

  let workspace: GitWorkspace | undefined;
  let currentStep: string = 'workspace';
  const commitMessage = `${commitTitle}\n\nAgent: ${agent.definition.name}\nExecution: ${executionId}\n`;

  const step = async <T>(name: ExecutionStepName, fn: () => Promise<T>): Promise<T> => {
    currentStep = name;
    const stepStart = nowIso();
    out.print(say('run.stepStarted', { step: name }));
    store.recordStep({ executionId, step: name, status: 'running', startedAt: stepStart, endedAt: null, detail: null });
    try {
      const value = await fn();
      store.recordStep({ executionId, step: name, status: 'succeeded', startedAt: stepStart, endedAt: nowIso(), detail: null });
      return value;
    } catch (error) {
      const detail = error instanceof Error ? error.name : 'Error';
      store.recordStep({ executionId, step: name, status: 'failed', startedAt: stepStart, endedAt: nowIso(), detail });
      throw error;
    }
  };

  // Policy evaluation of origin/<baseBranch>..HEAD. Returns the stop it implies, or undefined when clean.
  const evaluate = async (changed: readonly string[], committed: boolean): Promise<PolicyStopInfo | undefined> => {
    const ws = workspace as GitWorkspace;
    const check = checkChanges({ policy: deps.policy, jobKind: 'specialist', changedPaths: changed, projectPolicy: policyOfProject });
    if (check.protectedMatches.length > 0 || check.outsideAllowed.length > 0) {
      const paths = [...new Set([...check.protectedMatches.map((m) => m.path), ...check.outsideAllowed])];
      return { kind: 'protected_path', paths, committed };
    }
    if (check.changedManifests.length > 0) {
      const hash = await fs.hashFiles(ws.paths.tree, check.changedManifests);
      const approved = store
        .listApprovals({ taskId: task.id, kind: 'dependencies' })
        .some((request) => request.resolution === 'approved' && request.contentHash === hash);
      if (!approved) return { kind: 'dependency_manifests', manifests: check.changedManifests, hash, committed };
    }
    return undefined;
  };

  // Writes the end of the execution and the task in one transaction, then tells the human.
  const settle = (args: {
    readonly execution: 'failed' | 'blocked' | 'quota_exhausted' | 'stopped';
    readonly task: TaskStatus;
    readonly reason: string;
    readonly event: Record<string, unknown>;
    readonly headCommit?: string | undefined;
    readonly approval?: Omit<NewApprovalRequest, 'taskId' | 'createdAt'> | undefined;
    readonly runtimeState?: RuntimeState | undefined;
  }): void => {
    const at = nowIso();
    store.transaction(() => {
      if (args.approval !== undefined) store.requestApproval({ ...args.approval, taskId: task.id, createdAt: at });
      if (args.runtimeState !== undefined) store.setRuntimeState(args.runtimeState);
      store.updateTask(task.id, { status: args.task, stopReason: args.reason, updatedAt: at });
      store.finishExecution(executionId, {
        status: args.execution,
        endedAt: at,
        reason: args.reason,
        ...(args.headCommit === undefined ? {} : { headCommit: args.headCommit }),
      });
      store.appendEvent({ executionId, at, type: 'stop', payload: args.event });
    });
    out.print(say('run.stopReason', { reason: args.reason }));
    out.print(say('run.executionFinished', { executionId, status: args.execution }));
  };

  const failed = (reason: string, kind: string, headCommit?: string, runtimeState?: RuntimeState): RunOutcome => {
    settle({ execution: 'failed', task: 'failed', reason, event: { kind }, headCommit, runtimeState });
    return { kind: 'failed', taskId: task.id, executionId, reason };
  };

  // Protected path or dependency manifests: the commit stays local, the task is blocked, the human decides.
  const policyStop = async (info: PolicyStopInfo, runtimeState?: RuntimeState): Promise<RunOutcome> => {
    const ws = workspace as GitWorkspace;
    const made = info.committed ? null : await ws.commitAll(commitMessage, deps.commitAuthor);
    const headCommit = made ?? (await ws.headCommit());
    if (info.kind === 'protected_path') {
      const reason = say('stop.protectedPath', { paths: info.paths, branch, workspace: ws.paths.root });
      settle({
        execution: 'blocked',
        task: 'blocked',
        reason,
        event: { kind: 'protected_path', paths: info.paths },
        headCommit,
        approval: { kind: 'protected_path', detail: { kind: 'protected_path', paths: info.paths, branch }, contentHash: null },
        runtimeState,
      });
      return { kind: 'blocked', taskId: task.id, executionId, reason: 'protected_path' };
    }
    const diffs: string[] = [];
    for (const path of info.manifests) {
      const before = await ws.showFile(range, path);
      const after = await fs.readText(fs.join(ws.paths.tree, ...path.split('/')));
      diffs.push(lineDiff(path, before, after));
    }
    const diff = redactTokens(diffs.join('\n').replace(CONTROL, '�'));
    const reason = say('stop.dependencyApproval', { manifests: info.manifests, hash: info.hash, task: task.id });
    settle({
      execution: 'blocked',
      task: 'blocked',
      reason,
      event: { kind: 'dependency_manifests', manifests: info.manifests, hash: info.hash },
      headCommit,
      approval: {
        kind: 'dependencies',
        detail: {
          kind: 'dependencies',
          manifests: info.manifests,
          diff: diff.length <= MAX_FREE_TEXT ? diff : `${diff.slice(0, MAX_FREE_TEXT - 1)}…`,
        },
        contentHash: info.hash,
      },
      runtimeState,
    });
    return { kind: 'blocked', taskId: task.id, executionId, reason: 'dependencies' };
  };

  // ADR 0028 and ADR 0030: WIP commit and guarded push without a PR, task back to todo, runtime cooldown.
  const quotaStop = async (outcome: RuntimeOutcome): Promise<RunOutcome> => {
    const ws = workspace as GitWorkspace;
    const now = clock.now();
    const cooldown = cooldownFor(now, outcome.detail, deps.quotaCooldownMinutes);
    const runtimeState: RuntimeState = {
      runtime: runtime.name,
      quotaExhaustedAt: now.toISOString(),
      cooldownUntil: cooldown.until,
      cooldownSource: cooldown.source,
      cooldownWindow: cooldown.window,
    };
    let headCommit: string | undefined;
    let pushed = false;
    try {
      const changed = await ws.changedPaths(range);
      if (changed.length > 0) {
        const violation = await evaluate(changed, false);
        // The policy stop path replaces the push; the runtime is cooled down all the same.
        if (violation !== undefined) return await policyStop(violation, runtimeState);
        const message = `wip(${pair}): partial work, quota exhausted\n\nAgent: ${agent.definition.name}\nExecution: ${executionId}\n`;
        headCommit = await step('commit', async () => (await ws.commitAll(message, deps.commitAuthor)) ?? (await ws.headCommit()));
        await step('push', async () => {
          const token = await secrets.get('github-token');
          await ws.push(branch, token);
        });
        pushed = true;
      }
    } catch (error) {
      const reason = say('stop.error', { job: currentStep, reason: error instanceof Error ? error.name : 'Error' });
      return failed(reason, 'quota_wip_failed', headCommit, runtimeState);
    }
    const reason = say('stop.quotaCooldown', { runtime: runtime.name, branch, until: cooldown.until, window: cooldown.window });
    settle({
      execution: 'quota_exhausted',
      task: 'todo',
      reason,
      event: { kind: 'quota_exhausted', pushed, until: cooldown.until, source: cooldown.source, window: cooldown.window },
      headCommit,
      runtimeState,
    });
    return {
      kind: 'quota_exhausted',
      taskId: task.id,
      executionId,
      branch,
      pushed,
      cooldownUntil: cooldown.until,
      cooldownSource: cooldown.source,
      cooldownWindow: cooldown.window,
    };
  };

  const finalize = async (error: unknown): Promise<RunOutcome> => {
    if (!(error instanceof StopSignal)) {
      // Any other exception after the start: failed, with the error class only (messages may hold secrets).
      return failed(say('stop.error', { job: currentStep, reason: error instanceof Error ? error.name : 'Error' }), 'exception');
    }
    const info = error.info;
    switch (info.kind) {
      case 'agent_outcome': {
        const { outcome } = info;
        if (outcome.kind === 'quota_exhausted') return quotaStop(outcome);
        if (outcome.kind === 'stopped') {
          settle({ execution: 'stopped', task: 'stopped', reason: say('stop.stopped', {}), event: { kind: 'stopped' } });
          return { kind: 'stopped', taskId: task.id, executionId };
        }
        if (outcome.kind === 'timeout') {
          return failed(say('stop.timeout', { job: 'agent', minutes: info.timeoutMinutes }), 'timeout');
        }
        return failed(say('stop.error', { job: 'agent', reason: outcome.detail.reason ?? 'unknown' }), 'error');
      }
      case 'result_missing':
        return failed(say('stop.invalidResult', { contract: 'specialist', problems: ['out/result.json is missing'] }), 'result_missing');
      case 'result_invalid':
        return failed(say('stop.invalidResult', { contract: 'specialist', problems: info.problems }), 'result_invalid');
      case 'result_blocked': {
        const reason = say('stop.agentBlocked', { questions: info.questions });
        settle({ execution: 'blocked', task: 'blocked', reason, event: { kind: 'agent_blocked', questions: info.questions.length } });
        return { kind: 'blocked', taskId: task.id, executionId, reason: 'agent_blocked' };
      }
      case 'no_changes':
        return failed(say('stop.noChanges', {}), 'no_changes');
      case 'protected_path':
      case 'dependency_manifests':
        return policyStop(info);
    }
  };

  try {
    // Step 1: workspace.
    let resumed = false;
    await step('workspace', async () => {
      const created = await deps.vcs.createWorkspace(
        {
          name: loaded.project.name,
          repoPath: loaded.project.repoPath,
          remoteUrl: loaded.project.remoteUrl,
          baseBranch: rules.baseBranch,
          branchPrefix: rules.branchPrefix,
        },
        executionId,
      );
      workspace = created;
      resumed = (await created.prepareBranch(branch)).resumed;
      store.updateExecution(executionId, { baseCommit: await created.headCommit() });
    });
    const ws = workspace as unknown as GitWorkspace;
    if (resumed) out.print(say('run.resuming', { branch }));

    // Step 3: agent job.
    const limits = limitsFor(deps.policy, 'specialist', {
      ...(agent.definition.maxTurns === undefined ? {} : { maxTurns: agent.definition.maxTurns }),
      ...(agent.definition.timeoutMinutes === undefined ? {} : { timeoutMinutes: agent.definition.timeoutMinutes }),
    });
    const prompt = buildPrompt({
      taskId: task.id,
      title: task.title,
      bodyMd: task.bodyMd,
      featureDir: `${feature.number}-${feature.slug}`,
      resuming: resumed,
      retryNote: task.retryNote,
    });
    await step('agent', async () => {
      const { outcome } = await runRuntimeJob(deps, {
        executionId,
        job: 'agent',
        profile: 'agent',
        runtimeJob: {
          executionId,
          jobKind: 'specialist',
          profile: 'agent',
          agent: agent.definition,
          prompt,
          limits: { maxTurns: limits.maxTurns, timeoutMinutes: limits.timeoutMinutes },
          skills: agent.skills,
        },
        workspace: ws.paths,
        logPath: fs.join(logDir, 'agent.jsonl'),
        timeoutMs: limits.timeoutMinutes * 60_000,
        limits: { memory: limits.memory, cpus: limits.cpus, pids: limits.pids },
        egressHosts: deps.policy.providerHosts,
      });
      store.appendEvent({
        executionId,
        at: nowIso(),
        type: 'outcome',
        payload: { job: 'agent', kind: outcome.kind, ...(outcome.detail.reason === undefined ? {} : { reason: outcome.detail.reason }) },
      });
      if (outcome.kind !== 'completed') {
        throw new StopSignal({ kind: 'agent_outcome', outcome, timeoutMinutes: limits.timeoutMinutes });
      }
    });

    // Step 4: result.
    currentStep = 'result';
    const resultText = await fs.readText(fs.join(ws.paths.outDir, 'result.json'));
    if (resultText === undefined) throw new StopSignal({ kind: 'result_missing' });
    const parsed = parseResult('specialist', resultText);
    if (!parsed.ok) {
      throw new StopSignal({ kind: 'result_invalid', problems: parsed.errors.map((e) => `${e.path} ${e.message}`) });
    }
    const result = parsed.value;
    store.updateExecution(executionId, { resultJson: JSON.stringify(result) });
    if (result.status !== 'done') {
      throw new StopSignal({ kind: 'result_blocked', questions: (result.questions ?? []).map((q) => q.text) });
    }

    // Step 5: policy check of the work tree against the base branch.
    const checkRange = async (committed: boolean): Promise<void> => {
      const changed = await ws.changedPaths(range);
      if (changed.length === 0) throw new StopSignal({ kind: 'no_changes' });
      const violation = await evaluate(changed, committed);
      if (violation !== undefined) throw new StopSignal(violation);
    };
    await step('policy', () => checkRange(false));

    // Step 6: commit.
    const headCommit = await step('commit', async () => {
      const made = await ws.commitAll(commitMessage, deps.commitAuthor);
      return made ?? (await ws.headCommit());
    });

    // Step 9: policy check of the whole range (earlier resumed commits included), then push.
    await step('push', async () => {
      await checkRange(true);
      const token = await secrets.get('github-token');
      await ws.push(branch, token);
    });

    // Step 10: PR against the project's base branch.
    const pr = await step('pr', () =>
      forge.ensurePr({
        repo: loaded.project.ownerRepo,
        branch,
        base: rules.baseBranch,
        title: commitTitle,
        body: prBody(task, executionId, result),
      }),
    );

    // Step 11: record.
    const endedAt = nowIso();
    store.transaction(() => {
      store.updateTask(task.id, {
        status: 'in_review',
        branch,
        prNumber: pr.number,
        prUrl: pr.url,
        stopReason: null,
        updatedAt: endedAt,
      });
      store.finishExecution(executionId, { status: 'succeeded', endedAt, headCommit, prUrl: pr.url });
      store.appendEvent({ executionId, at: endedAt, type: 'pr_opened', payload: { task: task.id, prNumber: pr.number, prUrl: pr.url } });
    });
    out.print(say('run.prOpened', { prUrl: pr.url }));
    out.print(say('run.executionFinished', { executionId, status: 'succeeded' }));
    return {
      kind: 'pr_opened',
      taskId: task.id,
      executionId,
      branch,
      headCommit,
      prNumber: pr.number,
      prUrl: pr.url,
    };
  } catch (error) {
    return finalize(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Recovery

export interface RecoverDeps {
  readonly store: StorePort;
  readonly sandbox: SandboxPort;
  readonly clock: ClockPort;
  readonly console: ConsolePort;
  readonly language: Language;
}

/**
 * Start-of-run recovery (plan 002 section 7.4): every execution left `running` by a process that is
 * no longer alive becomes `interrupted` and its task `failed`; the sandbox kills its containers first.
 * `isProcessAlive` is supplied by the CLI (T22). Returns the ids of the recovered executions.
 */
export async function recoverInterrupted(
  deps: RecoverDeps,
  isProcessAlive: (pid: number) => boolean,
): Promise<readonly string[]> {
  const say = messagesFor(deps.language);
  const recovered: string[] = [];
  for (const execution of deps.store.listExecutions({ status: 'running' })) {
    if (execution.pid !== null && isProcessAlive(execution.pid)) continue;
    let killFailure: string | undefined;
    try {
      await deps.sandbox.kill(execution.id);
    } catch (error) {
      killFailure = error instanceof Error ? error.name : 'Error';
    }
    const at = deps.clock.now().toISOString();
    const reason = say('stop.interrupted', {});
    deps.store.transaction(() => {
      deps.store.finishExecution(execution.id, { status: 'interrupted', endedAt: at, reason });
      if (execution.taskId !== null && deps.store.getTask(execution.taskId)?.status === 'running') {
        deps.store.updateTask(execution.taskId, { status: 'failed', stopReason: reason, updatedAt: at });
      }
      deps.store.appendEvent({
        executionId: execution.id,
        at,
        type: 'interrupted',
        payload: { pid: execution.pid, ...(killFailure === undefined ? {} : { killFailed: killFailure }) },
      });
    });
    deps.console.print(say('run.recoveredInterrupted', { executionId: execution.id }));
    recovered.push(execution.id);
  }
  return recovered;
}
