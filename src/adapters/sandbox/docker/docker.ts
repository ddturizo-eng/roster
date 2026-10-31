// Docker sandbox adapter (SandboxPort, ADR 0023, ADR 0031, plan 002 sections 9 and 13).
//
// `run` of one job:
// 1. validates the request and builds every docker command through `isolation.ts` (protected),
//    before anything is written or started;
// 2. writes the invocation's files into the job's `in` directory;
// 3. for profiles with network: removes a stale proxy and network of the same execution, creates the
//    `--internal` network, creates the egress proxy on it, connects the proxy to the default bridge,
//    starts it and waits for its `listening` line; its log goes to `<log_dir>\proxy.log`;
// 4. runs the job container with `docker run -i`, the stdin file on stdin, stdout to
//    `<log_dir>\<job>.jsonl` (agent, review) or `<job>.log` (setup, verify) and stderr to
//    `<log_dir>\<job>.stderr.log`, line by line with secret redaction (log-writer.ts);
// 5. at the timeout kills the container by name (`docker kill`), not through the docker CLI process;
// 6. always, also on errors: removes the proxy and the network, and closes the logs.
//
// `<log_dir>` is the directory of `request.logPath`, which must be the job's stdout file. Secret
// values reach only the environment of the `docker run` child (runner.ts, isolation.ts); they are
// never an argument, and are redacted from every log line and every error message.

import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { ExternalCommandError } from '../../../core/domain/errors.ts';
import type { JobProfile } from '../../../core/domain/execution.ts';
import type { ContainerExit, ContainerInvocation } from '../../../core/domain/runtime.ts';
import type { SandboxAvailability, SandboxPort, SandboxRunRequest } from '../../../ports/sandbox.ts';
import { SandboxInputError } from './errors.ts';
import {
  MANAGED_SETTINGS_FILE,
  PROFILES,
  checkImage,
  containerPrefix,
  isExecutionContainer,
  jobContainerName,
  jobRunCommand,
  networkCreateCommand,
  networkName,
  proxyConnectCommand,
  proxyContainerName,
  proxyCreateCommand,
  proxyStartCommand,
} from './isolation.ts';
import type { DockerCommand } from './isolation.ts';
import { LineLogWriter } from './log-writer.ts';
import { secretRedactor } from './redact.ts';
import { dockerEnv, execFileDockerRunner } from './runner.ts';
import type { DockerChild, DockerOutput, DockerRunner } from './runner.ts';

/** `docker info` timeout (plan 002 section 13). */
export const AVAILABLE_TIMEOUT_MS = 20_000;

/** Timeout of every short docker command (network, create, rm, kill, ps). */
export const COMMAND_TIMEOUT_MS = 60_000;

/** Name of the proxy's log file in the job's log directory (plan 002 section 4.5). */
export const PROXY_LOG = 'proxy.log';

const IN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type Redact = (text: string) => string;

export interface DockerSandboxOptions {
  /** `roster/egress-proxy:<roster-commit>`, built by the pinned install. */
  readonly proxyImage: string;
  /** Defaults to `execFileDockerRunner()`. Tests pass a stub. */
  readonly runner?: DockerRunner;
  /** Environment the allowlist is taken from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Working directory of every docker child: a trusted directory, never a work tree. Defaults to the
   * directory of the Node executable.
   */
  readonly cwd?: string;
  /** More secret values to redact from logs and errors (the GitHub token), besides `envValues`. */
  readonly redactValues?: readonly string[];
  /** Defaults to the system clock. */
  readonly now?: () => Date;
  /** How long to wait for the proxy's `listening` line. Defaults to 30 s. */
  readonly proxyStartTimeoutMs?: number;
  /** How long to wait for a killed container's `docker` process to end. Defaults to 30 s. */
  readonly killGraceMs?: number;
  /** Receives cleanup problems that do not fail the job (already redacted). Defaults to nothing. */
  readonly warn?: (message: string) => void;
}

interface ActiveRun {
  stopRequested: boolean;
}

interface ProxyHandle {
  child?: DockerChild;
  log?: LineLogWriter;
}

/** Log file names of one job (ADR 0031): `<job>.jsonl` for runtime jobs, else `<job>.log`. */
export function jobLogFiles(profile: JobProfile, job: string): { readonly stdout: string; readonly stderr: string } {
  const runtimeJob = profile === 'agent' || profile === 'review';
  return { stdout: `${job}.${runtimeJob ? 'jsonl' : 'log'}`, stderr: `${job}.stderr.log` };
}

