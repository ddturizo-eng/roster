import { describe, expect, it } from 'vitest';
import { sync } from '../../../src/core/orchestrator/sync.ts';
import type { SyncDeps } from '../../../src/core/orchestrator/sync.ts';
import type { Task } from '../../../src/core/domain/task.ts';
import { CallLog } from '../../fakes/recorder.ts';
import { FakeClock, FAKE_START_TIME } from '../../fakes/clock.ts';
import { FakeForge } from '../../fakes/forge.ts';
import { FakeStore } from '../../fakes/store.ts';
import { FakeVcs } from '../../fakes/vcs.ts';

const ROSTER = 'C:\\roster';
const WEB = 'C:\\code\\web';
const COMMIT = 'abc1234';

function registration(name: string, repoPath: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name,
    repoPath,
    remote: `https://github.com/acme/${name}`,
    setup: [],
    verify: [],
    dependencyManifests: [],
    protectedPaths: [],
    image: 'roster/runtime-claude',
    ...extra,
  });
}

function task(key: string, ord: number, extra: Partial<Task> = {}): Task {
  return {
    id: `web:001-${key}`,
    featureId: 'web:001',
    key,
    ord,
    title: `Title ${key}`,
    status: 'in_review',
    needsHuman: null,
    agentSlug: 'dev',
    profile: null,
    bodyMd: 'body',
    sourceCommit: 'src1',
    branch: `agent/001-${key}`,
    prNumber: ord + 10,
    prUrl: `https://github.com/acme/web/pull/${ord + 10}`,
    mergedAt: null,
    stopReason: null,
    retryNote: null,
    updatedAt: '2026-10-31T00:00:00.000Z',
    ...extra,
  };
}

