import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { approvedSkillNames, recoverInterrupted, runNext, runRuntimeJob } from '../../../src/core/orchestrator/run.ts';
import type { RunDeps, RunOutcome } from '../../../src/core/orchestrator/run.ts';
import { buildPrompt } from '../../../src/core/orchestrator/prompt.ts';
import { parseRegistration } from '../../../src/core/orchestrator/projects.ts';
import type { LoadedProject } from '../../../src/core/orchestrator/projects.ts';
import { PushRejectedError } from '../../../src/core/domain/errors.ts';
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
    quotaCooldownMinutes: 300,
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

const noPushOrPr = (log: CallLog): void => {
  const names = effects(log);
  expect(names).not.toContain('workspace.push');
  expect(names).not.toContain('forge.ensurePr');
  expect(log.of('secrets').filter((c) => c.args[0] === 'github-token')).toEqual([]);
};

/** Execution and task of the only task, after a stop path. */
function finalState(store: FakeStore) {
  const execution = store.listExecutions()[0]!;
  return { execution, task: store.getTask('web:007-T05')! };
}

describe('runNext: stop paths of the agent job', () => {
  const outcomes: [string, RuntimeOutcome, string, string][] = [
    ['timeout', { kind: 'timeout', detail: { rateLimit: RATE_LIMIT } }, 'failed', 'The agent job reached its time limit of 90 minutes.'],
    ['error', { kind: 'error', detail: { reason: 'turn limit', rateLimit: RATE_LIMIT } }, 'failed', 'The agent job failed: turn limit.'],
  ];
  it.each(outcomes)('agent outcome %s -> failed with the reason, snapshot recorded, nothing pushed', async (_name, outcome, status, reason) => {
    const { deps, input, log, runtime, store, console: out } = setup();
    runtime.responses.queue('interpret', outcome);
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'failed', taskId: 'web:007-T05', reason });
    noPushOrPr(log);
    expect(effects(log)).not.toContain('workspace.commitAll');
    const { execution, task } = finalState(store);
    expect(execution).toMatchObject({ status, reason, rateLimit: outcome.detail.rateLimit, endedAt: FAKE_START_TIME });
    expect(task).toMatchObject({ status: 'failed', stopReason: reason });
    expect(stepNames(store, execution.id)).toEqual(['workspace:succeeded', 'agent:failed']);
    expect(store.listEvents(execution.id).map((e) => [e.type, (e.payload as { kind: string }).kind])).toEqual([
      ['outcome', outcome.kind],
      ['stop', outcome.kind],
    ]);
    expect(out.stdout.slice(-2)).toEqual([`Reason: ${reason}`, `Execution ${execution.id} finished: failed.`]);
    expect(store.listApprovals()).toEqual([]);
  });

  it('a stopped job -> execution and task stopped, nothing pushed', async () => {
    const { deps, input, log, runtime, store } = setup();
    runtime.responses.queue('interpret', { kind: 'stopped', detail: {} });
    const result = await runNext(deps, input);
    expect(result.kind).toBe('stopped');
    noPushOrPr(log);
    const { execution, task } = finalState(store);
    expect(execution.status).toBe('stopped');
    expect(task).toMatchObject({ status: 'stopped', stopReason: expect.stringContaining('Stopped by the human') });
  });

  it('writes the whole end state in one transaction', async () => {
    const { deps, input, log, runtime } = setup();
    runtime.responses.queue('interpret', { kind: 'error', detail: { reason: 'turn limit' } });
    await runNext(deps, input);
    const names = effects(log);
    const tail = names.slice(names.indexOf('store.appendEvent') + 1);
    expect(tail).toEqual([
      'store.recordStep', // agent step failed
      'store.transaction',
      'store.updateTask',
      'store.finishExecution',
      'store.appendEvent',
      'console.print',
      'console.print',
    ]);
  });
});

