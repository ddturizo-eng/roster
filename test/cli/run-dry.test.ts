import { describe, expect, it } from 'vitest';
import { runRun } from '../../src/cli/commands/run.ts';
import type { RunCommandDeps } from '../../src/cli/commands/run.ts';
import { parseNightWindow } from '../../src/cli/config.ts';
import { machine, ROSTER, task, WEB } from './support.ts';

function setup(tasks = [task('T01', 1)], edges: { taskId: string; dependsOnId: string }[] = []) {
  const m = machine(tasks, edges);
  const deps: RunCommandDeps = {
    vcs: m.vcs,
    store: m.store,
    clock: m.clock,
    forge: m.forge,
    sandbox: m.sandbox,
    fs: m.fs,
    secrets: m.secrets,
    console: m.console,
    language: 'en',
    rosterRepoPath: ROSTER,
    logRoot: 'C:\\roster-data\\logs',
    commitAuthor: { name: 'Roster', email: 'roster@example.invalid' },
    pid: 4242,
    quotaCooldownMinutes: 300,
    maxRunsPerNight: 5,
    nightWindow: parseNightWindow('22:00-06:00') as NonNullable<ReturnType<typeof parseNightWindow>>,
    lock: m.lock,
    isProcessAlive: () => false,
    runtimeFor: () => m.runtime,
  };
  return { ...m, deps };
}

describe('roster run --dry-run', () => {
  it('prints the sync result, the selected unit and the planned steps (snapshot)', async () => {
    const { deps, console } = setup();
    expect(await runRun(['--dry-run'], deps)).toBe(0);
    expect(console.stdout).toMatchInlineSnapshot(`
      [
        "Dry run: nothing is written except the sync cache.",
        "Syncing the Roster repo, projects and pull requests...",
        "Sync done: 2 projects, 0 pull requests checked.",
        "Selected task web:001-T01: Title T01",
        "Planned steps: workspace, agent, policy, commit, push, pr.",
      ]
    `);
    expect(console.stderr).toEqual([]);
  });

  it('writes nothing but the registration cache: no lock, no recovery, no execution, no task change, no sandbox run, no push', async () => {
    const { deps, log, store } = setup();
    const before = JSON.stringify(store.listTasks());
    await runRun(['--dry-run'], deps);
    const names = log.names();
    expect(names.filter((n) => n.startsWith('lock.'))).toEqual([]);
    expect(names.filter((n) => n.startsWith('store.') && !['store.transaction', 'store.upsertProject'].includes(n) && !/^store\.(list|get)/.test(n))).toEqual([]);
    expect(names.filter((n) => n.startsWith('sandbox.') && n !== 'sandbox.available')).toEqual([]);
    expect(names.filter((n) => n.startsWith('workspace.') || n === 'vcs.createWorkspace' || n === 'forge.ensurePr')).toEqual([]);
    expect(names.filter((n) => n.startsWith('fs.') || n.startsWith('secrets.'))).toEqual([]);
    expect(log.of('vcs').filter((c) => c.method === 'fetch').map((c) => c.args[0])).toEqual([ROSTER, WEB]);
    expect(JSON.stringify(store.listTasks())).toBe(before);
    expect(store.listExecutions({})).toEqual([]);
  });

  it('counts a task whose pull request is merged as done for the selection, without applying it', async () => {
    const t1 = task('T01', 1, { status: 'in_review', prNumber: 11, prUrl: 'https://github.com/acme/web/pull/11' });
    const t2 = task('T02', 2);
    const { deps, store, forge, console, log } = setup([t1, t2], [{ taskId: 'web:001-T02', dependsOnId: 'web:001-T01' }]);
    forge.responses.queue('prState', { state: 'merged', mergedAt: '2026-11-01T01:00:00Z' });
    await runRun(['--dry-run'], deps);
    expect(log.of('forge').map((c) => c.method)).toEqual(['prState']);
    expect(store.getTask('web:001-T01')?.status).toBe('in_review');
    expect(console.stdout.join('\n')).toContain('Selected task web:001-T02');
  });

  it('reports nothing to do and still exits 0 when no task is ready', async () => {
    const { deps, console } = setup([]);
    expect(await runRun(['--dry-run'], deps)).toBe(0);
    expect(console.stdout.at(-1)).toMatch(/nothing/i);
  });

  it('exits 2 when Docker is unavailable, like a real run', async () => {
    const { deps, sandbox } = setup();
    sandbox.responses.queue('available', { available: false, reason: 'down' });
    expect(await runRun(['--dry-run'], deps)).toBe(2);
  });
});
