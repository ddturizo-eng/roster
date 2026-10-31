// Runs Windows PowerShell 5.1 (`powershell.exe`) through `execFile` with an argument array, never a
// shell. The script is fixed text passed as `-EncodedCommand`; secret values travel only through stdin
// (ADR 0016, ADR 0029) and never through arguments, environment variables or files.

import { execFile } from 'node:child_process';
import { ExternalCommandError } from '../../../core/domain/errors.ts';

export interface PowerShellCall {
  /** Full argument list of powershell.exe. */
  readonly args: readonly string[];
  /** Written to stdin, then stdin is closed. */
  readonly input: string;
}

export interface PowerShellOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs powershell.exe and resolves with its exit code and output, whatever the exit code. Rejects only
 * when it could not run or was killed; the rejection never carries the arguments or the input.
 */
export type PowerShellRunner = (call: PowerShellCall) => Promise<PowerShellOutput>;

export interface ExecFilePowerShellRunnerOptions {
  /** Program to run; defaults to `powershell.exe`. */
  readonly program?: string;
  /** Kill the child after this many milliseconds. Defaults to 1 minute. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER = 1024 * 1024;

export function execFilePowerShellRunner(options: ExecFilePowerShellRunnerOptions = {}): PowerShellRunner {
  const program = options.program ?? 'powershell.exe';
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (call) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        program,
        [...call.args],
        { shell: false, windowsHide: true, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
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
          reject(new ExternalCommandError('powershell.exe', null, reason));
        },
      );
      child.stdin?.on('error', () => {
        // A child that exits before reading stdin closes the pipe; the exit code reports the failure.
      });
      child.stdin?.end(call.input);
    });
}
