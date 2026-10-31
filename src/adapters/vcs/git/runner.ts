// Runs the `git` binary through `execFile` with an argument array (never a shell) and an allowlisted
// environment. Nothing from the parent environment reaches git unless it is listed here, so `GIT_*`
// variables (`GIT_DIR`, `GIT_CONFIG_PARAMETERS`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`), tokens and other
// secrets of the Roster process never leak into a git child.

import { execFile } from 'node:child_process';
import { ExternalCommandError } from '../../../core/domain/errors.ts';

/** One git invocation. `env` is the complete environment of the child. */
export interface GitCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /**
   * Working directory of the child. Always a trusted directory, never a work tree: on Windows a
   * bare program name is looked up in the current directory before `PATH`, so a `git.exe` planted
   * in a work tree would otherwise run on the host.
   */
  readonly cwd: string;
  /** Written to stdin, then stdin is closed. */
  readonly input?: string;
}

export interface GitOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs git and resolves with its exit code and output, whatever the exit code. Rejects only when git
 * could not run or was killed (timeout); the rejection never carries the arguments or environment.
 */
export type GitRunner = (call: GitCall) => Promise<GitOutput>;

/** Variables copied from the parent environment when present (Windows and POSIX basics, proxies). */
export const PASS_THROUGH_ENV = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
] as const;

/** Always set: git never prompts for credentials or anything else. */
export const FIXED_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0' };

/** The environment of every git child: allowlisted parent values plus FIXED_ENV and `extra`. */
export function gitEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH_ENV) {
    const value = parent[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return { ...env, ...FIXED_ENV, ...extra };
}

export interface ExecFileRunnerOptions {
  /** Program to run; defaults to `git`, resolved through `PATH` (`git.exe` on Windows). */
  readonly program?: string;
  /** Kill git after this many milliseconds. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;

/** The real runner: `execFile(program, args)` with `shell: false`. */
export function execFileGitRunner(options: ExecFileRunnerOptions = {}): GitRunner {
  const program = options.program ?? 'git';
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (call) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        program,
        [...call.args],
        { env: { ...call.env }, cwd: call.cwd, shell: false, windowsHide: true, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          if (typeof error.code === 'number' && !error.killed) {
            resolve({ exitCode: error.code, stdout, stderr });
            return;
          }
          const reason = error.killed
            ? `killed after ${Math.round(timeout / 1000)} s`
            : `could not run (${typeof error.code === 'string' ? error.code : 'unknown error'})`;
          reject(new ExternalCommandError('git', null, reason));
        },
      );
      child.stdin?.on('error', () => {
        // A child that exits before reading stdin closes the pipe; the exit code reports the failure.
      });
      child.stdin?.end(call.input ?? '');
    });
}
