// Task pipeline, happy path (plan 002 sections 7.4 and 8, ADR 0019, ADR 0026, ADR 0028, ADR 0030,
// ADR 0032). `runNext` takes the registrations loaded by sync, picks the next ready task, and runs
// steps 1, 3, 4, 5, 6, 9, 10 and 11: workspace, agent job, result validation, policy check, commit,
// push, PR, record. Setup, verify and review come in T25, T26 and T36; hiring in T28; the capability
// router in T17 (until then the only runtime is the injected one, in quota cooldown or not).
//
// Lock, interrupted-execution recovery, the night window, the Docker check and sync belong to the CLI
// (T22). The failure, blocked, protected-path, dependency, quota and stop paths belong to T21: here
// each of them throws `UnhandledStopError` after the step was recorded as failed. Nothing is pushed
// on any of them, because the push step runs only after the result is valid and the policy check of
// the whole range `origin/<baseBranch>..HEAD` is clean.
//
// Every runtime job (agent now; review, hire and stage jobs later) goes through `runRuntimeJob`, which
// stores the rate-limit snapshot of the job on the execution right after `interpret`, whatever the
// outcome (ADR 0030).

import type { AgentDefinition } from '../domain/agent.ts';
import { RosterError } from '../domain/errors.ts';
import { taskBranch } from '../domain/branches.ts';
import type { Execution, ExecutionStepName, JobProfile } from '../domain/execution.ts';
import type { Feature } from '../domain/feature.ts';
import { SLUG_PATTERN } from '../domain/ids.ts';
import { parseResult } from '../domain/result-validators.ts';
import type { SpecialistResult } from '../domain/results.ts';
import type { ContainerExit, RuntimeJob, RuntimeOutcome, SkillText, WorkspacePaths } from '../domain/runtime.ts';
import type { Task } from '../domain/task.ts';
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
    };

export type UnhandledStop =
  | 'agent_outcome'
  | 'result_missing'
  | 'result_invalid'
  | 'result_blocked'
  | 'no_changes'
  | 'protected_path'
  | 'dependency_manifests'
  | 'range_policy';

/** A stop path that T21 handles. T20 only marks the step failed and lets the error reach the caller. */
export class UnhandledStopError extends RosterError {
  override readonly name = 'UnhandledStopError';
  readonly stop: UnhandledStop;

  constructor(stop: UnhandledStop) {
    super(`Stop path ${stop} is not handled yet`);
    this.stop = stop;
  }
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
    const reason = say('stop.error', { job: 'specialist', reason: 'no approved agent for this task' });
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

  const step = async <T>(name: ExecutionStepName, fn: () => Promise<T>): Promise<T> => {
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

  // Step 1: workspace.
  let workspace!: GitWorkspace;
  let resumed = false;
  await step('workspace', async () => {
    workspace = await deps.vcs.createWorkspace(
      {
        name: loaded.project.name,
        repoPath: loaded.project.repoPath,
        remoteUrl: loaded.project.remoteUrl,
        baseBranch: rules.baseBranch,
        branchPrefix: rules.branchPrefix,
      },
      executionId,
    );
    resumed = (await workspace.prepareBranch(branch)).resumed;
    store.updateExecution(executionId, { baseCommit: await workspace.headCommit() });
  });
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
      workspace: workspace.paths,
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
    if (outcome.kind !== 'completed') throw new UnhandledStopError('agent_outcome');
  });

  // Step 4: result.
  const resultText = await fs.readText(fs.join(workspace.paths.outDir, 'result.json'));
  if (resultText === undefined) throw new UnhandledStopError('result_missing');
  const parsed = parseResult('specialist', resultText);
  if (!parsed.ok) throw new UnhandledStopError('result_invalid');
  const result = parsed.value;
  store.updateExecution(executionId, { resultJson: JSON.stringify(result) });
  if (result.status !== 'done') throw new UnhandledStopError('result_blocked');

  // Step 5: policy check of the work tree against the base branch.
  const checkRange = async (): Promise<readonly string[]> => {
    const changed = await workspace.changedPaths(range);
    if (changed.length === 0) throw new UnhandledStopError('no_changes');
    const check = checkChanges({
      policy: deps.policy,
      jobKind: 'specialist',
      changedPaths: changed,
      projectPolicy: policyOfProject,
    });
    if (check.protectedMatches.length > 0 || check.outsideAllowed.length > 0) throw new UnhandledStopError('protected_path');
    if (check.changedManifests.length > 0) throw new UnhandledStopError('dependency_manifests');
    return changed;
  };
  await step('policy', checkRange);

  // Step 6: commit.
  const headCommit = await step('commit', async () => {
    const message = `${commitTitle}\n\nAgent: ${agent.definition.name}\nExecution: ${executionId}\n`;
    const made = await workspace.commitAll(message, deps.commitAuthor);
    return made ?? (await workspace.headCommit());
  });

  // Step 9: policy check of the whole range, then push. Nothing was pushed before this point.
  await step('push', async () => {
    try {
      await checkRange();
    } catch (error) {
      if (error instanceof UnhandledStopError && error.stop !== 'no_changes') throw new UnhandledStopError('range_policy');
      throw error;
    }
    const token = await secrets.get('github-token');
    await workspace.push(branch, token);
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
}
