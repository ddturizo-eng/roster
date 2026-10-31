import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importFeature } from '../../../src/core/orchestrator/import.ts';
import type { ImportDeps } from '../../../src/core/orchestrator/import.ts';
import { parseRegistration } from '../../../src/core/orchestrator/projects.ts';
import type { LoadedProject } from '../../../src/core/orchestrator/projects.ts';
import { CallLog } from '../../fakes/recorder.ts';
import { FakeClock, FAKE_START_TIME } from '../../fakes/clock.ts';
import { FakeStore } from '../../fakes/store.ts';
import { FakeVcs } from '../../fakes/vcs.ts';
import { file, taskText } from '../dag/helpers.ts';

const COMMIT = 'head999';

function loaded(name: string, extra: Record<string, unknown> = {}): LoadedProject {
  const parsed = parseRegistration(
    JSON.stringify({
      name,
      repoPath: `C:\\code\\${name}`,
      remote: `https://github.com/acme/${name}`,
      setup: [],
      verify: [],
      dependencyManifests: [],
      protectedPaths: [],
      image: 'roster/runtime-claude',
      ...extra,
    }),
    name,
    `projects/${name}.json`,
  );
  if (!parsed.ok) throw new Error('bad fixture registration');
  return {
    registration: parsed.registration,
    isRosterRepo: false,
    project: {
      name,
      repoPath: parsed.registration.repoPath,
      remoteUrl: parsed.registration.remote,
      ownerRepo: `acme/${name}`,
      registrationCommit: 'reg1',
      syncedAt: FAKE_START_TIME,
    },
  };
}

function setup(project: LoadedProject = loaded('web')) {
  const log = new CallLog();
  const vcs = new FakeVcs(log);
  const store = new FakeStore(log);
  const clock = new FakeClock(FAKE_START_TIME, log);
  const deps: ImportDeps = { vcs, store, clock };
  const base = project.registration.baseBranch;
  vcs.seedRef(project.project.repoPath, `origin/${base}`, COMMIT);
  const seed = (name: string, tasksMd: string, files: readonly string[] = ['spec.md', 'plan.md', 'tasks.md']) => {
    for (const f of files) {
      const content = f === 'tasks.md' ? tasksMd : `# ${f}\n`;
      vcs.seedFile(project.project.repoPath, COMMIT, `specs/${name}/${f}`, content);
      vcs.seedLastCommit(project.project.repoPath, COMMIT, `specs/${name}/${f}`, `c-${f}`);
    }
  };
  return { log, vcs, store, clock, deps, project, seed };
}

const NAME = '001-demo';
const TASKS = file(taskText('T01'), taskText('T02', { depends: 'T01' }), taskText('T03', { depends: 'T02' }));

