// Tests of the port fakes: shared ordered recording, scripted responses and default behavior.

import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../src/core/domain/agent.ts';
import { NotFoundError, PushRejectedError, SecretMissingError } from '../../src/core/domain/errors.ts';
import type { Feature } from '../../src/core/domain/feature.ts';
import type { RuntimeJob } from '../../src/core/domain/runtime.ts';
import type { Task } from '../../src/core/domain/task.ts';
import type { SandboxRunRequest } from '../../src/ports/sandbox.ts';
import { FAKE_START_TIME, FakeClock } from './clock.ts';
import { FakeConsole } from './console.ts';
import { FakeFileSystem } from './file-system.ts';
import { FakeForge } from './forge.ts';
import { CallLog, Responses } from './recorder.ts';
import { FakeRuntime } from './runtime.ts';
import { FakeSandbox } from './sandbox.ts';
import { FakeSecrets } from './secrets.ts';
import { FakeStore } from './store.ts';
import { FAKE_BASE_COMMIT, FakeVcs } from './vcs.ts';

const FAKE_TOKEN = 'fake-gh-token-0000';
const FAKE_CLAUDE_TOKEN = 'fake-claude-token-1111';

const agent: AgentDefinition = {
  schemaVersion: 2,
  name: 'roster-core-ts-engineer',
  description: 'TS core.',
  capabilities: ['read', 'edit', 'shell'],
  skills: [],
  runtimes: ['claude-code'],
  contract: 'specialist',
  models: {},
  body: 'You are a TS engineer.',
};

const job: RuntimeJob = {
  executionId: '20261101030000-000001',
  jobKind: 'specialist',
  profile: 'agent',
  agent,
  prompt: 'Do T02.',
  limits: { maxTurns: 80, timeoutMinutes: 90 },
};