/** True for the proxy's `{"event":"listening",...}` line. */
export function isListeningLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && (parsed as { event?: unknown }).event === 'listening';
  } catch {
    return false;
  }
}

/** Last non-empty line of a command's error output, redacted, without control characters, cut. */
function summarize(text: string, redact: Redact): string {
  const lines = redact(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1) ?? 'no error output';
  return last.length > 300 ? `${last.slice(0, 300)}...` : last;
}

function checkInFiles(invocation: ContainerInvocation): void {
  if (!Array.isArray(invocation.inFiles)) throw new SandboxInputError('in files', 'must be a list');
  const seen = new Set<string>();
  for (const file of invocation.inFiles) {
    if (typeof file.name !== 'string' || !IN_FILE_NAME.test(file.name) || file.name.includes('..')) {
      throw new SandboxInputError('in file name', 'must be a plain file name');
    }
    // Windows file names ignore case.
    if (seen.has(file.name.toLowerCase())) throw new SandboxInputError('in file name', 'must be unique');
    if (typeof file.content !== 'string') throw new SandboxInputError('in file content', 'must be text');
    seen.add(file.name.toLowerCase());
  }
}

function stdinOf(invocation: ContainerInvocation): string {
  if (invocation.stdinFile === undefined) return '';
  const file = invocation.inFiles.find((entry) => entry.name === invocation.stdinFile);
  if (file === undefined) throw new SandboxInputError('stdin file', 'must name one of the invocation files');
  return file.content;
}

function sleep(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    // Unreferenced: a pending wait never keeps the process alive after the job ended.
    setTimeout(() => resolve('timeout'), ms).unref();
  });
}

function settled(child: DockerChild): Promise<'done'> {
  return child.exited.then(
    () => 'done',
    () => 'done',
  );
}

export class DockerSandbox implements SandboxPort {
  readonly #proxyImage: string;
  readonly #runner: DockerRunner;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #cwd: string;
  readonly #redactValues: readonly string[];
  readonly #now: () => Date;
  readonly #proxyStartTimeoutMs: number;
  readonly #killGraceMs: number;
  readonly #warn: (message: string) => void;
  readonly #active = new Map<string, ActiveRun>();

