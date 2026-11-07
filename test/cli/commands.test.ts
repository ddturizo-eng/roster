// `roster feature import` and `roster sync` with fakes.

import { describe, expect, it } from 'vitest';
import { runFeature } from '../../src/cli/commands/feature.ts';
import { runSyncCommand } from '../../src/cli/commands/sync.ts';
import { machine, ROSTER, task, WEB } from './support.ts';

const TASKS_MD = `# Tasks 001 - Thing

## T01. First

- [ ] Done
- Depends on: none
- Profile: TS core
- Agent: dev
- Areas: src/
- Acceptance criteria:
  - It works.
- Verification: run tests.

## T02. Second

- [x] Done
- Depends on: T01
- Profile: TS core
- Agent: dev
- Areas: src/
- Acceptance criteria:
  - It works too.
- Verification: run tests.
`;

function setupImport() {
  const m = machine();
  m.vcs.seedRef(WEB, 'origin/develop', 'dev1111');
  for (const file of ['spec.md', 'plan.md', 'tasks.md']) {
    m.vcs.seedFile(WEB, 'dev1111', `specs/002-other/${file}`, file === 'tasks.md' ? TASKS_MD : '# x');
  }
  m.log.clear();
  const deps = { vcs: m.vcs, store: m.store, clock: m.clock, rosterRepoPath: ROSTER, console: m.console };
  return { ...m, deps };
}

describe('roster feature import', () => {
  it('fetches the Roster repo, reads registrations, fetches the project, then imports from origin/<baseBranch>', async () => {
    const { deps, log, store, console } = setupImport();
    expect(await runFeature(['import', 'web', '002-other'], deps)).toBe(0);
    expect(log.of('vcs').filter((c) => c.method === 'fetch').map((c) => c.args[0])).toEqual([ROSTER, WEB]);
    const reads = log.of('vcs').filter((c) => c.method === 'resolveRef');
    expect(reads.map((c) => c.args)).toEqual([
      [ROSTER, 'origin/main'],
      [WEB, 'origin/develop'],
    ]);
    expect(store.getFeature('web:002')?.stage).toBe('execution');
    expect(store.listTasks({ featureId: 'web:002' }).map((t) => [t.key, t.status])).toEqual([
      ['T01', 'todo'],
      ['T02', 'done'],
    ]);
    expect(console.stdout[0]).toBe('Imported web:002 from commit dev1111.');
    expect(console.stdout).toContain('  added: T01, T02');
    expect(console.stdout).toContain('  added already done: T02');
  });

  it('rejects an unregistered project with exit 1 and imports nothing', async () => {
    const { deps, log, console } = setupImport();
    expect(await runFeature(['import', 'ghost', '002-other'], deps)).toBe(1);
    expect(console.stderr[0]).toContain('Project ghost is not registered');
    expect(log.names()).not.toContain('store.createFeature');
  });

  it('reports files missing on the base branch', async () => {
    const { deps, console, store } = setupImport();
    expect(await runFeature(['import', 'web', '003-none'], deps)).toBe(1);
    expect(console.stderr[0]).toContain('Not on origin/develop: specs/003-none/spec.md');
    expect(store.getFeature('web:003')).toBeUndefined();
  });

  it('reports tasks.md errors with line numbers', async () => {
    const { deps, console, vcs } = setupImport();
    vcs.seedFile(WEB, 'dev1111', 'specs/002-other/tasks.md', 'not a tasks file\n## T01. Only\n');
    expect(await runFeature(['import', 'web', '002-other'], deps)).toBe(1);
    expect(console.stderr[0]).toBe('tasks.md has errors:');
    expect(console.stderr[1]).toMatch(/^ {2}line \d+/);
  });

  it.each([[[]], [['import']], [['import', 'web']], [['export', 'web', '002-other']], [['import', 'web', '002-other', 'x']]])(
    'prints usage and exits 1 for arguments %j',
    async (args) => {
      const { deps, console, log } = setupImport();
      expect(await runFeature(args, deps)).toBe(1);
      expect(console.stderr).toEqual(['Usage: roster feature import <project> <NNN-slug>']);
      expect(log.names()).toEqual(['console.printError']);
    },
  );
});

describe('roster sync', () => {
  it('fetches, refreshes registrations and applies a merged pull request', async () => {
    const m = machine([
      {
        ...task('T01', 1),
        status: 'in_review',
        prNumber: 11,
        prUrl: 'https://github.com/acme/web/pull/11',
      },
    ]);
    m.forge.responses.queue('prState', { state: 'merged', mergedAt: '2026-11-01T01:00:00Z' });
    const deps = { vcs: m.vcs, store: m.store, clock: m.clock, forge: m.forge, language: 'en' as const, rosterRepoPath: ROSTER, console: m.console };
    expect(await runSyncCommand([], deps)).toBe(0);
    expect(m.store.getTask('web:001-T01')?.status).toBe('done');
    expect(m.console.stdout).toEqual([
      'Synced 2 project(s) at reg1234; 1 pull request(s) checked.',
      'web:001-T01: pull request merged, task done.',
    ]);
  });

  it('lists a failed pull request lookup and still exits 0', async () => {
    const m = machine([{ ...task('T01', 1), status: 'in_review', prNumber: 11 }]);
    m.forge.responses.queueError('prState', new Error('gh offline'));
    const deps = { vcs: m.vcs, store: m.store, clock: m.clock, forge: m.forge, language: 'en' as const, rosterRepoPath: ROSTER, console: m.console };
    expect(await runSyncCommand([], deps)).toBe(0);
    expect(m.console.stderr[0]).toContain('pr web:001-T01');
  });

  it('exits 1 when the Roster repo cannot be fetched', async () => {
    const m = machine();
    m.vcs.responses.queueError('fetch', new Error('offline'));
    const deps = { vcs: m.vcs, store: m.store, clock: m.clock, forge: m.forge, language: 'en' as const, rosterRepoPath: ROSTER, console: m.console };
    expect(await runSyncCommand([], deps)).toBe(1);
    expect(m.console.stderr[0]).toContain('Sync failed');
  });

  it('prints usage for extra arguments', async () => {
    const m = machine();
    const deps = { vcs: m.vcs, store: m.store, clock: m.clock, forge: m.forge, language: 'en' as const, rosterRepoPath: ROSTER, console: m.console };
    expect(await runSyncCommand(['now'], deps)).toBe(1);
    expect(m.console.stderr).toEqual(['Usage: roster sync']);
  });
});
