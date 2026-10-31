// Runs the `gh` binary through `execFile` with an argument array (never a shell) and an allowlisted
// environment. Nothing from the parent environment reaches gh unless it is listed here, so `GH_*` and
// `GITHUB_*` variables of the Roster process (`GH_HOST`, `GH_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`,
// `GH_CONFIG_DIR`) and every other secret never leak into a gh child. The GitHub token is added per
// call as `GH_TOKEN` (ADR 0029); it is never an argument.

import { execFile } from 'node:child_process';
import { ExternalCommandError } from '../../../core/domain/errors.ts';

/** One gh invocation. `env` is the complete environment of the child. */
export interface GhCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /**
   * Working directory of the child. Always a trusted directory owned by Roster, never a work tree:
   * on Windows a bare program name is looked up in the current directory before `PATH`, and gh
   * reads git configuration from its current directory for some commands.
   */
  readonly cwd: string;
  /** Written to stdin, then stdin is closed. */
  readonly input?: string;
}

export interface GhOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs gh and resolves with its exit code and output, whatever the exit code. Rejects only when gh
 * could not run or was killed (timeout); the rejection never carries the arguments or environment.
 */
export type GhRunner = (call: GhCall) => Promise<GhOutput>;

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

/** Always set: gh never prompts, never checks for updates and prints no color codes. */
export const FIXED_ENV: Readonly<Record<string, string>> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

/**
 * The environment of every gh child: allowlisted parent values, FIXED_ENV, `GH_CONFIG_DIR` pointed at
 * a directory owned by Roster (so the human's own gh login, aliases and settings never apply) and the
 * token as `GH_TOKEN`.
 */
export function ghEnv(
  parent: Readonly<Record<string, string | undefined>>,
  configDir: string,
  token: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH_ENV) {
    const value = parent[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return { ...env, ...FIXED_ENV, GH_CONFIG_DIR: configDir, GH_TOKEN: token };
}

export interface ExecFileGhRunnerOptions {
  /** Program to run; defaults to `gh`, resolved through `PATH` (`gh.exe` on Windows). */
  readonly program?: string;
  /** Kill gh after this many milliseconds. Defaults to 2 minutes. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** The real runner: `execFile(program, args)` with `shell: false`. */
export function execFileGhRunner(options: ExecFileGhRunnerOptions = {}): GhRunner {
  const program = options.program ?? 'gh';
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
          reject(new ExternalCommandError('gh', null, reason));
        },
      );
      child.stdin?.on('error', () => {
        // A child that exits before reading stdin closes the pipe; the exit code reports the failure.
      });
      child.stdin?.end(call.input ?? '');
    });
}
