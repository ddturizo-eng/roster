// Global run lock (ADR 0015): `%LOCALAPPDATA%\Roster\run.lock` holds the PID of the process that runs
// agents. A lock held by a dead process is stale and is taken over. The lock is released on every exit
// path: normal return (the caller's `finally`), Ctrl+C and other termination signals, an uncaught
// error, and process exit as the last safety net. Only a hard kill (SIGKILL, power loss) leaves a lock
// behind, and the next run treats it as stale because its PID is dead.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LockResult = { readonly kind: 'acquired' } | { readonly kind: 'busy'; readonly pid: number };

export interface RunLock {
  acquire(): LockResult;
  /** Synchronous and idempotent, so it is safe inside signal and exit handlers. */
  release(): void;
}

export interface FileLockOptions {
  readonly path: string;
  readonly pid: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly now?: () => Date;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** PID stored in a lock file, or undefined when the file is missing or unreadable. */
function readHolder(path: string): number | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const pid = typeof value === 'object' && value !== null && 'pid' in value ? value.pid : undefined;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function createFileLock(options: FileLockOptions): RunLock {
  const { path, pid, isProcessAlive } = options;
  const now = options.now ?? (() => new Date());
  let held = false;
  return {
    acquire() {
      mkdirSync(dirname(path), { recursive: true });
      const content = `${JSON.stringify({ pid, startedAt: now().toISOString() })}\n`;
      let holder: number | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          writeFileSync(path, content, { flag: 'wx' });
          held = true;
          return { kind: 'acquired' };
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        holder = readHolder(path);
        if (holder !== undefined && holder !== pid && isProcessAlive(holder)) return { kind: 'busy', pid: holder };
        // Stale (dead holder) or unreadable: take it over and try once more.
        rmSync(path, { force: true });
      }
      return { kind: 'busy', pid: holder ?? 0 };
    },
    release() {
      if (!held) return;
      held = false;
      // Remove only a lock that is still ours.
      if (readHolder(path) === pid) rmSync(path, { force: true });
    },
  };
}

/** The part of `process` the exit guard needs; tests pass an EventEmitter-based stand-in. */
export interface ProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  exit(code: number): unknown;
}

export interface ExitGuardOptions {
  /** Prints the last words of an uncaught error; receives the error class name only. */
  readonly onUncaught?: (name: string) => void;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;

/**
 * Releases `lock` on Ctrl+C and other termination signals (exit code 130), on an uncaught exception
 * (exit code 1) and on process exit. Returns a function that removes the handlers.
 */
export function guardLockOnExit(lock: Pick<RunLock, 'release'>, proc: ProcessLike, options: ExitGuardOptions = {}): () => void {
  const registered: [string, (...args: any[]) => void][] = [];
  const add = (event: string, listener: (...args: any[]) => void): void => {
    proc.on(event, listener);
    registered.push([event, listener]);
  };
  for (const signal of SIGNALS) {
    add(signal, () => {
      lock.release();
      proc.exit(130);
    });
  }
  add('uncaughtException', ((error: unknown) => {
    lock.release();
    options.onUncaught?.(error instanceof Error ? error.name : 'Error');
    proc.exit(1);
  }) as (...args: any[]) => void);
  add('exit', () => {
    lock.release();
  });
  return () => {
    for (const [event, listener] of registered) proc.off(event, listener);
  };
}
