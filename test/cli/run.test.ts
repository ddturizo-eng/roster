import { describe, expect, it } from 'vitest';
import { runRun } from '../../src/cli/commands/run.ts';
import type { RunCommandDeps } from '../../src/cli/commands/run.ts';
import { parseNightWindow } from '../../src/cli/config.ts';
import { ExternalCommandError } from '../../src/core/domain/errors.ts';
import { machine, ROSTER, task, WEB } from './support.ts';

const NIGHT = parseNightWindow('22:00-06:00') as NonNullable<ReturnType<typeof parseNightWindow>>;

function setup(tasks = [task('T01', 1)], overrides: Partial<RunCommandDeps> = {}) {
  const m = machine(tasks);
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
    maxRunsPerNight: 2,
    nightWindow: NIGHT,
    lock: m.lock,
    isProcessAlive: () => false,
    runtimeFor: () => m.runtime,
    ...overrides,
  };
  return { ...m, deps };
}

function startExecution(store: ReturnType<typeof machine>['store'], startedAt: string, pid: number | null = null) {
  return store.startExecution({
    taskId: 'web:001-T01',
    featureId: 'web:001',
    jobKind: 'specialist',
    agentSlug: 'dev',
    runtime: 'claude-code',
    startedAt,
    pid,
  });
}

describe('roster run', () => {
  it('rejects unknown arguments with usage and exit 1, before taking the lock', async () => {
    const { deps, log, console } = setup();
    expect(await runRun(['--now'], deps)).toBe(1);
    expect(console.stderr).toEqual(['Usage: roster run [--dry-run]']);
    expect(log.names()).toEqual(['console.printError']);
  });

  it('exits 0 with the holder PID when the lock is busy, and does nothing else', async () => {
    const { deps, log, lock, console } = setup();
    lock.busyPid = 777;
    expect(await runRun([], deps)).toBe(0);
    expect(log.names()).toEqual(['lock.acquire', 'console.print']);
    expect(console.stdout[0]).toContain('777');
  });

  it('exits 0 when the night limit is reached, after recovery, without Docker, sync or push; releases the lock', async () => {
    const { deps, log, store, console, lock } = setup();
    startExecution(store, new Date(2026, 10, 1, 22, 10).toISOString());
    startExecution(store, new Date(2026, 10, 1, 22, 20).toISOString());
    // Before the window opened: not counted.
    startExecution(store, new Date(2026, 9, 31, 21, 0).toISOString());
    log.clear();
    // The three seeded executions have no PID: recovery marks them interrupted first, but they still
    // count as started in the window.
    expect(await runRun([], deps)).toBe(0);
    expect(log.names()).toContain('lock.acquire');
    expect(log.names().at(-1)).toBe('lock.release');
    expect(log.names().filter((n) => n.startsWith('sandbox.') && n !== 'sandbox.kill')).toEqual([]);
    expect(log.names()).not.toContain('vcs.fetch');
    expect(log.names()).not.toContain('workspace.push');
    expect(console.stdout.at(-1)).toContain('2');
    expect(lock.held).toBe(false);
  });

  it('does not apply the night limit outside the window', async () => {
    const { deps, clock, store, console } = setup();
    clock.set(new Date(2026, 10, 1, 15, 0).toISOString());
    startExecution(store, new Date(2026, 10, 1, 14, 0).toISOString());
    startExecution(store, new Date(2026, 10, 1, 14, 30).toISOString());
    expect(await runRun([], deps)).toBe(0);
    expect(console.stdout.join('\n')).not.toMatch(/limit/i);
  });

  it('exits 2 when Docker is unavailable, before sync, and releases the lock', async () => {
    const { deps, log, sandbox, console, lock } = setup();
    sandbox.responses.queue('available', { available: false, reason: 'daemon not running' });
    expect(await runRun([], deps)).toBe(2);
    expect(log.names()).toEqual([
      'lock.acquire',
      'store.listExecutions',
      'clock.now',
      'store.listExecutions',
      'sandbox.available',
      'console.printError',
      'lock.release',
    ]);
    expect(console.stderr[0]).toContain('daemon not running');
    expect(log.names()).not.toContain('vcs.fetch');
    expect(lock.held).toBe(false);
  });

  it('recovers interrupted executions before anything else, using the injected liveness probe', async () => {
    const probed: number[] = [];
    const { deps, log, store } = setup(undefined, {
      isProcessAlive: (pid: number) => {
        probed.push(pid);
        return pid === 222;
      },
    });
    const dead = startExecution(store, '2026-11-01T01:00:00.000Z', 111);
    const alive = startExecution(store, '2026-11-01T01:05:00.000Z', 222);
    log.clear();
    expect(await runRun([], deps)).toBe(0);
    expect(probed.sort()).toEqual([111, 222]);
    expect(log.names().slice(0, 2)).toEqual(['lock.acquire', 'store.listExecutions']);
    expect(log.of('sandbox').filter((c) => c.method === 'kill').map((c) => c.args[0])).toEqual([dead.id]);
    expect(store.getExecution(dead.id)?.status).toBe('interrupted');
    expect(store.getExecution(alive.id)?.status).toBe('running');
  });

  it('syncs, loads the policy from origin/main and hands one unit to the pipeline (task without agent is blocked)', async () => {
    const { deps, log, store, console, lock } = setup();
    expect(await runRun([], deps)).toBe(0);
    const names = log.names();
    expect(names.indexOf('lock.acquire')).toBeLessThan(names.indexOf('sandbox.available'));
    expect(names.indexOf('sandbox.available')).toBeLessThan(names.indexOf('vcs.fetch'));
    expect(log.of('vcs').filter((c) => c.method === 'fetch').map((c) => c.args[0])).toEqual([ROSTER, WEB]);
    expect(log.of('vcs').filter((c) => c.method === 'showFile').some((c) => c.args[2] === 'policies/mvp.json')).toBe(true);
    expect(store.getTask('web:001-T01')?.status).toBe('blocked');
    expect(names.at(-1)).toBe('lock.release');
    expect(console.stdout.join('\n')).toContain('web:001-T01');
    expect(lock.held).toBe(false);
    expect(names).not.toContain('workspace.push');
  });

  it('exits 0 with nothing to do when no task is ready', async () => {
    const { deps, console } = setup([]);
    expect(await runRun([], deps)).toBe(0);
    expect(console.stdout.at(-1)).toMatch(/nothing/i);
  });

  it('treats a typed Roster error (a failed fetch) as handled: exit 0, error shown, lock released', async () => {
    const { deps, vcs, console, lock, log } = setup();
    vcs.responses.queueError('fetch', new ExternalCommandError('git', 128, 'network unreachable'));
    expect(await runRun([], deps)).toBe(0);
    expect(console.stderr.join('\n')).toContain('ExternalCommandError');
    expect(log.names().at(-1)).toBe('lock.release');
    expect(lock.held).toBe(false);
  });

  it('rethrows a bug (an error that is not a RosterError) and still releases the lock', async () => {
    const { deps, vcs, lock } = setup();
    vcs.responses.queueError('fetch', new TypeError('bug'));
    await expect(runRun([], deps)).rejects.toThrow('bug');
    expect(lock.held).toBe(false);
  });
});