  constructor(options: DockerSandboxOptions) {
    this.#proxyImage = checkImage(options.proxyImage, 'proxy image');
    this.#runner = options.runner ?? execFileDockerRunner();
    this.#env = options.env ?? process.env;
    this.#cwd = options.cwd ?? dirname(process.execPath);
    if (!isAbsolute(this.#cwd)) throw new SandboxInputError('working directory', 'must be an absolute path');
    this.#redactValues = (options.redactValues ?? []).filter((value) => typeof value === 'string' && value.length > 0);
    this.#now = options.now ?? (() => new Date());
    this.#proxyStartTimeoutMs = options.proxyStartTimeoutMs ?? 30_000;
    this.#killGraceMs = options.killGraceMs ?? 30_000;
    this.#warn = options.warn ?? (() => undefined);
  }

  async available(): Promise<SandboxAvailability> {
    const redact = secretRedactor(this.#redactValues);
    try {
      const output = await this.#exec(['info', '--format', '{{.ServerVersion}}'], AVAILABLE_TIMEOUT_MS);
      if (output.exitCode === 0) return { available: true };
      return { available: false, reason: `docker info exited with ${output.exitCode}: ${summarize(output.stderr, redact)}` };
    } catch (error) {
      return { available: false, reason: summarize(error instanceof Error ? error.message : 'docker info failed', redact) };
    }
  }

  async run(request: SandboxRunRequest): Promise<ContainerExit> {
    // 1. Validate and build everything before any side effect.
    const rules = PROFILES[request.profile];
    if (rules === undefined) throw new SandboxInputError('profile', 'is not a job profile');
    const job = jobRunCommand({
      executionId: request.executionId,
      job: request.job,
      profile: request.profile,
      image: request.invocation.image,
      argv: request.invocation.argv,
      envNames: request.invocation.env,
      envValues: request.envValues,
      mounts: {
        root: request.workspace.root,
        tree: request.workspace.tree,
        inDir: request.workspace.inDir,
        outDir: request.workspace.outDir,
      },
      limits: request.limits,
    });
    const proxy = rules.network === 'proxy' ? proxyCreateCommand(request.executionId, this.#proxyImage, request.egressHosts) : undefined;
    checkInFiles(request.invocation);
    const input = stdinOf(request.invocation);
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new SandboxInputError('timeout', 'must be a positive integer of milliseconds');
    }
    const files = jobLogFiles(request.profile, request.job);
    if (typeof request.logPath !== 'string' || !isAbsolute(request.logPath) || basename(request.logPath) !== files.stdout) {
      throw new SandboxInputError('log path', `must be an absolute path to ${files.stdout}`);
    }
    if (this.#active.has(request.executionId)) throw new SandboxInputError('execution id', 'already has a running job');
    const logDir = dirname(request.logPath);
    const secrets = [...Object.values(request.envValues), ...this.#redactValues];
    const redact = secretRedactor(secrets);

    // 2. The job's input files; the managed settings file must exist before it is mounted.
    for (const file of request.invocation.inFiles) writeFileSync(join(request.workspace.inDir, file.name), file.content, 'utf8');
    if (rules.managedSettings) {
      const settings = join(request.workspace.inDir, MANAGED_SETTINGS_FILE);
      if (!existsSync(settings) || !lstatSync(settings).isFile()) {
        throw new SandboxInputError('managed settings', `${MANAGED_SETTINGS_FILE} must be a file in the in directory`);
      }
    }

    mkdirSync(logDir, { recursive: true });
    const active: ActiveRun = { stopRequested: false };
    this.#active.set(request.executionId, active);
    const handle: ProxyHandle = {};
    try {
      // 3. Network and egress proxy.
      if (proxy !== undefined) await this.#startProxy(request.executionId, proxy, join(logDir, PROXY_LOG), secrets, redact, handle);
      // 4-5. The job container.
      return await this.#runJob(request, job, input, join(logDir, files.stderr), secrets, redact, active);
    } finally {
      // 6. Cleanup on every path.
      try {
        if (proxy !== undefined) await this.#removeProxyAndNetwork(request.executionId, handle.child, redact);
      } finally {
        handle.log?.close();
        this.#active.delete(request.executionId);
      }
    }
  }

  async kill(executionId: string): Promise<void> {
    const prefix = containerPrefix(executionId);
    const active = this.#active.get(executionId);
    if (active !== undefined) active.stopRequested = true;
    const redact = secretRedactor(this.#redactValues);
    const listed = await this.#exec(['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}'], COMMAND_TIMEOUT_MS);
    if (listed.exitCode !== 0) throw new ExternalCommandError('docker', listed.exitCode, `ps: ${summarize(listed.stderr, redact)}`);
    // The name filter matches substrings; only names Roster gave to this execution are killed.
    const names = [
      ...new Set(
        listed.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((name) => isExecutionContainer(executionId, name)),
      ),
    ].sort();
    for (const name of names) {
      await this.#killContainer(name, redact);
      await this.#removeContainer(name, redact);
    }
    await this.#removeNetwork(executionId, redact);
  }

  // -------------------------------------------------------------------------------------------

  #exec(args: readonly string[], timeoutMs: number): Promise<DockerOutput> {
    return this.#runner.exec({ args, env: dockerEnv(this.#env), cwd: this.#cwd, timeoutMs });
  }

  /** For cleanup: a docker that cannot run is reported as a failed command, never thrown. */
  async #tryExec(args: readonly string[]): Promise<DockerOutput> {
    try {
      return await this.#exec(args, COMMAND_TIMEOUT_MS);
    } catch (error) {
      return { exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : 'docker failed' };
    }
  }

  async #mustExec(label: string, command: DockerCommand, redact: Redact): Promise<void> {
    const output = await this.#exec(command.args, COMMAND_TIMEOUT_MS);
    if (output.exitCode !== 0) throw new ExternalCommandError('docker', output.exitCode, `${label}: ${summarize(output.stderr, redact)}`);
  }

  async #startProxy(
    executionId: string,
    proxy: DockerCommand,
    logPath: string,
    secrets: readonly string[],
    redact: Redact,
    handle: ProxyHandle,
  ): Promise<void> {
    // Leftovers of an earlier job of this execution whose cleanup failed; a failure means "not there".
    await this.#tryExec(['rm', '-f', proxyContainerName(executionId)]);
    await this.#tryExec(['network', 'rm', networkName(executionId)]);

    await this.#mustExec('network create', networkCreateCommand(executionId), redact);
    await this.#mustExec('create proxy', proxy, redact);
    await this.#mustExec('network connect', proxyConnectCommand(executionId), redact);

    let markReady: () => void = () => undefined;
    const ready = new Promise<'ready'>((resolve) => {
      markReady = () => resolve('ready');
    });
    const log = new LineLogWriter(logPath, {
      secrets,
      onLine: (line) => {
        if (isListeningLine(line)) markReady();
      },
    });
    handle.log = log;
    const start = proxyStartCommand(executionId);
    const child = this.#runner.spawn({
      args: start.args,
      env: dockerEnv(this.#env),
      cwd: this.#cwd,
      input: '',
      onStdout: (chunk) => log.write(chunk),
      onStderr: (chunk) => log.write(chunk),
    });
    handle.child = child;
    const ended = child.exited.then(
      (code) => ({ kind: 'exited' as const, code }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );
    const outcome = await Promise.race([ready, ended, sleep(this.#proxyStartTimeoutMs)]);
    if (outcome === 'ready') return;
    if (outcome === 'timeout') {
      throw new ExternalCommandError('docker', null, `egress proxy did not start within ${Math.round(this.#proxyStartTimeoutMs / 1000)} s`);
    }
    if (outcome.kind === 'failed') throw outcome.error;
    throw new ExternalCommandError('docker', outcome.code, `egress proxy exited before it was ready (see ${PROXY_LOG})`);
  }

  async #runJob(
    request: SandboxRunRequest,
    job: DockerCommand,
    input: string,
    stderrPath: string,
    secrets: readonly string[],
    redact: Redact,
    active: ActiveRun,
  ): Promise<ContainerExit> {
    const name = jobContainerName(request.executionId, request.job);
    const stdoutLog = new LineLogWriter(request.logPath, { secrets });
    let stderrLog: LineLogWriter;
    try {
      stderrLog = new LineLogWriter(stderrPath, { secrets });
    } catch (error) {
      stdoutLog.close();
      throw error;
    }

    const startedAt = this.#now().toISOString();
    let timedOut = false;
    let exitCode: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = this.#runner.spawn({
        args: job.args,
        // The only docker child that receives the container's environment values.
        env: dockerEnv(this.#env, job.env),
        cwd: this.#cwd,
        input,
        onStdout: (chunk) => stdoutLog.write(chunk),
        onStderr: (chunk) => stderrLog.write(chunk),
      });
      const exited = child.exited.then((code) => ({ code }));
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), request.timeoutMs);
      });
      const first = await Promise.race([exited, timeout]);
      if (first === 'timeout') {
        timedOut = true;
        // Killing the docker CLI process would leave the container running: kill it by name.
        await this.#killContainer(name, redact);
        if ((await Promise.race([settled(child), sleep(this.#killGraceMs)])) === 'timeout') {
          child.kill();
          await this.#removeContainer(name, redact);
          await Promise.race([settled(child), sleep(this.#killGraceMs)]);
        }
      } else {
        exitCode = first.code;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      stdoutLog.close();
      stderrLog.close();
    }
    const stopped = active.stopRequested;
    return {
      exitCode: timedOut || stopped ? null : exitCode,
      timedOut,
      stopped,
      startedAt,
      endedAt: this.#now().toISOString(),
    };
  }

  async #killContainer(name: string, redact: Redact): Promise<void> {
    const output = await this.#tryExec(['kill', name]);
    if (output.exitCode !== 0 && !/no such container|is not running/i.test(output.stderr)) {
      this.#warn(`docker kill ${name} failed: ${summarize(output.stderr, redact)}`);
    }
  }

  async #removeContainer(name: string, redact: Redact): Promise<void> {
    const output = await this.#tryExec(['rm', '-f', name]);
    if (output.exitCode !== 0 && !/no such container|already in progress/i.test(output.stderr)) {
      this.#warn(`docker rm ${name} failed: ${summarize(output.stderr, redact)}`);
    }
  }

  async #removeNetwork(executionId: string, redact: Redact): Promise<void> {
    const network = networkName(executionId);
    const output = await this.#tryExec(['network', 'rm', network]);
    if (output.exitCode !== 0 && !/not found|no such network/i.test(output.stderr)) {
      this.#warn(`docker network rm ${network} failed: ${summarize(output.stderr, redact)}`);
    }
  }

  async #removeProxyAndNetwork(executionId: string, child: DockerChild | undefined, redact: Redact): Promise<void> {
    await this.#removeContainer(proxyContainerName(executionId), redact);
    if (child !== undefined && (await Promise.race([settled(child), sleep(this.#killGraceMs)])) === 'timeout') child.kill();
    await this.#removeNetwork(executionId, redact);
  }
}

/** Builds the SandboxPort. The composition root passes the proxy image of the pinned commit. */
export function createDockerSandbox(options: DockerSandboxOptions): DockerSandbox {
  return new DockerSandbox(options);
}