function feature(id: string, createdAt: string): Feature {
  return {
    id,
    project: id.split(':')[0] ?? '',
    number: id.split(':')[1] ?? '',
    slug: 'local-core',
    stage: 'execution',
    step: 'running',
    ideaText: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function task(featureId: string, key: string, ord: number): Task {
  return {
    id: `${featureId}-${key}`,
    featureId,
    key,
    ord,
    title: `Task ${key}`,
    status: 'todo',
    needsHuman: null,
    agentSlug: null,
    profile: 'TS core',
    bodyMd: `## ${key}. Task`,
    sourceCommit: 'abc123',
    branch: null,
    prNumber: null,
    prUrl: null,
    mergedAt: null,
    stopReason: null,
    retryNote: null,
    updatedAt: FAKE_START_TIME,
  };
}

describe('CallLog and Responses', () => {
  it('records calls of several fakes in one ordered list', async () => {
    const log = new CallLog();
    const store = new FakeStore(log);
    const vcs = new FakeVcs(log);
    const forge = new FakeForge(log);
    const sandbox = new FakeSandbox(log);

    store.createFeature(feature('roster:002', FAKE_START_TIME));
    const workspace = await vcs.createWorkspace({ name: 'roster', repoPath: 'C:/roster', remoteUrl: 'https://github.com/o/r' }, 'e1');
    await workspace.prepareBranch('agent/002-T02');
    await sandbox.kill('e1');
    await workspace.push('agent/002-T02', FAKE_TOKEN);
    await forge.ensurePr({ repo: 'o/r', branch: 'agent/002-T02', title: '002-T02: Domain', body: 'body' });

    expect(log.names()).toEqual([
      'store.createFeature',
      'vcs.createWorkspace',
      'workspace.prepareBranch',
      'sandbox.kill',
      'workspace.push',
      'forge.ensurePr',
    ]);
    expect(log.of('workspace').map((call) => call.method)).toEqual(['prepareBranch', 'push']);
  });

  it('snapshots arguments so later mutation does not change the record', () => {
    const log = new CallLog();
    const args = { list: ['a'] };
    log.record('x', 'y', [args]);
    args.list.push('b');
    expect(log.calls[0]?.args).toEqual([{ list: ['a'] }]);
  });

  it('answers queued values in order, then errors, then the default, then the fallback', () => {
    interface Port {
      next(n: number): string;
    }
    const responses = new Responses<Port>();
    responses.queue('next', 'first', 'second').queueError('next', new Error('boom'));
    const fallback = (): string => 'fallback';
    expect(responses.pending('next')).toBe(3);
    expect(responses.answer('next', [1], fallback)).toBe('first');
    expect(responses.answer('next', [2], fallback)).toBe('second');
    expect(() => responses.answer('next', [3], fallback)).toThrow('boom');
    expect(responses.answer('next', [4], fallback)).toBe('fallback');
    responses.setDefault('next', (n) => `default ${n}`);
    expect(responses.answer('next', [5], fallback)).toBe('default 5');
  });
});

describe('FakeClock', () => {
  it('stands still, advances on sleep and records both calls', async () => {
    const clock = new FakeClock('2026-11-01T03:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-11-01T03:00:00.000Z');
    await clock.sleep(30_000);
    expect(clock.now().toISOString()).toBe('2026-11-01T03:00:30.000Z');
    clock.advance(1000);
    expect(clock.iso()).toBe('2026-11-01T03:00:31.000Z');
    expect(clock.log.names()).toEqual(['clock.now', 'clock.sleep', 'clock.now']);
  });
});

describe('FakeConsole', () => {
  it('keeps printed lines and answers scripted input', async () => {
    const console = new FakeConsole();
    console.print('hola');
    console.printError('error');
    console.responses.queue('ask', 'una respuesta').queue('readSecret', FAKE_TOKEN).queue('readInput', 'idea\ntext');
    expect(await console.ask('¿Pregunta?')).toBe('una respuesta');
    expect(await console.readSecret('Token:')).toBe(FAKE_TOKEN);
    expect(await console.readInput()).toBe('idea\ntext');
    expect(console.stdout).toEqual(['hola']);
    expect(console.stderr).toEqual(['error']);
    expect(console.log.names()).toEqual([
      'console.print',
      'console.printError',
      'console.ask',
      'console.readSecret',
      'console.readInput',
    ]);
  });

  it('fails loudly when a test did not script an answer', async () => {
    await expect(new FakeConsole().ask('?')).rejects.toThrow('no answer scripted for ask');
  });
});

describe('FakeSecrets', () => {
  it('stores values, never records them, and raises SecretMissingError for a missing secret', async () => {
    const secrets = new FakeSecrets({ 'github-token': FAKE_TOKEN });
    await secrets.set('claude-oauth-token', FAKE_CLAUDE_TOKEN);
    expect(await secrets.get('claude-oauth-token')).toBe(FAKE_CLAUDE_TOKEN);
    expect(await secrets.has('github-token')).toBe(true);
    secrets.values.delete('github-token');
    const error = await secrets.get('github-token').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretMissingError);
    expect((error as SecretMissingError).message).toContain('roster auth set github');
    const recorded = JSON.stringify(secrets.log.calls);
    expect(recorded).not.toContain(FAKE_TOKEN);
    expect(recorded).not.toContain(FAKE_CLAUDE_TOKEN);
  });
});

describe('FakeRuntime', () => {
  it('describes a job, completes by default and returns scripted outcomes', () => {
    const runtime = new FakeRuntime({ name: 'claude-code', capabilities: ['read', 'edit'] });
    expect(runtime.capabilities).toEqual(new Set(['read', 'edit']));
    const invocation = runtime.buildInvocation(job);
    expect(invocation.inFiles.map((file) => file.name)).toEqual(['prompt.md', 'agent.md']);
    expect(invocation.stdinFile).toBe('prompt.md');
    const exit = { exitCode: 0, timedOut: false, stopped: false, startedAt: FAKE_START_TIME, endedAt: FAKE_START_TIME };
    expect(runtime.interpret(exit, '/logs/agent.jsonl')).toEqual({ kind: 'completed', detail: {} });
    runtime.responses.queue('interpret', {
      kind: 'quota_exhausted',
      detail: { quotaResetsAt: '2026-11-01T08:00:00.000Z', quotaWindow: 'five_hour' },
    });
    expect(runtime.interpret(exit, '/logs/agent.jsonl').kind).toBe('quota_exhausted');
    expect(runtime.log.names()).toEqual(['runtime.buildInvocation', 'runtime.interpret', 'runtime.interpret']);
  });
});

describe('FakeSandbox', () => {
  it('exits 0 by default, records env names with redacted values, and scripts exits', async () => {
    const sandbox = new FakeSandbox();
    const request: SandboxRunRequest = {
      executionId: job.executionId,
      job: 'agent',
      profile: 'agent',
      invocation: { image: 'img', argv: ['claude'], env: ['CLAUDE_CODE_OAUTH_TOKEN'], inFiles: [] },
      workspace: { root: '/w', gitDir: '/w/git', tree: '/w/tree', inDir: '/w/in', outDir: '/w/out' },
      logPath: '/logs/agent.jsonl',
      timeoutMs: 1000,
      limits: { memory: '4g', cpus: 2, pids: 512 },
      egressHosts: ['api.anthropic.com'],
      envValues: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_TOKEN },
    };
    expect(await sandbox.available()).toEqual({ available: true });
    expect((await sandbox.run(request)).exitCode).toBe(0);
    sandbox.responses.queue('run', { exitCode: null, timedOut: true, stopped: false, startedAt: 'a', endedAt: 'b' });
    expect((await sandbox.run(request)).timedOut).toBe(true);
    sandbox.responses.queue('available', { available: false, reason: 'docker info timed out' });
    expect(await sandbox.available()).toEqual({ available: false, reason: 'docker info timed out' });
    const recorded = JSON.stringify(sandbox.log.calls);
    expect(recorded).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(recorded).not.toContain(FAKE_CLAUDE_TOKEN);
  });
});

