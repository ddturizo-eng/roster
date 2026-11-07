import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLock, guardLockOnExit } from '../../src/cli/lock.ts';
import { currentWindowStart } from '../../src/cli/night-window.ts';
import { parseNightWindow } from '../../src/cli/config.ts';
import type { NightWindow } from '../../src/cli/config.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe('file lock', () => {
  it('takes a free lock, writes the PID and removes the file on release', () => {
    const path = join(dir, 'nested', 'run.lock');
    const lock = createFileLock({ path, pid: 100, isProcessAlive: alive([]) });
    expect(lock.acquire()).toEqual({ kind: 'acquired' });
    expect((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid).toBe(100);
    lock.release();
    expect(existsSync(path)).toBe(false);
    lock.release();
  });

  it('reports busy with the holder PID when the holder is alive, and leaves the file alone', () => {
    const path = join(dir, 'run.lock');
    writeFileSync(path, '{"pid":200}');
    const lock = createFileLock({ path, pid: 100, isProcessAlive: alive([200]) });
    expect(lock.acquire()).toEqual({ kind: 'busy', pid: 200 });
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe('{"pid":200}');
  });

  it.each([['a dead holder', '{"pid":200}'], ['unreadable content', 'garbage'], ['an invalid PID', '{"pid":"x"}']])(
    'takes over a stale lock: %s',
    (_name, content) => {
      const path = join(dir, 'run.lock');
      writeFileSync(path, content);
      const lock = createFileLock({ path, pid: 100, isProcessAlive: alive([]) });
      expect(lock.acquire()).toEqual({ kind: 'acquired' });
      expect((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid).toBe(100);
    },
  );

  it('does not remove a lock that another process took after ours', () => {
    const path = join(dir, 'run.lock');
    const lock = createFileLock({ path, pid: 100, isProcessAlive: alive([]) });
    lock.acquire();
    writeFileSync(path, '{"pid":300}');
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe('{"pid":300}');
  });
});

describe('guardLockOnExit', () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    return { emitter, exits, proc: Object.assign(emitter, { exit: (code: number) => void exits.push(code) }) };
  }
  function heldLock() {
    const path = join(dir, 'run.lock');
    const lock = createFileLock({ path, pid: 100, isProcessAlive: alive([]) });
    lock.acquire();
    return { lock, path };
  }

  it.each(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'])('removes the lock file on %s and exits 130', (signal) => {
    const { lock, path } = heldLock();
    const { proc, exits } = fakeProcess();
    guardLockOnExit(lock, proc);
    proc.emit(signal);
    expect(existsSync(path)).toBe(false);
    expect(exits).toEqual([130]);
  });

  it('removes the lock file on an uncaught exception, names only the error class and exits 1', () => {
    const { lock, path } = heldLock();
    const { proc, exits } = fakeProcess();
    const said: string[] = [];
    guardLockOnExit(lock, proc, { onUncaught: (name) => said.push(name) });
    proc.emit('uncaughtException', new TypeError('secret-ish detail'));
    expect(existsSync(path)).toBe(false);
    expect(exits).toEqual([1]);
    expect(said).toEqual(['TypeError']);
  });

  it('removes the lock file on process exit, and the returned function removes the handlers', () => {
    const { lock, path } = heldLock();
    const { proc, emitter } = fakeProcess();
    const remove = guardLockOnExit(lock, proc);
    expect(emitter.listenerCount('exit')).toBe(1);
    proc.emit('exit', 0);
    expect(existsSync(path)).toBe(false);
    remove();
    for (const event of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP', 'uncaughtException', 'exit']) {
      expect(emitter.listenerCount(event)).toBe(0);
    }
  });
});

describe('currentWindowStart', () => {
  const night = parseNightWindow('22:00-06:00') as NightWindow;
  const day = parseNightWindow('09:00-17:30') as NightWindow;
  const local = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min, 0, 0);

  it.each([
    ['evening, same day', night, local(11, 1, 23, 0), local(11, 1, 22, 0)],
    ['exactly at the start', night, local(11, 1, 22, 0), local(11, 1, 22, 0)],
    ['after midnight, window began the day before', night, local(11, 2, 3, 30), local(11, 1, 22, 0)],
    ['one minute before the end', night, local(11, 2, 5, 59), local(11, 1, 22, 0)],
    ['exactly at the end (closed)', night, local(11, 2, 6, 0), null],
    ['daytime', night, local(11, 2, 15, 0), null],
    ['same-day window, inside', day, local(11, 2, 12, 0), local(11, 2, 9, 0)],
    ['same-day window, after the end', day, local(11, 2, 17, 30), null],
    ['same-day window, before the start', day, local(11, 2, 8, 59), null],
  ])('%s', (_name, window, now, expected) => {
    expect(currentWindowStart(now, window)?.getTime() ?? null).toBe(expected?.getTime() ?? null);
  });
});