describe('runNext: stop paths of the result', () => {
  const invalid: [string, string | null, string][] = [
    ['missing result', null, 'out/result.json is missing'],
    ['not JSON', 'not json', 'is not valid JSON'],
    ['violates the contract', JSON.stringify({ status: 'done' }), 'summary'],
  ];
  it.each(invalid)('%s -> failed with the invalid-result reason, before policy, commit and push', async (_name, resultText, problem) => {
    const { deps, input, log, store } = setup({ resultText });
    const result = await runNext(deps, input);
    expect(result.kind).toBe('failed');
    noPushOrPr(log);
    expect(effects(log)).not.toContain('workspace.changedPaths');
    expect(effects(log)).not.toContain('workspace.commitAll');
    const { execution, task } = finalState(store);
    expect(execution.status).toBe('failed');
    expect(task.status).toBe('failed');
    expect(task.stopReason).toContain('The specialist result is missing or invalid');
    expect(task.stopReason).toContain(problem);
  });

  it('a result blocked by the agent -> task blocked with the questions, nothing pushed, no approval', async () => {
    const resultText = JSON.stringify({
      status: 'blocked',
      summary: 's',
      verification: '',
      questions: [{ text: 'Which API?' }, { text: 'Keep the old route?' }],
    });
    const { deps, input, log, store, console: out } = setup({ resultText });
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'blocked', reason: 'agent_blocked' });
    noPushOrPr(log);
    expect(effects(log)).not.toContain('workspace.commitAll');
    const { execution, task } = finalState(store);
    expect(execution.status).toBe('blocked');
    expect(task.status).toBe('blocked');
    expect(task.stopReason).toBe('The agent is blocked and needs an answer: Which API? | Keep the old route?. Nothing was pushed.');
    expect(JSON.parse(execution.resultJson!)).toMatchObject({ status: 'blocked' });
    expect(store.listApprovals()).toEqual([]);
    expect(out.stdout.at(-2)).toBe(`Reason: ${task.stopReason}`);
  });

  it('the human language is used for the reason', async () => {
    const { deps, input, store } = setup({ resultText: null });
    await runNext({ ...deps, language: 'es' }, input);
    expect(finalState(store).task.stopReason).toContain('El resultado specialist falta o no es válido');
  });
});

