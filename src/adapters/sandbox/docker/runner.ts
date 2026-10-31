// Runs the `docker` CLI through `execFile` and `spawn` with argument arrays (never a shell) and an
// allowlisted environment. Nothing from the parent environment reaches docker unless it is listed
// here, so `GH_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and every other secret or proxy
// setting of the Roster process never reach a docker child. A job run adds the container's
// environment values to its own child only (isolation.ts); docker forwards them by name.

import { execFile, spawn } from 'node:child_process';
import { ExternalCommandError } from '../../../core/domain/errors.ts';

/** One short docker command (network, create, rm, kill, ps, info). `env` is the complete environment. */
export interface DockerCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /**
   * Working directory of the child. Always a trusted directory, never a work tree: on Windows a bare
   * program name is looked up in the current directory before `PATH`.
   */
  readonly cwd: string;
  /** Kill the child after this many milliseconds. */
  readonly timeoutMs: number;
}

export interface DockerOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One long-running docker command whose output is streamed (`docker run -i`, `docker start -a`). */
export interface DockerStreamCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Written to stdin, then stdin is closed. */
  readonly input: string;
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
}

export interface DockerChild {
  /**
   * Resolves with the exit code (null when the child was ended by a signal) after stdout and stderr
   * are fully delivered. Rejects with ExternalCommandError when docker could not start.
   */
  readonly exited: Promise<number | null>;
  /** Ends the docker CLI process. The container itself is stopped by name (`docker kill`). */
  kill(): void;
}

export interface DockerRunner {
  /**
   * Resolves with the exit code and output, whatever the exit code. Rejects only when docker could
   * not run or was killed at its timeout; the rejection never carries the arguments or environment.
   */
  exec(call: DockerCall): Promise<DockerOutput>;
  spawn(call: DockerStreamCall): DockerChild;
}

/**
 * Variables copied from the parent environment when present: Windows and POSIX basics and the
 * docker CLI's own connection settings. No proxy, token or credential variable.
 */
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
  'PROGRAMFILES',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
] as const;

/** Always set: no CLI hints and no color codes in the output Roster logs. */
export const FIXED_ENV: Readonly<Record<string, string>> = { DOCKER_CLI_HINTS: 'false', NO_COLOR: '1' };

/** The environment of every docker child: allowlisted parent values, FIXED_ENV, then `extra`. */
export function dockerEnv(
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

export interface ExecFileDockerRunnerOptions {
  /** Program to run; defaults to `docker`, resolved through `PATH` (`docker.exe` on Windows). */
  readonly program?: string;
}

const MAX_BUFFER = 16 * 1024 * 1024;

/** The real runner: `execFile` and `spawn` of `program` with `shell: false`. */
export function execFileDockerRunner(options: ExecFileDockerRunnerOptions = {}): DockerRunner {
  const program = options.program ?? 'docker';
  return {
    exec: (call) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          program,
          [...call.args],
          {
            env: { ...call.env },
            cwd: call.cwd,
            shell: false,
            windowsHide: true,
            timeout: call.timeoutMs,
            maxBuffer: MAX_BUFFER,
            encoding: 'utf8',
          },
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
              ? `killed after ${Math.round(call.timeoutMs / 1000)} s`
              : `could not run (${typeof error.code === 'string' ? error.code : 'unknown error'})`;
            reject(new ExternalCommandError('docker', null, reason));
          },
        );
        child.stdin?.on('error', () => {
          // A child that exits before reading stdin closes the pipe; the exit code reports the failure.
        });
        child.stdin?.end();
      }),

    spawn: (call) => {
      const child = spawn(program, [...call.args], {
        env: { ...call.env },
        cwd: call.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          reject(new ExternalCommandError('docker', null, `could not run (${typeof error.code === 'string' ? error.code : 'unknown error'})`));
        });
        // `close` fires after the stdio streams ended, so every chunk was delivered before it.
        child.once('close', (code) => resolve(code));
      });
      child.stdout.on('data', (chunk: Buffer) => call.onStdout(chunk));
      child.stderr.on('data', (chunk: Buffer) => call.onStderr(chunk));
      child.stdin.on('error', () => {
        // Same as above: a closed pipe is reported through the exit code.
      });
      child.stdin.end(call.input);
      return {
        exited,
        kill: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        },
      };
    },
  };
}