describe('FakeVcs', () => {
  it('reads seeded files from a repo ref', async () => {
    const vcs = new FakeVcs()
      .seedFile('C:/roster', 'origin/main', 'projects/roster.json', '{}')
      .seedFile('C:/roster', 'origin/main', 'projects/app.json', '{"a":1}')
      .seedFile('C:/roster', 'origin/main', 'specs/x.md', 'x')
      .seedRef('C:/roster', 'origin/main', 'main123')
      .seedLastCommit('C:/roster', 'origin/main', 'specs/x.md', 'spec456');
    expect(await vcs.listFiles('C:/roster', 'origin/main', 'projects')).toEqual(['projects/app.json', 'projects/roster.json']);
    expect(await vcs.showFile('C:/roster', 'origin/main', 'projects/app.json')).toBe('{"a":1}');
    expect(await vcs.showFile('C:/roster', 'origin/main', 'missing.json')).toBeNull();
    expect(await vcs.resolveRef('C:/roster', 'origin/main')).toBe('main123');
    expect(await vcs.lastCommitTouching('C:/roster', 'origin/main', 'specs/x.md')).toBe('spec456');
  });

  it('creates workspaces whose commits, pushes and scripted errors are recorded without the token', async () => {
    const vcs = new FakeVcs();
    const workspace = await vcs.createWorkspace({ name: 'roster', repoPath: 'C:/roster', remoteUrl: 'u' }, 'e1');
    expect(workspace.paths.tree).toBe('/fake/workspaces/roster/e1/tree');
    expect(await workspace.headCommit()).toBe(FAKE_BASE_COMMIT);
    vcs.workspaceResponses.queue('prepareBranch', { resumed: true }).queue('changedPaths', ['src/a.ts']);
    expect(await workspace.prepareBranch('agent/002-T02')).toEqual({ resumed: true });
    expect(await workspace.changedPaths('origin/main')).toEqual(['src/a.ts']);
    expect(await workspace.commitAll('002-T02: Domain', { name: 'Roster', email: 'roster@example.invalid' })).toBe('commit1');
    expect(await workspace.headCommit()).toBe('commit1');
    vcs.workspaceResponses.queueError('push', new PushRejectedError('refs/heads/main', 'not an agent branch'));
    await expect(workspace.push('main', FAKE_TOKEN)).rejects.toBeInstanceOf(PushRejectedError);
    expect(JSON.stringify(vcs.log.calls)).not.toContain(FAKE_TOKEN);
    expect(vcs.log.names()).toEqual([
      'vcs.createWorkspace',
      'workspace.headCommit',
      'workspace.prepareBranch',
      'workspace.changedPaths',
      'workspace.commitAll',
      'workspace.headCommit',
      'workspace.push',
    ]);
  });
});