describe('runNext: stop paths of the policy check', () => {
  it('no changes -> failed "no changes", no commit, nothing pushed', async () => {
    const { deps, input, log, vcs, store } = setup();
    vcs.workspaceResponses.setDefault('changedPaths', () => []);
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'failed', reason: 'The agent finished without changing any file.' });
    noPushOrPr(log);
    expect(effects(log)).not.toContain('workspace.commitAll');
    const { execution, task } = finalState(store);
    expect([execution.status, task.status]).toEqual(['failed', 'failed']);
    expect(stepNames(store, execution.id).at(-1)).toBe('policy:failed');
  });

  const protectedCases: [string, readonly string[], string[]][] = [
    ['protected path', ['src/a.ts', '.github/workflows/ci.yml'], ['.github/workflows/ci.yml']],
    ['malformed path', ['../outside.txt'], ['../outside.txt']],
  ];
  it.each(protectedCases)('%s -> commit kept locally, task blocked, protected_path request, nothing pushed', async (_name, paths, named) => {
    const { deps, input, log, vcs, store, console: out } = setup();
    vcs.workspaceResponses.setDefault('changedPaths', () => paths);
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'blocked', reason: 'protected_path' });
    noPushOrPr(log);
    expect(vcs.workspaces[0]!.commits).toHaveLength(1);
    expect(vcs.workspaces[0]!.pushes).toEqual([]);

    const { execution, task } = finalState(store);
    expect(execution).toMatchObject({ status: 'blocked', headCommit: 'commit1' });
    expect(task.status).toBe('blocked');
    expect(task.stopReason).toContain('protected or disallowed paths');
    expect(task.stopReason).toContain(named.join(', '));
    expect(task.stopReason).toContain('local branch agent/007-T05');
    expect(task.stopReason).toContain(vcs.workspaces[0]!.paths.root);
    const approvals = store.listApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      taskId: 'web:007-T05',
      kind: 'protected_path',
      detail: { kind: 'protected_path', paths: named, branch: 'agent/007-T05' },
      contentHash: null,
      resolvedAt: null,
    });
    // The console line clips long parameters (safe-text); the stored reason is complete.
    expect(out.stdout.at(-2)).toMatch(/^Reason: The changes touch protected or disallowed paths: /);
  });

  it('writes the commit, then the approval request and the end state in one transaction', async () => {
    const { deps, input, log, vcs } = setup();
    vcs.workspaceResponses.setDefault('changedPaths', () => ['.claude/settings.json']);
    await runNext(deps, input);
    const names = effects(log);
    expect(names.slice(names.indexOf('workspace.commitAll'))).toEqual([
      'workspace.commitAll',
      'store.transaction',
      'store.requestApproval',
      'store.updateTask',
      'store.finishExecution',
      'store.appendEvent',
      'console.print',
      'console.print',
    ]);
  });

  describe('dependency manifests', () => {
    function manifestSetup() {
      const s = setup();
      s.vcs.workspaceResponses.setDefault('changedPaths', () => ['src/a.ts', 'package.json']);
      s.vcs.workspaceResponses.setDefault('showFile', () => '{\n  "name": "web"\n}');
      s.fs.responses.setDefault('readText', (path) =>
        path.endsWith('/out/result.json') ? DONE_RESULT : path.endsWith('/tree/package.json') ? '{\n  "name": "web",\n  "dependencies": {"left-pad": "1.0.0"}\n}' : undefined,
      );
      return s;
    }

    it('-> commit kept locally, task blocked, dependencies request with the hash and the diff, nothing pushed', async () => {
      const { deps, input, log, vcs, store, fs } = manifestSetup();
      const result = await runNext(deps, input);
      expect(result).toMatchObject({ kind: 'blocked', reason: 'dependencies' });
      noPushOrPr(log);
      expect(vcs.workspaces[0]!.commits).toHaveLength(1);

      const hashCall = log.calls.find((c) => c.method === 'hashFiles')!;
      expect(hashCall.args).toEqual([`${vcs.workspaces[0]!.paths.tree}`, ['package.json']]);
      const hash = await fs.hashFiles(vcs.workspaces[0]!.paths.tree, ['package.json']);
      const { execution, task } = finalState(store);
      expect(execution).toMatchObject({ status: 'blocked', headCommit: 'commit1' });
      expect(task.status).toBe('blocked');
      expect(task.stopReason).toContain('Dependency manifests changed: package.json');
      expect(task.stopReason).toContain(`hash ${hash}`);
      expect(task.stopReason).toContain('roster retry web:007-T05 --approve-dependencies');
      const request = store.listApprovals()[0]!;
      expect(request).toMatchObject({ kind: 'dependencies', contentHash: hash, resolvedAt: null });
      const detail = request.detail as unknown as { manifests: string[]; diff: string };
      expect(detail.manifests).toEqual(['package.json']);
      expect(detail.diff).toContain('*** package.json');
      expect(detail.diff).toContain('+  "dependencies": {"left-pad": "1.0.0"}');
    });

    it('an approved request for the same hash lets the task through', async () => {
      const { deps, input, store, fs } = manifestSetup();
      const hash = await fs.hashFiles('/anywhere', ['package.json']);
      const request = store.requestApproval({
        taskId: 'web:007-T05',
        kind: 'dependencies',
        detail: { kind: 'dependencies', manifests: ['package.json'], diff: '' },
        contentHash: hash,
        createdAt: FAKE_START_TIME,
      });
      store.resolveApproval(request.id, 'approved', FAKE_START_TIME);
      expect((await runNext(deps, input)).kind).toBe('pr_opened');
    });

    it('a pending or different-hash request does not', async () => {
      const { deps, input, store, fs } = manifestSetup();
      const hash = await fs.hashFiles('/anywhere', ['package.json']);
      const pending = store.requestApproval({
        taskId: 'web:007-T05',
        kind: 'dependencies',
        detail: { kind: 'dependencies', manifests: ['package.json'], diff: '' },
        contentHash: hash,
        createdAt: FAKE_START_TIME,
      });
      expect(pending.resolution).toBeNull();
      expect((await runNext(deps, input)).kind).toBe('blocked');
    });
  });

  it('a violation in the whole range (earlier resumed commits) -> blocked after the push step failed, nothing pushed', async () => {
    const { deps, input, log, vcs, store } = setup();
    vcs.workspaceResponses.queue('changedPaths', ['src/a.ts'], ['src/a.ts', '.claude/settings.json']);
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'blocked', reason: 'protected_path' });
    noPushOrPr(log);
    // One commit only: the step 6 commit; the range stop does not commit again.
    expect(vcs.workspaces[0]!.commits).toHaveLength(1);
    const { execution, task } = finalState(store);
    expect(stepNames(store, execution.id).slice(-2)).toEqual(['commit:succeeded', 'push:failed']);
    expect(execution).toMatchObject({ status: 'blocked', headCommit: 'commit1' });
    expect(task.status).toBe('blocked');
    expect(task.stopReason).toContain('.claude/settings.json');
    expect(store.listApprovals()[0]).toMatchObject({ kind: 'protected_path' });
  });

  it('the range check covers origin/<baseBranch>..HEAD of the project', async () => {
    const { deps, input, log, vcs } = setup({ registration: { baseBranch: 'develop' } });
    vcs.workspaceResponses.queue('changedPaths', ['src/a.ts'], ['.claude/x']);
    await runNext(deps, input);
    expect(log.calls.filter((c) => c.method === 'changedPaths').map((c) => c.args[0])).toEqual(['origin/develop', 'origin/develop']);
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

describe('runNext: an exception after the start', () => {
  it('a rejected push -> execution and task failed with the error class only', async () => {
    const { deps, input, log, vcs, store } = setup();
    vcs.workspaceResponses.queueError('push', new PushRejectedError('agent/007-T05', 'rejected'));
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'failed', reason: 'The push job failed: PushRejectedError.' });
    expect(effects(log)).not.toContain('forge.ensurePr');
    const { execution, task } = finalState(store);
    expect([execution.status, task.status]).toEqual(['failed', 'failed']);
    expect(task.stopReason).toBe('The push job failed: PushRejectedError.');
    expect(stepNames(store, execution.id).at(-1)).toBe('push:failed');
  });

  it('an exception while creating the workspace -> failed, nothing run', async () => {
    const { deps, input, log, vcs, store } = setup();
    vcs.responses.queueError('createWorkspace', new Error(`clone failed with ${FAKE_GH_TOKEN}`));
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'failed', reason: 'The workspace job failed: Error.' });
    expect(effects(log)).not.toContain('sandbox.run');
    const { execution, task } = finalState(store);
    expect([execution.status, task.status]).toEqual(['failed', 'failed']);
    expect(JSON.stringify(store.listEvents(execution.id))).not.toContain(FAKE_GH_TOKEN);
  });

  it('an exception while running the job -> failed', async () => {
    const { deps, input, sandbox, store } = setup();
    sandbox.responses.queueError('run', new Error('docker exploded'));
    const result = await runNext(deps, input);
    expect(result.kind).toBe('failed');
    expect(finalState(store).task.status).toBe('failed');
  });
});