function setup(tasks: Task[], language: 'en' | 'es' = 'en') {
  const log = new CallLog();
  const vcs = new FakeVcs(log);
  vcs.seedRef(ROSTER, 'origin/main', COMMIT);
  vcs.seedFile(ROSTER, COMMIT, 'projects/roster.json', registration('roster', ROSTER));
  vcs.seedFile(ROSTER, COMMIT, 'projects/web.json', registration('web', WEB, { baseBranch: 'develop', branchPrefix: 'feature' }));
  const store = new FakeStore(log);
  const forge = new FakeForge(log);
  store.upsertProject({
    name: 'web',
    repoPath: WEB,
    remoteUrl: 'https://github.com/acme/web',
    ownerRepo: 'acme/web',
    registrationCommit: 'old',
    syncedAt: '2026-10-01T00:00:00.000Z',
  });
  store.createFeature({
    id: 'web:001',
    project: 'web',
    number: '001',
    slug: 'thing',
    stage: 'execution',
    step: 'running',
    ideaText: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  store.importTasks('web:001', tasks, []);
  const executions = new Map<string, string>();
  for (const t of tasks) {
    const e = store.startExecution({
      taskId: t.id,
      featureId: 'web:001',
      jobKind: 'specialist',
      agentSlug: 'dev',
      runtime: 'claude-code',
      startedAt: '2026-10-30T00:00:00.000Z',
      pid: null,
    });
    executions.set(t.id, e.id);
  }
  log.clear();
  const clock = new FakeClock(FAKE_START_TIME);
  const deps: SyncDeps = { vcs, store, clock, forge, language, rosterRepoPath: ROSTER };
  return { deps, vcs, store, forge, log, executions };
}

describe('sync', () => {
  it('fetches the Roster repo first, then every other registered project, and refreshes registrations', async () => {
    const { deps, log, store } = setup([]);
    const result = await sync(deps);
    expect(log.of('vcs').filter((c) => c.method === 'fetch').map((c) => c.args[0])).toEqual([ROSTER, WEB]);
    expect(log.names().slice(0, 2)).toEqual(['vcs.fetch', 'vcs.resolveRef']);
    expect(store.listProjects().map((p) => [p.name, p.registrationCommit])).toEqual([
      ['roster', COMMIT],
      ['web', COMMIT],
    ]);
    expect(result.registry.projects).toHaveLength(2);
    expect(result.changes).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('merged -> done with merged_at; closed -> rejected with the reason; open -> unchanged; events written', async () => {
    const { deps, store, forge, executions } = setup([task('T01', 1), task('T02', 2), task('T03', 3)]);
    forge.responses.queue(
      'prState',
      { state: 'merged', mergedAt: '2026-10-31T08:00:00Z' },
      { state: 'closed' },
      { state: 'open' },
    );
    const before3 = store.getTask('web:001-T03');
    const result = await sync(deps);

    expect(result.pullRequestsChecked).toBe(3);
    expect(result.changes).toEqual([
      { taskId: 'web:001-T01', change: 'merged' },
      { taskId: 'web:001-T02', change: 'closed' },
    ]);
    const t1 = store.getTask('web:001-T01');
    expect([t1?.status, t1?.mergedAt, t1?.updatedAt]).toEqual(['done', '2026-10-31T08:00:00Z', FAKE_START_TIME]);
    const t2 = store.getTask('web:001-T02');
    expect(t2?.status).toBe('rejected');
    expect(t2?.mergedAt).toBeNull();
    expect(t2?.stopReason).toContain('https://github.com/acme/web/pull/12');
    expect(store.getTask('web:001-T03')).toEqual(before3);

    expect(store.listEvents(executions.get('web:001-T01') as string).map((e) => [e.type, e.at])).toEqual([
      ['pr_merged', FAKE_START_TIME],
    ]);
    expect(store.listEvents(executions.get('web:001-T01') as string)[0]?.payload).toMatchObject({
      task: 'web:001-T01',
      prNumber: 11,
      mergedAt: '2026-10-31T08:00:00Z',
    });
    expect(store.listEvents(executions.get('web:001-T02') as string).map((e) => e.type)).toEqual(['pr_closed_unmerged']);
    expect(store.listEvents(executions.get('web:001-T03') as string)).toEqual([]);
  });

  it('reads PR state with the project owner/repo and the task PR number', async () => {
    const { deps, log } = setup([task('T01', 1)]);
    await sync(deps);
    expect(log.of('forge').map((c) => [c.method, ...c.args])).toEqual([['prState', 'acme/web', 11]]);
  });

  it('reads only tasks awaiting a PR outcome', async () => {
    const { deps, log } = setup([
      task('T01', 1, { status: 'done', mergedAt: '2026-10-30T00:00:00Z' }),
      task('T02', 2, { status: 'rejected' }),
      task('T03', 3, { status: 'todo', prNumber: null, prUrl: null }),
      task('T04', 4, { status: 'running' }),
    ]);
    const result = await sync(deps);
    expect(log.of('forge')).toEqual([]);
    expect(result.pullRequestsChecked).toBe(0);
  });

  it('a second sync does not read a PR it has already seen closed', async () => {
    const { deps, forge, log } = setup([task('T01', 1)]);
    forge.responses.queue('prState', { state: 'closed' });
    await sync(deps);
    log.clear();
    await sync(deps);
    expect(log.of('forge')).toEqual([]);
  });

  it('one PR error is reported and does not stop the others', async () => {
    const { deps, store, forge } = setup([task('T01', 1), task('T02', 2)]);
    forge.responses.queueError('prState', Object.assign(new Error('boom\nsecond line'), { name: 'GitHubError' }));
    forge.responses.queue('prState', { state: 'merged', mergedAt: '2026-10-31T08:00:00Z' });
    const result = await sync(deps);
    expect(result.errors).toEqual([{ kind: 'pr', subject: 'web:001-T01', message: 'GitHubError: boom second line' }]);
    expect(store.getTask('web:001-T01')?.status).toBe('in_review');
    expect(store.getTask('web:001-T02')?.status).toBe('done');
    expect(result.changes).toEqual([{ taskId: 'web:001-T02', change: 'merged' }]);
  });

  it('a project fetch error is reported and the other projects and PRs are still synced', async () => {
    const { deps, store, forge, vcs } = setup([task('T01', 1)]);
    vcs.responses.queue('fetch', undefined); // Roster repo
    vcs.responses.queueError('fetch', new Error('network down')); // web
    forge.responses.queue('prState', { state: 'merged', mergedAt: '2026-10-31T08:00:00Z' });
    const result = await sync(deps);
    expect(result.errors).toEqual([{ kind: 'fetch', subject: 'web', message: 'Error: network down' }]);
    expect(store.getTask('web:001-T01')?.status).toBe('done');
  });

  it('writes the rejection reason in human_language', async () => {
    const { deps, store, forge } = setup([task('T01', 1)], 'es');
    forge.responses.queue('prState', { state: 'closed' });
    await sync(deps);
    const en = setup([task('T01', 1)], 'en');
    en.forge.responses.queue('prState', { state: 'closed' });
    await sync(en.deps);
    const es = store.getTask('web:001-T01')?.stopReason;
    expect(es).toBeTruthy();
    expect(es).not.toBe(en.store.getTask('web:001-T01')?.stopReason);
  });

  it('reports a task whose project is not cached and keeps going', async () => {
    const { deps, store, forge } = setup([task('T01', 1)]);
    store.createFeature({
      id: 'ghost:001',
      project: 'ghost',
      number: '001',
      slug: 'x',
      stage: 'execution',
      step: 'running',
      ideaText: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    store.importTasks('ghost:001', [task('T01', 1, { id: 'ghost:001-T01', featureId: 'ghost:001' })], []);
    forge.responses.queue('prState', { state: 'merged', mergedAt: '2026-10-31T08:00:00Z' });
    const result = await sync(deps);
    expect(result.errors.map((e) => [e.kind, e.subject])).toEqual([['pr', 'ghost:001-T01']]);
    expect(store.getTask('web:001-T01')?.status).toBe('done');
  });
});