describe('FakeForge', () => {
  it('creates and reuses PRs per branch and scripts PR states', async () => {
    const forge = new FakeForge();
    const first = await forge.ensurePr({ repo: 'o/r', branch: 'agent/002-T02', title: 't', body: 'b' });
    const again = await forge.ensurePr({ repo: 'o/r', branch: 'agent/002-T02', title: 't', body: 'b' });
    const other = await forge.ensurePr({ repo: 'o/r', branch: 'agent/002-T03', title: 't', body: 'b' });
    expect(first).toEqual({ number: 1, url: 'https://github.com/o/r/pull/1' });
    expect(again).toEqual(first);
    expect(other.number).toBe(2);
    expect(await forge.prState('o/r', 1)).toEqual({ state: 'open' });
    forge.responses.queue('prState', { state: 'merged', mergedAt: '2026-11-02T10:00:00.000Z' });
    expect(await forge.prState('o/r', 1)).toEqual({ state: 'merged', mergedAt: '2026-11-02T10:00:00.000Z' });
    forge.responses.queue('mainProtection', { known: false });
    expect(await forge.mainProtection('o/r')).toEqual({ known: false });
    expect(await forge.canRead('o/r')).toBe(true);
  });
});

describe('FakeFileSystem', () => {
  it('keeps an in-memory tree', async () => {
    const fs = new FakeFileSystem();
    const prompt = fs.join('/w', 'in', 'prompt.md');
    expect(prompt).toBe('/w/in/prompt.md');
    await fs.writeText(prompt, 'Do T02.');
    await fs.makeDir('/w/out');
    expect(await fs.readText(prompt)).toBe('Do T02.');
    expect(await fs.readText('/w/in/missing.md')).toBeUndefined();
    expect(await fs.list('/w')).toEqual(['in', 'out']);
    expect(await fs.exists('/w/in')).toBe(true);
    expect((await fs.stat(prompt))?.kind).toBe('file');
    expect((await fs.stat('/w/out'))?.kind).toBe('directory');
    await fs.remove('/w/in');
    expect(await fs.exists(prompt)).toBe(false);
    expect(await fs.list('/w')).toEqual(['out']);
  });

  it('hashes manifests independently of order and sensitive to content and presence', async () => {
    const fs = new FakeFileSystem();
    await fs.writeText('/t/package.json', '{"a":1}');
    await fs.writeText('/t/package-lock.json', '{}');
    const hash = await fs.hashFiles('/t', ['package.json', 'package-lock.json']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.hashFiles('/t', ['package-lock.json', 'package.json'])).toBe(hash);
    await fs.writeText('/t/package.json', '{"a":2}');
    expect(await fs.hashFiles('/t', ['package.json', 'package-lock.json'])).not.toBe(hash);
    expect(await fs.hashFiles('/t', ['package.json', 'yarn.lock'])).not.toBe(
      await fs.hashFiles('/t', ['package.json']),
    );
  });
});