describe('runNext: quota_exhausted', () => {
  const FIVE_HOURS = '2026-11-01T08:00:00.000Z';
  const quota = (detail: RuntimeOutcome['detail']): RuntimeOutcome => ({ kind: 'quota_exhausted', detail: { rateLimit: RATE_LIMIT, ...detail } });

  it('WIP commit, guarded push without a PR, task todo, cooldown from resetsAt, in this exact order', async () => {
    const { deps, input, log, runtime, store, vcs, console: out } = setup();
    runtime.responses.queue('interpret', quota({ quotaResetsAt: FIVE_HOURS, quotaWindow: 'five_hour' }));
    const result = await runNext(deps, input);

    const names = effects(log);
    expect(names.slice(names.indexOf('store.appendEvent') + 1)).toEqual([
      'store.recordStep', // agent step failed
      'workspace.changedPaths',
      'console.print',
      'store.recordStep', // commit
      'workspace.commitAll',
      'store.recordStep',
      'console.print',
      'store.recordStep', // push
      'secrets.get',
      'workspace.push',
      'store.recordStep',
      'store.transaction',
      'store.setRuntimeState',
      'store.updateTask',
      'store.finishExecution',
      'store.appendEvent',
      'console.print',
      'console.print',
    ]);
    expect(names).not.toContain('forge.ensurePr');

    expect(result).toMatchObject({
      kind: 'quota_exhausted',
      branch: 'agent/007-T05',
      pushed: true,
      cooldownUntil: FIVE_HOURS,
      cooldownSource: 'resets_at',
      cooldownWindow: 'five_hour',
    });
    const commit = vcs.workspaces[0]!.commits[0]!;
    expect(commit.message.split('\n')[0]).toBe('wip(007-T05): partial work, quota exhausted');
    expect(commit.author).toEqual(AUTHOR);
    expect(vcs.workspaces[0]!.pushes).toEqual(['agent/007-T05']);

    const { execution, task } = finalState(store);
    expect(execution).toMatchObject({ status: 'quota_exhausted', headCommit: 'commit1', rateLimit: RATE_LIMIT });
    expect(task).toMatchObject({ status: 'todo', prNumber: null, prUrl: null });
    expect(task.stopReason).toBe(
      `The claude-code quota is exhausted. Work in progress was pushed to agent/007-T05 and the task is back in todo. No runs on claude-code until ${FIVE_HOURS}, when the five_hour window resets.`,
    );
    expect(store.getRuntimeState('claude-code')).toEqual({
      runtime: 'claude-code',
      quotaExhaustedAt: FAKE_START_TIME,
      cooldownUntil: FIVE_HOURS,
      cooldownSource: 'resets_at',
      cooldownWindow: 'five_hour',
    });
    expect(store.listEvents(execution.id).map((e) => e.type)).toEqual(['outcome', 'stop']);
    expect(out.stdout.at(-1)).toBe(`Execution ${execution.id} finished: quota_exhausted.`);
  });

  it('the next run is refused while the cooldown lasts and resumes after it', async () => {
    const { deps, input, runtime, clock, store } = setup();
    runtime.responses.queue('interpret', quota({ quotaResetsAt: FIVE_HOURS, quotaWindow: 'five_hour' }));
    await runNext(deps, input);
    expect((await runNext(deps, input)).kind).toBe('quota_cooldown');
    clock.set('2026-11-01T08:00:01.000Z');
    expect((await runNext(deps, input)).kind).toBe('pr_opened');
    expect(store.getTask('web:007-T05')!.status).toBe('in_review');
  });

  const NOW = Date.parse(FAKE_START_TIME);
  const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
  const HOUR = 3_600_000;
  const cooldowns: [string, RuntimeOutcome['detail'], { until: string; source: string; window: string | null }][] = [
    ['a 5-hour reset', { quotaResetsAt: iso(5 * HOUR), quotaWindow: 'five_hour' }, { until: iso(5 * HOUR), source: 'resets_at', window: 'five_hour' }],
    ['a 7-day reset', { quotaResetsAt: iso(7 * 24 * HOUR), quotaWindow: 'seven_day' }, { until: iso(7 * 24 * HOUR), source: 'resets_at', window: 'seven_day' }],
    ['a reset exactly 8 days ahead', { quotaResetsAt: iso(8 * 24 * HOUR), quotaWindow: 'seven_day' }, { until: iso(8 * 24 * HOUR), source: 'resets_at', window: 'seven_day' }],
    ['a missing reset', {}, { until: iso(300 * 60_000), source: 'fallback', window: null }],
    ['a reset in the past', { quotaResetsAt: iso(-HOUR), quotaWindow: 'five_hour' }, { until: iso(300 * 60_000), source: 'fallback', window: null }],
    ['a reset equal to now', { quotaResetsAt: iso(0), quotaWindow: 'five_hour' }, { until: iso(300 * 60_000), source: 'fallback', window: null }],
    ['a reset more than 8 days ahead', { quotaResetsAt: iso(8 * 24 * HOUR + 1), quotaWindow: 'seven_day' }, { until: iso(300 * 60_000), source: 'fallback', window: null }],
    ['an unparsable reset', { quotaResetsAt: 'tomorrow', quotaWindow: 'five_hour' }, { until: iso(300 * 60_000), source: 'fallback', window: null }],
  ];
  it.each(cooldowns)('cooldown for %s', async (_name, detail, expected) => {
    const { deps, input, runtime, store, console: out } = setup();
    runtime.responses.queue('interpret', quota(detail));
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'quota_exhausted', cooldownUntil: expected.until, cooldownSource: expected.source, cooldownWindow: expected.window });
    expect(store.getRuntimeState('claude-code')).toEqual({
      runtime: 'claude-code',
      quotaExhaustedAt: FAKE_START_TIME,
      cooldownUntil: expected.until,
      cooldownSource: expected.source,
      cooldownWindow: expected.window,
    });
    expect(out.stdout.at(-2)).toContain(expected.until);
  });

  it('uses quotaCooldownMinutes of the configuration for the fallback', async () => {
    const { deps, input, runtime, store } = setup();
    runtime.responses.queue('interpret', quota({}));
    await runNext({ ...deps, quotaCooldownMinutes: 45 }, input);
    expect(store.getRuntimeState('claude-code')!.cooldownUntil).toBe(iso(45 * 60_000));
  });

  it('the fallback reason says the end is estimated', async () => {
    const { deps, input, runtime, store } = setup();
    runtime.responses.queue('interpret', quota({}));
    await runNext(deps, input);
    expect(finalState(store).task.stopReason).toContain('(estimated)');
  });

  it('nothing changed -> no WIP commit and no push, still todo with a cooldown', async () => {
    const { deps, input, log, runtime, store, vcs } = setup();
    vcs.workspaceResponses.setDefault('changedPaths', () => []);
    runtime.responses.queue('interpret', quota({ quotaResetsAt: FIVE_HOURS, quotaWindow: 'five_hour' }));
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'quota_exhausted', pushed: false });
    expect(effects(log)).not.toContain('workspace.commitAll');
    noPushOrPr(log);
    expect(finalState(store).task.status).toBe('todo');
    expect(store.getRuntimeState('claude-code')!.cooldownSource).toBe('resets_at');
  });

  it('protected paths -> the policy stop path instead of the push, runtime cooled down all the same', async () => {
    const { deps, input, log, runtime, store, vcs } = setup();
    vcs.workspaceResponses.setDefault('changedPaths', () => ['.github/workflows/ci.yml']);
    runtime.responses.queue('interpret', quota({ quotaResetsAt: FIVE_HOURS, quotaWindow: 'five_hour' }));
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'blocked', reason: 'protected_path' });
    noPushOrPr(log);
    expect(vcs.workspaces[0]!.commits).toHaveLength(1);
    expect(vcs.workspaces[0]!.commits[0]!.message).not.toContain('wip(');
    const { execution, task } = finalState(store);
    expect([execution.status, task.status]).toEqual(['blocked', 'blocked']);
    expect(store.listApprovals()[0]).toMatchObject({ kind: 'protected_path' });
    expect(store.getRuntimeState('claude-code')).toMatchObject({ cooldownUntil: FIVE_HOURS, cooldownSource: 'resets_at' });
  });

  it('a rejected WIP push -> failed, nothing else pushed, runtime cooled down', async () => {
    const { deps, input, runtime, store, vcs } = setup();
    vcs.workspaceResponses.queueError('push', new PushRejectedError('agent/007-T05', 'rejected'));
    runtime.responses.queue('interpret', quota({}));
    const result = await runNext(deps, input);
    expect(result).toMatchObject({ kind: 'failed', reason: 'The push job failed: PushRejectedError.' });
    expect(finalState(store).task.status).toBe('failed');
    expect(store.getRuntimeState('claude-code')!.cooldownSource).toBe('fallback');
  });

  it('records the rate-limit snapshot of every runtime job that ended on a stop path', async () => {
    const kinds: RuntimeOutcome['kind'][] = ['quota_exhausted', 'timeout', 'error'];
    for (const kind of kinds) {
      const { deps, input, runtime, store } = setup();
      runtime.responses.queue('interpret', { kind, detail: { rateLimit: RATE_LIMIT } });
      await runNext(deps, input);
      expect(finalState(store).execution.rateLimit).toEqual(RATE_LIMIT);
    }
  });
});