describe('importFeature', () => {
  it('imports a fresh feature, recording each stage in order with commit evidence', async () => {
    const t = setup();
    t.seed(NAME, TASKS);
    t.log.clear();
    const result = await importFeature(t.deps, t.project, NAME);

    expect(result).toMatchObject({ ok: true, mode: 'created', featureId: 'web:001', added: ['T01', 'T02', 'T03'] });
    const feature = t.store.getFeature('web:001');
    expect(feature).toMatchObject({ stage: 'execution', step: 'running', slug: 'demo', number: '001' });
    const events = t.store.listFeatureEvents('web:001');
    expect(events.map((e) => [e.fromStage, e.toStage, e.step, e.evidenceCommit])).toEqual([
      ['idea', 'analysis', 'spec_pr_open', 'c-spec.md'],
      ['analysis', 'spec_approved', 'plan_pr_open', 'c-spec.md'],
      ['spec_approved', 'plan_approved', 'importing', 'c-plan.md'],
      ['plan_approved', 'execution', 'running', 'c-tasks.md'],
    ]);
    const tasks = t.store.listTasks({ featureId: 'web:001' });
    expect(tasks.map((x) => [x.id, x.ord, x.status, x.sourceCommit])).toEqual([
      ['web:001-T01', 0, 'todo', 'c-tasks.md'],
      ['web:001-T02', 1, 'todo', 'c-tasks.md'],
      ['web:001-T03', 2, 'todo', 'c-tasks.md'],
    ]);
    expect(t.store.listTaskDependencies('web:001')).toEqual([
      { taskId: 'web:001-T02', dependsOnId: 'web:001-T01' },
      { taskId: 'web:001-T03', dependsOnId: 'web:001-T02' },
    ]);
    // Only the base branch ref is read; nothing is written outside the store.
    expect(t.log.calls.filter((c) => c.port === 'vcs').map((c) => c.method)).not.toContain('fetch');
  });

  it('imports [x] Done tasks as done on first import', async () => {
    const t = setup();
    t.seed(NAME, file(taskText('T01', { done: '- [x] Done' }), taskText('T02', { depends: 'T01' })));
    const result = await importFeature(t.deps, t.project, NAME);
    expect(result).toMatchObject({ ok: true, addedDone: ['T01'] });
    expect(t.store.getTask('web:001-T01')?.status).toBe('done');
    expect(t.store.getTask('web:001-T02')?.status).toBe('todo');
  });

  it('reads origin/develop for a project whose base branch is develop', async () => {
    const t = setup(loaded('api', { baseBranch: 'develop', branchPrefix: 'feature' }));
    t.seed(NAME, TASKS);
    t.log.clear();
    const result = await importFeature(t.deps, t.project, NAME);
    expect(result.ok).toBe(true);
    expect(t.log.calls.find((c) => c.method === 'resolveRef')?.args).toEqual(['C:\\code\\api', 'origin/develop']);
    expect(t.store.getFeature('api:001')?.stage).toBe('execution');
  });

  it('rejects when files are missing from the base branch and writes nothing', async () => {
    const t = setup();
    t.seed(NAME, TASKS, ['spec.md', 'tasks.md']);
    const result = await importFeature(t.deps, t.project, NAME);
    expect(result).toEqual({
      ok: false,
      reason: 'files_missing',
      ref: 'origin/main',
      missing: ['specs/001-demo/plan.md'],
    });
    expect(t.store.listFeatures()).toEqual([]);
    expect(t.store.listTasks()).toEqual([]);
  });

  it('rejects a bad feature name', async () => {
    const t = setup();
    expect(await importFeature(t.deps, t.project, 'demo')).toEqual({ ok: false, reason: 'invalid_feature_name' });
  });

  it('rejects a dependency cycle with the parser message and writes nothing', async () => {
    const t = setup();
    t.seed(NAME, file(taskText('T01', { depends: 'T02' }), taskText('T02', { depends: 'T01' })));
    t.log.clear();
    const result = await importFeature(t.deps, t.project, NAME);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'invalid_tasks') throw new Error('expected invalid_tasks');
    expect(result.errors.map((e) => e.code)).toEqual(['dependency_cycle']);
    expect(result.errors[0]?.message).toContain('T01 -> T02 -> T01');
    const writes = t.log.calls.filter((c) => c.port === 'store' && c.method !== 'getFeature');
    expect(writes).toEqual([]);
    expect(t.store.listFeatures()).toEqual([]);
  });

  describe('re-import', () => {
    async function imported() {
      const t = setup();
      t.seed(NAME, TASKS);
      await importFeature(t.deps, t.project, NAME);
      return t;
    }

    it('cancels a removed task that never started and adds a new one', async () => {
      const t = await imported();
      t.seed(NAME, file(taskText('T01'), taskText('T02', { depends: 'T01' }), taskText('T04', { depends: 'T01' })));
      const result = await importFeature(t.deps, t.project, NAME);
      expect(result).toMatchObject({ ok: true, mode: 'reimported', added: ['T04'], cancelled: ['T03'] });
      expect(t.store.getTask('web:001-T03')?.status).toBe('cancelled');
      expect(t.store.getTask('web:001-T04')).toMatchObject({ status: 'todo', ord: 2 });
      expect(t.store.listTaskDependencies('web:001')).toEqual(
        expect.arrayContaining([
          { taskId: 'web:001-T02', dependsOnId: 'web:001-T01' },
          { taskId: 'web:001-T04', dependsOnId: 'web:001-T01' },
        ]),
      );
    });

    it('updates a not-started task and keeps the state of a done task', async () => {
      const t = await imported();
      t.store.updateTask('web:001-T01', { status: 'done', updatedAt: FAKE_START_TIME });
      t.seed(
        NAME,
        file(
          taskText('T01', { verification: 'changed text' }),
          taskText('T02', { depends: 'T01', verification: 'new check' }),
          taskText('T03', { depends: 'T02' }),
        ),
      );
      const result = await importFeature(t.deps, t.project, NAME);
      expect(result).toMatchObject({ ok: true, updated: ['T02'], textChanged: ['T01'] });
      expect(t.store.getTask('web:001-T01')?.status).toBe('done');
      expect(t.store.getTask('web:001-T02')?.bodyMd).toContain('new check');
    });

    it('is a no-op when nothing changed', async () => {
      const t = await imported();
      const result = await importFeature(t.deps, t.project, NAME);
      expect(result).toMatchObject({ ok: true, mode: 'reimported', added: [], updated: [], cancelled: [] });
    });

    it('is rejected while a removed task is running, and writes nothing', async () => {
      const t = await imported();
      t.store.updateTask('web:001-T03', { status: 'running', updatedAt: FAKE_START_TIME });
      t.seed(NAME, file(taskText('T01'), taskText('T02', { depends: 'T01' })));
      t.log.clear();
      const result = await importFeature(t.deps, t.project, NAME);
      expect(result).toEqual({
        ok: false,
        reason: 'reimport_blocked',
        blockers: [{ taskId: 'web:001-T03', key: 'T03', status: 'running' }],
      });
      expect(t.store.getTask('web:001-T03')?.status).toBe('running');
      expect(t.log.calls.filter((c) => c.port === 'store').map((c) => c.method)).not.toContain('transaction');
    });
  });

  it('imports specs/002-local-core of this repository from a fixture repo', async () => {
    const t = setup(loaded('roster'));
    const dir = new URL('../../../specs/002-local-core/', import.meta.url);
    for (const f of ['spec.md', 'plan.md', 'tasks.md']) {
      t.vcs.seedFile(t.project.project.repoPath, COMMIT, `specs/002-local-core/${f}`, readFileSync(new URL(f, dir), 'utf8'));
    }
    const result = await importFeature(t.deps, t.project, '002-local-core');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added.length).toBeGreaterThan(40);
    expect(t.store.getFeature('roster:002')).toMatchObject({ stage: 'execution', slug: 'local-core' });
    expect(t.store.getTask('roster:002-T01')?.status).toBe('done');
    expect(t.store.listFeatureEvents('roster:002')).toHaveLength(4);
  });
});