describe('FakeStore', () => {
  it('orders features and tasks, applies transitions with events, and filters tasks', () => {
    const store = new FakeStore();
    store.createFeature(feature('roster:003', '2026-10-31T00:00:00.000Z'));
    store.createFeature(feature('roster:002', '2026-10-30T00:00:00.000Z'));
    store.importTasks('roster:003', [task('roster:003', 'T01', 0)], []);
    store.importTasks(
      'roster:002',
      [task('roster:002', 'T02', 1), task('roster:002', 'T01', 0)],
      [{ taskId: 'roster:002-T02', dependsOnId: 'roster:002-T01' }],
    );
    expect(store.listFeatures().map((f) => f.id)).toEqual(['roster:002', 'roster:003']);
    expect(store.listTasks().map((t) => t.id)).toEqual(['roster:002-T01', 'roster:002-T02', 'roster:003-T01']);
    expect(store.listTaskDependencies('roster:002')).toEqual([{ taskId: 'roster:002-T02', dependsOnId: 'roster:002-T01' }]);

    const event = store.applyFeatureTransition({
      featureId: 'roster:003',
      toStage: 'delivered',
      toStep: 'done',
      at: '2026-11-01T00:00:00.000Z',
    });
    expect(event).toMatchObject({ fromStage: 'execution', toStage: 'delivered', step: 'done', prUrl: null });
    expect(store.getFeature('roster:003')).toMatchObject({ stage: 'delivered', step: 'done' });

    const updated = store.updateTask('roster:002-T01', { status: 'done', mergedAt: 'm', updatedAt: 'u' });
    expect(updated.status).toBe('done');
    expect(store.listTasks({ status: 'todo' }).map((t) => t.id)).toEqual(['roster:002-T02', 'roster:003-T01']);
    expect(() => store.updateTask('roster:002-T99', { updatedAt: 'u' })).toThrow(NotFoundError);
  });

  it('rolls importTasks back when an edge names an unknown task, and rolls transactions back', () => {
    const store = new FakeStore();
    store.createFeature(feature('roster:002', FAKE_START_TIME));
    expect(() =>
      store.importTasks('roster:002', [task('roster:002', 'T01', 0)], [{ taskId: 'roster:002-T01', dependsOnId: 'roster:002-T09' }]),
    ).toThrow(/unknown task/);
    expect(store.listTasks()).toEqual([]);

    expect(() =>
      store.transaction(() => {
        store.importTasks('roster:002', [task('roster:002', 'T01', 0)], []);
        throw new Error('forced failure');
      }),
    ).toThrow('forced failure');
    expect(store.listTasks()).toEqual([]);
  });

  it('runs an execution lifecycle with steps, events, rate limits and window counts', () => {
    const store = new FakeStore();
    const started = store.startExecution({
      taskId: 'roster:002-T02',
      featureId: 'roster:002',
      jobKind: 'specialist',
      agentSlug: 'roster-core-ts-engineer',
      runtime: 'claude-code',
      startedAt: '2026-11-01T03:00:00.000Z',
      pid: 1234,
    });
    expect(started.id).toMatch(/^20261101030000-[0-9a-f]{6}$/);
    expect(started.status).toBe('running');
    store.updateExecution(started.id, { logDir: `/logs/${started.id}`, branch: 'agent/002-T02' });
    store.recordStep({ executionId: started.id, step: 'agent', status: 'running', startedAt: 'a', endedAt: null, detail: null });
    store.recordStep({ executionId: started.id, step: 'agent', status: 'succeeded', startedAt: 'a', endedAt: 'b', detail: null });
    store.appendEvent({ executionId: started.id, at: 'b', type: 'outcome', payload: { kind: 'completed' } });
    store.recordRateLimit(started.id, { status: 'allowed', observedAt: '2026-11-01T03:10:00.000Z' });
    store.recordRateLimit(started.id, {
      status: 'allowed',
      limitType: 'five_hour',
      fiveHour: { utilization: 0.04, resetsAt: '2026-11-01T08:00:00.000Z' },
      sevenDay: { utilization: 0.6 },
      observedAt: '2026-11-01T03:20:00.000Z',
    });
    const finished = store.finishExecution(started.id, { status: 'succeeded', endedAt: 'c', prUrl: 'https://x/pull/1' });

    expect(finished).toMatchObject({ status: 'succeeded', endedAt: 'c', prUrl: 'https://x/pull/1', branch: 'agent/002-T02' });
    expect(store.listSteps(started.id)).toEqual([
      { executionId: started.id, step: 'agent', status: 'succeeded', startedAt: 'a', endedAt: 'b', detail: null },
    ]);
    expect(store.listEvents(started.id).map((e) => e.type)).toEqual(['outcome']);
    expect(store.latestRateLimit('claude-code')).toEqual({
      executionId: started.id,
      snapshot: finished.rateLimit,
    });
    expect(finished.rateLimit?.observedAt).toBe('2026-11-01T03:20:00.000Z');
    expect(store.latestRateLimit('other-runtime')).toBeUndefined();
    expect(store.countExecutionsStarted('2026-11-01T03:00:00.000Z', '2026-11-01T04:00:00.000Z')).toBe(1);
    expect(store.countExecutionsStarted('2026-11-01T03:00:01.000Z', '2026-11-01T04:00:00.000Z')).toBe(0);
    expect(store.listExecutions({ status: 'running' })).toEqual([]);
  });

  it('requests, lists and resolves approvals, and keeps runtime state', () => {
    const store = new FakeStore();
    const request = store.requestApproval({
      taskId: 'roster:002-T05',
      kind: 'dependencies',
      detail: { kind: 'dependencies', manifests: ['package.json'], diff: '+ "x": "1"' },
      contentHash: 'a'.repeat(64),
      createdAt: 'c',
    });
    expect(store.listApprovals({ pending: true }).map((r) => r.id)).toEqual([request.id]);
    store.resolveApproval(request.id, 'approved', 'r');
    expect(store.listApprovals({ pending: true })).toEqual([]);
    expect(store.listApprovals({ pending: false })[0]).toMatchObject({ resolution: 'approved', resolvedAt: 'r' });

    store.setRuntimeState({
      runtime: 'claude-code',
      quotaExhaustedAt: 'q',
      cooldownUntil: 'u',
      cooldownSource: 'resets_at',
      cooldownWindow: 'seven_day',
    });
    expect(store.getRuntimeState('claude-code')?.cooldownWindow).toBe('seven_day');
    expect(store.listRuntimeStates()).toHaveLength(1);
  });

  it('returns copies and lets a test script failures', () => {
    const store = new FakeStore();
    store.upsertProject({
      name: 'roster',
      repoPath: 'C:/roster',
      remoteUrl: 'https://github.com/o/r',
      ownerRepo: 'o/r',
      registrationCommit: 'c',
      syncedAt: 's',
    });
    const project = store.getProject('roster') as { repoPath: string };
    project.repoPath = 'changed';
    expect(store.getProject('roster')?.repoPath).toBe('C:/roster');
    store.responses.queueError('upsertProject', new Error('disk full'));
    expect(() => store.upsertProject({ ...store.getProject('roster')!, syncedAt: 't' })).toThrow('disk full');
    expect(store.getProject('roster')?.syncedAt).toBe('s');
  });

  it('records grilling questions and answers', () => {
    const store = new FakeStore();
    const entry = store.addGrillingQuestion({
      featureId: 'app:001',
      round: 1,
      questionHuman: '¿Quién?',
      questionEn: 'Who?',
      askedAt: 'a',
    });
    store.answerGrillingQuestion(entry.id, 'Yo', 'b');
    expect(store.listGrilling('app:001')).toEqual([{ ...entry, answerHuman: 'Yo', answeredAt: 'b' }]);
  });
});
