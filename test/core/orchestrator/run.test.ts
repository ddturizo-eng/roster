import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UnhandledStopError, approvedSkillNames, runNext, runRuntimeJob } from '../../../src/core/orchestrator/run.ts';
import type { RunDeps, RunOutcome } from '../../../src/core/orchestrator/run.ts';
import { buildPrompt } from '../../../src/core/orchestrator/prompt.ts';
import { parseRegistration } from '../../../src/core/orchestrator/projects.ts';
import type { LoadedProject } from '../../../src/core/orchestrator/projects.ts';
import { parsePolicy } from '../../../src/core/policy/policy.ts';
import type { RateLimitSnapshot, RuntimeJob, RuntimeOutcome } from '../../../src/core/domain/runtime.ts';
import type { Task } from '../../../src/core/domain/task.ts';
import { CallLog } from '../../fakes/recorder.ts';
import { FakeClock, FAKE_START_TIME } from '../../fakes/clock.ts';
import { FakeConsole } from '../../fakes/console.ts';
import { FakeFileSystem } from '../../fakes/file-system.ts';
import { FakeForge } from '../../fakes/forge.ts';
import { FakeRuntime } from '../../fakes/runtime.ts';
import { FakeSandbox } from '../../fakes/sandbox.ts';
import { FakeSecrets } from '../../fakes/secrets.ts';
import { FakeStore } from '../../fakes/store.ts';
import { FakeVcs } from '../../fakes/vcs.ts';