describe('recoverInterrupted', () => {
  function recoverySetup(pid: number | null = 111) {
    const s = setup();
    const execution = s.store.startExecution({
      taskId: 'web:007-T05',
      featureId: 'web:007',
      jobKind: 'specialist',
      agentSlug: 'dev',
      runtime: 'claude-code',
      startedAt: '2026-11-01T01:00:00.000Z',
      pid,
    });
    s.store.updateTask('web:007-T05', { status: 'running', updatedAt: FAKE_START_TIME });
    s.log.clear();
    return { ...s, execution };
  }

  it.each([[111], [null]])('a running execution of a dead PID (%s) -> interrupted, task failed, sandbox killed', async (pid) => {
    const { deps, store, log, execution, console: out } = recoverySetup(pid);
    const recovered = await recoverInterrupted(deps, () => false);
    expect(recovered).toEqual([execution.id]);
    expect(effects(log)).toEqual([
      'sandbox.kill',
      'store.transaction',
      'store.finishExecution',
      'store.updateTask',
      'store.appendEvent',
      'console.print',
    ]);
    expect(log.of('sandbox')[0]!.args).toEqual([execution.id]);
    const after = store.getExecution(execution.id)!;
    expect(after).toMatchObject({ status: 'interrupted', endedAt: FAKE_START_TIME });
    expect(after.reason).toContain('interrupted');
    expect(store.getTask('web:007-T05')).toMatchObject({ status: 'failed', stopReason: after.reason });
    expect(store.listEvents(execution.id).map((e) => e.type)).toEqual(['interrupted']);
    expect(out.stdout).toEqual([`Execution ${execution.id} was left running by a process that ended; marked interrupted.`]);
  });

  it('leaves an execution whose process is alive', async () => {
    const { deps, store, log, execution } = recoverySetup(111);
    expect(await recoverInterrupted(deps, (pid) => pid === 111)).toEqual([]);
    expect(effects(log)).toEqual([]);
    expect(store.getExecution(execution.id)!.status).toBe('running');
    expect(store.getTask('web:007-T05')!.status).toBe('running');
  });

  it('does nothing when no execution is running', async () => {
    const { deps, log } = setup();
    expect(await recoverInterrupted(deps, () => false)).toEqual([]);
    expect(effects(log)).toEqual([]);
  });

  it('marks the execution even when the kill fails, and records the failure', async () => {
    const { deps, store, sandbox, execution } = recoverySetup();
    sandbox.responses.queueError('kill', new Error('docker gone'));
    await recoverInterrupted(deps, () => false);
    expect(store.getExecution(execution.id)!.status).toBe('interrupted');
    expect(store.listEvents(execution.id)[0]!.payload).toMatchObject({ killFailed: 'Error' });
  });

  it('does not touch a task that is no longer running', async () => {
    const { deps, store, execution } = recoverySetup();
    store.updateTask('web:007-T05', { status: 'stopped', updatedAt: FAKE_START_TIME });
    await recoverInterrupted(deps, () => false);
    expect(store.getExecution(execution.id)!.status).toBe('interrupted');
    expect(store.getTask('web:007-T05')!.status).toBe('stopped');
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