const ROSTER = 'C:\\roster';
const ROSTER_COMMIT = 'rost123';
const FAKE_CLAUDE_TOKEN = 'fake-claude-token-0000';
const FAKE_GH_TOKEN = 'fake-github-token-0000';
const AUTHOR = { name: 'Roster Bot', email: 'roster@example.test' };

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../policies/${name}`, import.meta.url), 'utf8'));
}
const policy = parsePolicy(readJson('mvp.json'), readJson('protected-paths.json'));

const AGENT_MD = [
  '---',
  'schema: roster/agent@2',
  'name: dev',
  'description: Test specialist',
  'capabilities: edit, shell',
  'runtimes: claude-code',
  'contract: specialist',
  '---',
  'You are a test specialist.',
  '',
].join('\n');

const BODY_MD = [
  '## T05. Add the widget',
  '',
  '- [ ] Done',
  '- Acceptance criteria:',
  '  - The widget renders.',
  '- Verification: `npm test`.',
].join('\n');

const RATE_LIMIT: RateLimitSnapshot = {
  status: 'allowed',
  limitType: 'five_hour',
  fiveHour: { utilization: 0.04, resetsAt: '2026-11-01T08:00:00.000Z' },
  sevenDay: { utilization: 0.6, resetsAt: '2026-11-05T08:00:00.000Z' },
  observedAt: FAKE_START_TIME,
};

const DONE_RESULT = JSON.stringify({ status: 'done', summary: 'Added the widget.', verification: 'npm test passes', notes: 'none' });

interface SetupOptions {
  readonly registration?: Record<string, unknown>;
  readonly agentMd?: string | null;
  readonly agentSlug?: string | null;
  readonly taskStatus?: Task['status'];
  readonly registryMd?: string;
  readonly resultText?: string | null;
}

function setup(options: SetupOptions = {}) {
  const log = new CallLog();
  const vcs = new FakeVcs(log);
  const store = new FakeStore(log);
  const clock = new FakeClock(FAKE_START_TIME, log);
  const forge = new FakeForge(log);
  const sandbox = new FakeSandbox(log);
  const runtime = new FakeRuntime({ name: 'claude-code' }, log);
  const fs = new FakeFileSystem(log);
  const secrets = new FakeSecrets({ 'claude-oauth-token': FAKE_CLAUDE_TOKEN, 'github-token': FAKE_GH_TOKEN }, log);
  const console_ = new FakeConsole(log);

  const parsed = parseRegistration(
    JSON.stringify({
      name: 'web',
      repoPath: 'C:\\code\\web',
      remote: 'https://github.com/acme/web',
      setup: [],
      verify: [],
      dependencyManifests: [],
      protectedPaths: [],
      image: 'roster/runtime-claude',
      ...options.registration,
    }),
    'web',
    'projects/web.json',
  );
  if (!parsed.ok) throw new Error('bad fixture registration');
  const loaded: LoadedProject = {
    registration: parsed.registration,
    isRosterRepo: false,
    project: {
      name: 'web',
      repoPath: parsed.registration.repoPath,
      remoteUrl: parsed.registration.remote,
      ownerRepo: 'acme/web',
      registrationCommit: 'reg1',
      syncedAt: '2026-10-01T00:00:00.000Z',
    },
  };

  vcs.seedRef(ROSTER, 'origin/main', ROSTER_COMMIT);
  if (options.agentMd !== null) vcs.seedFile(ROSTER, ROSTER_COMMIT, 'agents/dev.md', options.agentMd ?? AGENT_MD);
  if (options.registryMd !== undefined) vcs.seedFile(ROSTER, ROSTER_COMMIT, 'skills/registry.md', options.registryMd);
  runtime.responses.setDefault('buildInvocation', (job) => ({
    image: 'roster/runtime-claude:test',
    argv: ['claude', '-p'],
    env: ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME'],
    inFiles: [{ name: 'prompt.md', content: job.prompt }],
    stdinFile: 'prompt.md',
  }));
  vcs.workspaceResponses.setDefault('changedPaths', () => ['src/widget.ts', 'test/widget.test.ts']);
  const resultText = options.resultText === undefined ? DONE_RESULT : options.resultText;
  fs.responses.setDefault('readText', (path) => (path.endsWith('/out/result.json') ? (resultText ?? undefined) : undefined));

  store.upsertProject(loaded.project);
  store.createFeature({
    id: 'web:007',
    project: 'web',
    number: '007',
    slug: 'widgets',
    stage: 'execution',
    step: 'running',
    ideaText: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  const task: Task = {
    id: 'web:007-T05',
    featureId: 'web:007',
    key: 'T05',
    ord: 0,
    title: 'Add the widget',
    status: options.taskStatus ?? 'todo',
    needsHuman: null,
    agentSlug: options.agentSlug === undefined ? 'dev' : options.agentSlug,
    profile: null,
    bodyMd: BODY_MD,
    sourceCommit: 'src1',
    branch: null,
    prNumber: null,
    prUrl: null,
    mergedAt: null,
    stopReason: null,
    retryNote: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  store.importTasks('web:007', [task], []);
  log.clear();

  const deps: RunDeps = {
    vcs,
    store,
    clock,
    forge,
    sandbox,
    runtime,
    fs,
    secrets,
    console: console_,
    language: 'en',
    rosterRepoPath: ROSTER,
    logRoot: '/logs',
    commitAuthor: AUTHOR,
    policy,
    pid: 4242,
  };
  return { deps, input: { projects: [loaded] }, log, vcs, store, clock, forge, sandbox, runtime, fs, secrets, console: console_ };
}

/** Calls that only read; everything else is a side effect or a store update asserted in order. */
const READS = new Set([
  'getTask',
  'getFeature',
  'getProject',
  'getExecution',
  'getRuntimeState',
  'listFeatures',
  'listTasks',
  'listTaskDependencies',
  'listExecutions',
  'listSteps',
  'listEvents',
  'now',
  'join',
  'showFile',
  'readText',
  'resolveRef',
  'headCommit',
]);

function effects(log: CallLog): string[] {
  return log.calls.filter((call) => !READS.has(call.method)).map((call) => `${call.port}.${call.method}`);
}

function stepNames(store: FakeStore, executionId: string): string[] {
  return store.listSteps(executionId).map((s) => `${s.step}:${s.status}`);
}

describe('runNext: happy path', () => {
  it('runs workspace, agent, result, policy, commit, push, PR and record in this exact order', async () => {
    const { deps, input, log, store, runtime } = setup();
    runtime.responses.queue('interpret', { kind: 'completed', detail: { rateLimit: RATE_LIMIT } });
    const outcome = await runNext(deps, input);

    expect(effects(log)).toEqual([
      'console.print', // selected task
      'store.transaction',
      'store.startExecution',
      'store.updateTask', // running
      'console.print', // execution started
      'store.updateExecution', // branch, log dir
      // step 1: workspace
      'console.print',
      'store.recordStep',
      'vcs.createWorkspace',
      'workspace.prepareBranch',
      'store.updateExecution', // base commit
      'store.recordStep',
      // step 3: agent job
      'console.print',
      'store.recordStep',
      'runtime.buildInvocation',
      'secrets.get', // claude token
      'sandbox.run',
      'runtime.interpret',
      'store.recordRateLimit', // right after interpret
      'store.appendEvent', // outcome
      'store.recordStep',
      // step 4: result
      'store.updateExecution', // result json
      // step 5: policy check
      'console.print',
      'store.recordStep',
      'workspace.changedPaths',
      'store.recordStep',
      // step 6: commit
      'console.print',
      'store.recordStep',
      'workspace.commitAll',
      'store.recordStep',
      // step 9: range check, then push
      'console.print',
      'store.recordStep',
      'workspace.changedPaths',
      'secrets.get', // github token, only after the checks
      'workspace.push',
      'store.recordStep',
      // step 10: PR
      'console.print',
      'store.recordStep',
      'forge.ensurePr',
      'store.recordStep',
      // step 11: record
      'store.transaction',
      'store.updateTask', // in_review
      'store.finishExecution',
      'store.appendEvent',
      'console.print', // PR opened
      'console.print', // execution finished
    ]);

    expect(outcome.kind).toBe('pr_opened');
    const pr = outcome as Extract<RunOutcome, { kind: 'pr_opened' }>;
    expect(pr.branch).toBe('agent/007-T05');
    expect(pr.headCommit).toBe('commit1');

    const execution = store.getExecution(pr.executionId)!;
    expect(execution).toMatchObject({
      taskId: 'web:007-T05',
      jobKind: 'specialist',
      agentSlug: 'dev',
      runtime: 'claude-code',
      status: 'succeeded',
      branch: 'agent/007-T05',
      headCommit: 'commit1',
      baseCommit: 'base000',
      prUrl: 'https://github.com/acme/web/pull/1',
      pid: 4242,
      rateLimit: RATE_LIMIT,
    });
    expect(execution.logDir).toBe(`/logs/${pr.executionId}`);
    expect(JSON.parse(execution.resultJson!)).toMatchObject({ status: 'done', summary: 'Added the widget.' });
    expect(stepNames(store, pr.executionId)).toEqual([
      'workspace:succeeded',
      'agent:succeeded',
      'policy:succeeded',
      'commit:succeeded',
      'push:succeeded',
      'pr:succeeded',
    ]);
    expect(store.getTask('web:007-T05')).toMatchObject({
      status: 'in_review',
      branch: 'agent/007-T05',
      prNumber: 1,
      prUrl: 'https://github.com/acme/web/pull/1',
      stopReason: null,
    });
  });

  it('records the rate-limit snapshot of the agent job on the execution', async () => {
    const { deps, input, runtime, store, log } = setup();
    runtime.responses.queue('interpret', { kind: 'completed', detail: { rateLimit: RATE_LIMIT } });
    const outcome = (await runNext(deps, input)) as Extract<RunOutcome, { kind: 'pr_opened' }>;
    expect(store.getExecution(outcome.executionId)!.rateLimit).toEqual(RATE_LIMIT);
    const names = effects(log);
    expect(names.indexOf('store.recordRateLimit')).toBe(names.indexOf('runtime.interpret') + 1);
  });

  it('builds the commit, the PR and the sandbox request from the task, the policy and the result', async () => {
    const { deps, input, log, runtime, store } = setup();
    const outcome = (await runNext(deps, input)) as Extract<RunOutcome, { kind: 'pr_opened' }>;
    const id = outcome.executionId;

    const commit = log.calls.find((c) => c.method === 'commitAll')!;
    const message = commit.args[0] as string;
    expect(message.split('\n')[0]).toBe('007-T05: Add the widget');
    expect(message).toContain('Agent: dev');
    expect(message).toContain(`Execution: ${id}`);
    expect(commit.args[1]).toEqual(AUTHOR);

    const pr = log.calls.find((c) => c.method === 'ensurePr')!.args[0] as Record<string, string>;
    expect(pr).toMatchObject({ repo: 'acme/web', branch: 'agent/007-T05', base: 'main', title: '007-T05: Add the widget' });
    expect(pr['body']).toContain('Task: web:007-T05');
    expect(pr['body']).toContain(`Execution: ${id}`);
    expect(pr['body']).toContain('Added the widget.');
    expect(pr['body']).toContain('npm test passes');
    expect(pr['body']).toContain('## Notes');

    const run = log.calls.find((c) => c.method === 'run')!.args[0] as Record<string, unknown>;
    expect(run).toMatchObject({
      executionId: id,
      job: 'agent',
      profile: 'agent',
      logPath: `/logs/${id}/agent.jsonl`,
      timeoutMs: 90 * 60_000,
      limits: { memory: '4g', cpus: 2, pids: 512 },
      egressHosts: ['api.anthropic.com'],
    });
    // The fake sandbox never records a secret value.
    expect(JSON.stringify(log.calls)).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(JSON.stringify(log.calls)).not.toContain(FAKE_GH_TOKEN);
    expect(run['envValues']).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '[redacted]' });

    const job = log.calls.find((c) => c.method === 'buildInvocation')!.args[0] as RuntimeJob;
    expect(job).toMatchObject({ executionId: id, jobKind: 'specialist', profile: 'agent', limits: { maxTurns: 60, timeoutMinutes: 90 } });
    expect(job.prompt).toContain('The widget renders.');
    expect(runtime.name).toBe('claude-code');
    expect(store.listEvents(id).map((e) => e.type)).toEqual(['outcome', 'pr_opened']);
  });

  it('works for a project with base develop and prefix feature', async () => {
    const { deps, input, log, vcs, store } = setup({ registration: { baseBranch: 'develop', branchPrefix: 'feature' } });
    const outcome = (await runNext(deps, input)) as Extract<RunOutcome, { kind: 'pr_opened' }>;

    expect(outcome.branch).toBe('feature/agent-007-T05');
    const create = log.calls.find((c) => c.method === 'createWorkspace')!;
    expect(create.args[0]).toMatchObject({ name: 'web', baseBranch: 'develop', branchPrefix: 'feature' });
    expect(vcs.workspaces[0]!.rules).toEqual({ baseBranch: 'develop', branchPrefix: 'feature' });
    expect(log.calls.find((c) => c.method === 'prepareBranch')!.args).toEqual(['feature/agent-007-T05']);
    // Both policy checks cover origin/<baseBranch>..HEAD.
    expect(log.calls.filter((c) => c.method === 'changedPaths').map((c) => c.args[0])).toEqual([
      'origin/develop',
      'origin/develop',
    ]);
    expect(log.calls.find((c) => c.method === 'push')!.args[0]).toBe('feature/agent-007-T05');
    const pr = log.calls.find((c) => c.method === 'ensurePr')!.args[0] as Record<string, string>;
    expect(pr).toMatchObject({ branch: 'feature/agent-007-T05', base: 'develop', title: '007-T05: Add the widget' });
    expect(store.getTask('web:007-T05')!.branch).toBe('feature/agent-007-T05');
  });

  it('tells the agent it is resuming and passes the retry note when they apply', async () => {
    const { deps, input, log, vcs, store, console: out } = setup();
    vcs.workspaceResponses.queue('prepareBranch', { resumed: true });
    store.updateTask('web:007-T05', { retryNote: 'Use the new API.', updatedAt: FAKE_START_TIME });
    await runNext(deps, input);
    const job = log.calls.find((c) => c.method === 'buildInvocation')!.args[0] as RuntimeJob;
    expect(job.prompt).toContain('Resuming');
    expect(job.prompt).toContain('> Use the new API.');
    expect(out.stdout).toContain('Resuming from the existing branch agent/007-T05.');
  });

  it('inlines approved skills of the agent and refuses an agent whose skill has no text', async () => {
    const registry = ['| Skill | Source | Pinned ref | For profiles | Status | Notes |', '| --- | --- | --- | --- | --- | --- |', '| lint-helper | x | y | z | approved | n |'].join('\n');
    const agentMd = AGENT_MD.replace('contract: specialist', 'contract: specialist\nskills: lint-helper');

    const ok = setup({ agentMd, registryMd: registry });
    ok.vcs.seedFile(ROSTER, ROSTER_COMMIT, '.claude/skills/lint-helper/SKILL.md', '# Lint helper');
    await runNext(ok.deps, ok.input);
    const job = ok.log.calls.find((c) => c.method === 'buildInvocation')!.args[0] as RuntimeJob;
    expect(job.skills).toEqual([{ name: 'lint-helper', content: '# Lint helper' }]);

    const missing = setup({ agentMd, registryMd: registry });
    expect((await runNext(missing.deps, missing.input)).kind).toBe('no_agent');
  });
});

describe('runNext: nothing to do', () => {
  it('prints the message and writes nothing when no task is ready', async () => {
    const { deps, input, log, store, console: out } = setup({ taskStatus: 'in_review' });
    const outcome = await runNext(deps, input);
    expect(outcome).toEqual({ kind: 'nothing_to_do' });
    expect(effects(log)).toEqual(['console.print']);
    expect(out.stdout).toEqual(['Nothing to do.']);
    expect(store.listExecutions()).toEqual([]);
  });

  it('ignores features of projects without a valid registration', async () => {
    const { deps, log } = setup();
    const outcome = await runNext(deps, { projects: [] });
    expect(outcome.kind).toBe('nothing_to_do');
    expect(effects(log)).toEqual(['console.print']);
  });
});

describe('runNext: no approved agent', () => {
  const cases: [string, SetupOptions][] = [
    ['no agent on the task', { agentSlug: null }],
    ['agent file missing on origin/main', { agentMd: null }],
    ['unsafe slug', { agentSlug: '../secrets' }],
    ['agent file invalid', { agentMd: 'not an agent' }],
    ['agent uses another contract', { agentMd: AGENT_MD.replace('contract: specialist', 'contract: reviewer') }],
    ['agent lists a skill that is not approved', { agentMd: AGENT_MD.replace('contract: specialist', 'contract: specialist\nskills: nope') }],
  ];
  it.each(cases)('%s -> task blocked, no execution, nothing run', async (_name, options) => {
    const { deps, input, log, store, console: out } = setup(options);
    const outcome = await runNext(deps, input);
    expect(outcome).toEqual({ kind: 'no_agent', taskId: 'web:007-T05' });
    const task = store.getTask('web:007-T05')!;
    expect(task.status).toBe('blocked');
    expect(task.stopReason).toContain('no approved agent');
    expect(store.listExecutions()).toEqual([]);
    expect(effects(log)).toEqual(['console.print', 'store.updateTask', 'console.print']);
    expect(out.stdout.at(-1)).toContain('no approved agent');
  });
});

describe('runNext: quota cooldown', () => {
  it('exits with the cooldown outcome while cooldown_until is in the future', async () => {
    const { deps, input, log, store, console: out } = setup();
    store.setRuntimeState({
      runtime: 'claude-code',
      quotaExhaustedAt: '2026-11-01T01:00:00.000Z',
      cooldownUntil: '2026-11-01T06:00:00.000Z',
      cooldownSource: 'resets_at',
      cooldownWindow: 'five_hour',
    });
    log.clear();
    const outcome = await runNext(deps, input);
    expect(outcome).toEqual({
      kind: 'quota_cooldown',
      taskId: 'web:007-T05',
      runtime: 'claude-code',
      until: '2026-11-01T06:00:00.000Z',
    });
    expect(effects(log)).toEqual(['console.print', 'console.print']);
    expect(out.stdout.at(-1)).toBe('Runtime claude-code is in quota cooldown until 2026-11-01T06:00:00.000Z.');
    expect(store.listExecutions()).toEqual([]);
    expect(store.getTask('web:007-T05')!.status).toBe('todo');
  });

  it('runs when the cooldown has passed', async () => {
    const { deps, input, store } = setup();
    store.setRuntimeState({
      runtime: 'claude-code',
      quotaExhaustedAt: '2026-11-01T01:00:00.000Z',
      cooldownUntil: '2026-11-01T02:00:00.000Z',
      cooldownSource: 'fallback',
      cooldownWindow: null,
    });
    expect((await runNext(deps, input)).kind).toBe('pr_opened');
  });

  it('does not start when the agent cannot run on the runtime', async () => {
    const { deps, input, log, store } = setup({ agentMd: AGENT_MD.replace('runtimes: claude-code', 'runtimes: other-runtime') });
    expect((await runNext(deps, input)).kind).toBe('no_runtime');
    expect(effects(log)).toEqual(['console.print', 'console.print']);
    expect(store.listExecutions()).toEqual([]);
  });
});

describe('runNext: nothing is pushed before the result is valid and the policy check passes', () => {
  const noPushOrPr = (log: CallLog): void => {
    const names = effects(log);
    expect(names).not.toContain('workspace.push');
    expect(names).not.toContain('forge.ensurePr');
    expect(log.of('secrets').filter((c) => c.args[0] === 'github-token')).toEqual([]);
  };

  const outcomes: [string, RuntimeOutcome][] = [
    ['timeout', { kind: 'timeout', detail: { rateLimit: RATE_LIMIT } }],
    ['error', { kind: 'error', detail: { reason: 'turn limit', rateLimit: RATE_LIMIT } }],
    ['quota_exhausted', { kind: 'quota_exhausted', detail: { rateLimit: RATE_LIMIT, quotaResetsAt: '2026-11-01T08:00:00.000Z', quotaWindow: 'five_hour' } }],
    ['stopped', { kind: 'stopped', detail: {} }],
  ];
  it.each(outcomes)('agent outcome %s -> stop path, snapshot recorded, nothing pushed', async (_name, outcome) => {
    const { deps, input, log, runtime, store } = setup();
    runtime.responses.queue('interpret', outcome);
    await expect(runNext(deps, input)).rejects.toMatchObject({ name: 'UnhandledStopError', stop: 'agent_outcome' });
    noPushOrPr(log);
    expect(effects(log)).not.toContain('workspace.commitAll');
    const id = store.listExecutions()[0]!.id;
    expect(store.getExecution(id)!.rateLimit).toEqual(outcome.detail.rateLimit ?? null);
    expect(stepNames(store, id)).toEqual(['workspace:succeeded', 'agent:failed']);
  });

  const results: [string, string | null, string][] = [
    ['missing result', null, 'result_missing'],
    ['not JSON', 'not json', 'result_invalid'],
    ['violates the contract', JSON.stringify({ status: 'done' }), 'result_invalid'],
    ['blocked by the agent', JSON.stringify({ status: 'blocked', summary: 's', verification: '', questions: [{ text: 'Which API?' }] }), 'result_blocked'],
  ];
  it.each(results)('%s -> stop path before policy, commit and push', async (_name, resultText, stop) => {
    const { deps, input, log } = setup({ resultText });
    await expect(runNext(deps, input)).rejects.toMatchObject({ name: 'UnhandledStopError', stop });
    noPushOrPr(log);
    expect(effects(log)).not.toContain('workspace.changedPaths');
    expect(effects(log)).not.toContain('workspace.commitAll');
  });

  const changes: [string, readonly string[], string][] = [
    ['no changes', [], 'no_changes'],
    ['protected path', ['src/a.ts', '.github/workflows/ci.yml'], 'protected_path'],
    ['dependency manifest', ['package.json'], 'dependency_manifests'],
    ['malformed path', ['../outside.txt'], 'protected_path'],
  ];
  it.each(changes)('%s -> stop path, no commit, no push, no PR', async (_name, paths, stop) => {
    const { deps, input, log, vcs } = setup();
    vcs.workspaceResponses.setDefault('changedPaths', () => paths);
    const error: unknown = await runNext(deps, input).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnhandledStopError);
    expect((error as UnhandledStopError).stop).toBe(stop);
    noPushOrPr(log);
    expect(effects(log)).not.toContain('workspace.commitAll');
  });

  it('a violation in the whole range (earlier resumed commits) stops before the push', async () => {
    const { deps, input, log, vcs, store } = setup();
    vcs.workspaceResponses.queue('changedPaths', ['src/a.ts'], ['src/a.ts', '.claude/settings.json']);
    await expect(runNext(deps, input)).rejects.toMatchObject({ stop: 'range_policy' });
    noPushOrPr(log);
    // The commit exists locally (kept for T21), and the push step is the one that failed.
    expect(effects(log)).toContain('workspace.commitAll');
    const id = store.listExecutions()[0]!.id;
    expect(stepNames(store, id).slice(-2)).toEqual(['commit:succeeded', 'push:failed']);
  });

  it('push is called with the checked branch only after both policy checks', async () => {
    const { deps, input, log } = setup();
    await runNext(deps, input);
    const names = log.names();
    const push = names.indexOf('workspace.push');
    expect(names.lastIndexOf('workspace.changedPaths')).toBeLessThan(push);
    expect(names.indexOf('workspace.commitAll')).toBeLessThan(push);
    expect(names.indexOf('runtime.interpret')).toBeLessThan(push);
  });
});

describe('runRuntimeJob', () => {
  function jobSetup() {
    const s = setup();
    const executionId = s.store.startExecution({
      taskId: 'web:007-T05',
      featureId: 'web:007',
      jobKind: 'specialist',
      agentSlug: 'dev',
      runtime: 'claude-code',
      startedAt: FAKE_START_TIME,
      pid: null,
    }).id;
    s.log.clear();
    const request = {
      executionId,
      job: 'review',
      profile: 'review' as const,
      runtimeJob: {
        executionId,
        jobKind: 'reviewer' as const,
        profile: 'review' as const,
        agent: { schemaVersion: 2 as const, name: 'code-reviewer', description: 'd', capabilities: ['read' as const], skills: [], runtimes: ['claude-code'], contract: 'reviewer' as const, models: {}, body: 'b' },
        prompt: 'review it',
        limits: { maxTurns: 10, timeoutMinutes: 5 },
        skills: [],
      },
      workspace: { root: '/w', gitDir: '/w/git', tree: '/w/tree', inDir: '/w/in', outDir: '/w/out' },
      logPath: `/logs/${executionId}/review.jsonl`,
      timeoutMs: 300_000,
      limits: { memory: '4g', cpus: 2, pids: 512 },
      egressHosts: ['api.anthropic.com'],
    };
    return { ...s, executionId, request };
  }

  it('builds, runs, interprets and records the snapshot right after interpret', async () => {
    const s = jobSetup();
    s.runtime.responses.queue('interpret', { kind: 'completed', detail: { rateLimit: RATE_LIMIT } });
    const result = await runRuntimeJob(s.deps, s.request);
    expect(result.outcome.kind).toBe('completed');
    expect(s.log.names()).toEqual(['runtime.buildInvocation', 'secrets.get', 'sandbox.run', 'runtime.interpret', 'store.recordRateLimit']);
    expect(s.store.getExecution(s.executionId)!.rateLimit).toEqual(RATE_LIMIT);
  });

  it('a later job replaces the earlier snapshot of the same execution', async () => {
    const s = jobSetup();
    const later: RateLimitSnapshot = { ...RATE_LIMIT, status: 'allowed_warning', observedAt: '2026-11-01T03:30:00.000Z' };
    s.runtime.responses.queue(
      'interpret',
      { kind: 'completed', detail: { rateLimit: RATE_LIMIT } },
      { kind: 'completed', detail: { rateLimit: later } },
    );
    await runRuntimeJob(s.deps, s.request);
    await runRuntimeJob(s.deps, s.request);
    expect(s.store.getExecution(s.executionId)!.rateLimit).toEqual(later);
  });

  it.each(['completed', 'quota_exhausted', 'timeout', 'error', 'stopped'] as const)('records the snapshot for outcome %s', async (kind) => {
    const s = jobSetup();
    s.runtime.responses.queue('interpret', { kind, detail: { rateLimit: RATE_LIMIT } });
    await runRuntimeJob(s.deps, s.request);
    expect(s.log.names()).toContain('store.recordRateLimit');
  });

  it('records nothing when the outcome has no snapshot', async () => {
    const s = jobSetup();
    await runRuntimeJob(s.deps, s.request);
    expect(s.log.names()).not.toContain('store.recordRateLimit');
    expect(s.store.getExecution(s.executionId)!.rateLimit).toBeNull();
  });
});

describe('buildPrompt', () => {
  const base = {
    taskId: 'web:007-T05',
    title: 'Add the widget',
    bodyMd: BODY_MD,
    featureDir: '007-widgets',
    resuming: false,
    retryNote: null,
  };

  it('contains the task text, acceptance criteria, spec and plan paths, the contract and the environment limits', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('# Task web:007-T05: Add the widget');
    expect(prompt).toContain(BODY_MD);
    expect(prompt).toContain('The widget renders.');
    expect(prompt).toContain('`specs/007-widgets/spec.md`');
    expect(prompt).toContain('`specs/007-widgets/plan.md`');
    expect(prompt).toContain('/roster/out/result.json');
    expect(prompt).toContain('"status": "done" | "blocked"');
    expect(prompt).toContain('"verification"');
    expect(prompt).toMatch(/Git is not available/);
    expect(prompt).toMatch(/network is not available/);
  });

  it('leaves out the resume and retry notes when they do not apply', () => {
    const prompt = buildPrompt(base);
    expect(prompt).not.toContain('## Resuming');
    expect(prompt).not.toContain('## Note from the human');
    expect(buildPrompt({ ...base, retryNote: '   ' })).not.toContain('## Note from the human');
  });

  it('adds the resume note and the retry note, quoted and length-limited', () => {
    const prompt = buildPrompt({ ...base, resuming: true, retryNote: `Line one\nLine two ${'x'.repeat(5000)}` });
    expect(prompt).toContain('## Resuming');
    expect(prompt).toContain('> Line one');
    const note = prompt.split('## Note from the human')[1]!.split('## Result')[0]!;
    expect(note.length).toBeLessThan(4400);
    expect(note).toContain('…');
  });
});

describe('approvedSkillNames', () => {
  it('lists only rows whose Status column is approved', () => {
    const text = [
      '# Skills registry',
      '',
      '| Skill | Source | Pinned ref | For profiles | Status | Notes |',
      '| --- | --- | --- | --- | --- | --- |',
      '| a-skill | s | r | p | approved | n |',
      '| b-skill | s | r | p | proposed | n |',
      '| c-skill | s | r | p | rejected | n |',
      '| d-skill | s | r | p | Approved | n |',
    ].join('\r\n');
    expect(approvedSkillNames(text)).toEqual(['a-skill', 'd-skill']);
    expect(approvedSkillNames('no table here')).toEqual([]);
  });
});
