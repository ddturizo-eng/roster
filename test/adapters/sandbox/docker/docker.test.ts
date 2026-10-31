import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AVAILABLE_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  REDACTED,
  SandboxInputError,
  createDockerSandbox,
  isListeningLine,
} from '../../../../src/adapters/sandbox/docker/index.ts';
import type {
  DockerCall,
  DockerChild,
  DockerOutput,
  DockerRunner,
  DockerSandbox,
  DockerSandboxOptions,
  DockerStreamCall,
} from '../../../../src/adapters/sandbox/docker/index.ts';
import { ExternalCommandError } from '../../../../src/core/domain/errors.ts';
import type { JobProfile } from '../../../../src/core/domain/execution.ts';
import type { ContainerInvocation, WorkspacePaths } from '../../../../src/core/domain/runtime.ts';
import type { SandboxRunRequest } from '../../../../src/ports/sandbox.ts';

// The Docker sandbox against a stubbed docker runner: exact argument lists and environments of every
// call in order, cleanup on every path, timeout kill by name, and the job logs of ADR 0031.

const EXEC_ID = '20261031120000-abc123';
const FAKE_TOKEN = 'sk-ant-oat01-FAKE0123456789abcdefFAKE0123456789';
const PARENT_CLAUDE = 'sk-ant-oat01-PARENTshouldNEVERreachDOCKER000000';
const PARENT_GH = 'ghp_PARENTshouldNEVERreachDOCKER000000000000';
const FAKE_GH = 'github_pat_FAKE0123456789abcdefFAKE0123456789ab';
const RUNTIME_IMAGE = 'roster/runtime-claude:0686dd2d2af4d90cf817bd974df4f4b3785c8e48';
const PROXY_IMAGE = 'roster/egress-proxy:0686dd2d2af4d90cf817bd974df4f4b3785c8e48';
const NET = `roster-net-${EXEC_ID}`;
const PROXY_NAME = `roster-${EXEC_ID}-proxy`;
const PROXY_URL = `http://${PROXY_NAME}:3128`;
const LISTENING = '{"time":"2026-10-31T12:00:00.000Z","event":"listening","port":3128,"allow":["api.anthropic.com:443"]}';
const START = new Date('2026-10-31T12:00:00.000Z');
const PARENT_ENV = {
  PATH: 'C:\\Windows\\system32',
  SYSTEMROOT: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\u',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  GH_TOKEN: PARENT_GH,
  GITHUB_TOKEN: PARENT_GH,
  CLAUDE_CODE_OAUTH_TOKEN: PARENT_CLAUDE,
  HTTPS_PROXY: 'http://corp-proxy:8080',
  NODE_OPTIONS: '--require evil.js',
};
const BASE_ENV = {
  PATH: 'C:\\Windows\\system32',
  SYSTEMROOT: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\u',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  DOCKER_CLI_HINTS: 'false',
  NO_COLOR: '1',
};
const OK: DockerOutput = { exitCode: 0, stdout: '', stderr: '' };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Stub runner

interface Recorded {
  readonly kind: 'exec' | 'spawn';
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly input?: string;
}

class StubChild implements DockerChild {
  readonly call: DockerStreamCall;
  readonly exited: Promise<number | null>;
  cliKilled = false;
  ignoreCliKill = false;
  done = false;
  #resolve: (code: number | null) => void = () => undefined;
  #reject: (error: unknown) => void = () => undefined;

  constructor(call: DockerStreamCall) {
    this.call = call;
    this.exited = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  out(text: string | Buffer): void {
    this.call.onStdout(typeof text === 'string' ? Buffer.from(text) : text);
  }

  err(text: string): void {
    this.call.onStderr(Buffer.from(text));
  }

  exit(code: number | null): void {
    if (this.done) return;
    this.done = true;
    this.#resolve(code);
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.#reject(error);
  }

  kill(): void {
    this.cliKilled = true;
    if (!this.ignoreCliKill) this.exit(null);
  }
}

interface StubOptions {
  /** Answer for an exec call; undefined means exit 0. */
  readonly exec?: (args: readonly string[]) => DockerOutput | Error | undefined;
  /** Script of the proxy (`docker start -a`); default: prints the listening line. */
  readonly proxy?: (child: StubChild) => void;
  /** Script of the job container; default: one line, exit 0. */
  readonly job?: (child: StubChild) => void | Promise<void>;
  /** `docker kill <job>` does not end the job (a hung docker CLI). */
  readonly killIgnored?: boolean;
}

class StubDocker implements DockerRunner {
  readonly calls: Recorded[] = [];
  readonly children: StubChild[] = [];
  readonly options: StubOptions;

  constructor(options: StubOptions = {}) {
    this.options = options;
  }

  async exec(call: DockerCall): Promise<DockerOutput> {
    this.calls.push({ kind: 'exec', args: call.args, env: call.env, cwd: call.cwd, timeoutMs: call.timeoutMs });
    const [command, a, b] = call.args;
    // A removed or killed container ends its attached docker process.
    const name = command === 'rm' && a === '-f' ? b : command === 'kill' ? a : undefined;
    if (name !== undefined) {
      for (const child of this.children) {
        const target = child.call.args[0] === 'start' ? child.call.args[2] : child.call.args[child.call.args.indexOf('--name') + 1];
        if (target === name && !(this.options.killIgnored === true && child.call.args[0] === 'run')) child.exit(137);
      }
    }
    const answer = this.options.exec?.(call.args);
    if (answer instanceof Error) throw answer;
    return answer ?? OK;
  }

  spawn(call: DockerStreamCall): DockerChild {
    this.calls.push({ kind: 'spawn', args: call.args, env: call.env, cwd: call.cwd, input: call.input });
    const child = new StubChild(call);
    this.children.push(child);
    if (call.args[0] === 'start') {
      setImmediate(() => (this.options.proxy ?? ((c) => c.out(`${LISTENING}\n`)))(child));
    } else {
      setImmediate(() => {
        void (async () => {
          if (this.options.job === undefined) {
            child.out('{"type":"result","subtype":"success"}\n');
            child.exit(0);
          } else {
            await this.options.job(child);
          }
        })();
      });
    }
    return child;
  }
}

// ---------------------------------------------------------------------------------------------
// Harness

interface Harness {
  readonly sandbox: DockerSandbox;
  readonly docker: StubDocker;
  readonly workspace: WorkspacePaths;
  readonly logDir: string;
  readonly cwd: string;
  readonly warnings: string[];
}

function harness(stub: StubOptions = {}, options: Partial<DockerSandboxOptions> = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), 'roster-sandbox-'));
  dirs.push(base);
  const root = join(base, 'workspaces', 'roster', EXEC_ID);
  const workspace: WorkspacePaths = {
    root,
    gitDir: join(root, 'git'),
    tree: join(root, 'tree'),
    inDir: join(root, 'in'),
    outDir: join(root, 'out'),
  };
  for (const dir of [workspace.tree, workspace.inDir, workspace.outDir]) mkdirSync(dir, { recursive: true });
  const cwd = join(base, 'trusted');
  mkdirSync(cwd);
  const docker = new StubDocker(stub);
  const warnings: string[] = [];
  const sandbox = createDockerSandbox({
    proxyImage: PROXY_IMAGE,
    runner: docker,
    env: PARENT_ENV,
    cwd,
    redactValues: [FAKE_GH],
    now: () => START,
    proxyStartTimeoutMs: 500,
    killGraceMs: 100,
    warn: (message) => warnings.push(message),
    ...options,
  });
  return { sandbox, docker, workspace, logDir: join(base, 'logs', EXEC_ID), cwd, warnings };
}

const SETTINGS_JSON = '{"permissions":{"defaultMode":"dontAsk"}}';

function invocation(profile: JobProfile): ContainerInvocation {
  if (profile === 'agent' || profile === 'review') {
    return {
      image: RUNTIME_IMAGE,
      argv: ['claude', '-p', '--output-format', 'stream-json', '--verbose'],
      env: ['CLAUDE_CODE_OAUTH_TOKEN'],
      inFiles: [
        { name: 'prompt.md', content: 'Do the task.\n' },
        { name: 'agent.md', content: 'You are a specialist.\n' },
        { name: 'managed-settings.json', content: SETTINGS_JSON },
      ],
      stdinFile: 'prompt.md',
    };
  }
  return { image: RUNTIME_IMAGE, argv: ['sh', '-c', profile === 'setup' ? 'npm ci --ignore-scripts' : 'npm test'], env: [], inFiles: [] };
}

function request(h: Harness, profile: JobProfile, overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  const runtime = profile === 'agent' || profile === 'review';
  const job = profile;
  return {
    executionId: EXEC_ID,
    job,
    profile,
    invocation: invocation(profile),
    workspace: h.workspace,
    logPath: join(h.logDir, `${job}.${runtime ? 'jsonl' : 'log'}`),
    timeoutMs: 5_000,
    limits: { memory: '4g', cpus: 2, pids: 512 },
    egressHosts: profile === 'setup' ? ['registry.npmjs.org'] : profile === 'verify' ? [] : ['api.anthropic.com'],
    envValues: runtime ? { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } : {},
    ...overrides,
  };
}

const exec = (args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Omit<Recorded, 'env' | 'cwd'> => ({ kind: 'exec', args, timeoutMs });
const spawned = (args: readonly string[], input: string): Omit<Recorded, 'env' | 'cwd'> => ({ kind: 'spawn', args, input });
const shape = (calls: readonly Recorded[]): Omit<Recorded, 'env' | 'cwd'>[] =>
  calls.map(({ kind, args, timeoutMs, input }) => (kind === 'exec' ? { kind, args, timeoutMs } : { kind, args, input }));

const PROXY_SETUP = (hosts: string[]): Omit<Recorded, 'env' | 'cwd'>[] => [
  exec(['rm', '-f', PROXY_NAME]),
  exec(['network', 'rm', NET]),
  exec(['network', 'create', '--internal', NET]),
  exec([
    'create',
    '--rm',
    '--pull',
    'never',
    '--name',
    PROXY_NAME,
    '--user',
    '1000:1000',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '256m',
    '--cpus',
    '1',
    '--network',
    NET,
    PROXY_IMAGE,
    ...hosts,
  ]),
  exec(['network', 'connect', 'bridge', PROXY_NAME]),
  spawned(['start', '-a', PROXY_NAME], ''),
];
const CLEANUP = [exec(['rm', '-f', PROXY_NAME]), exec(['network', 'rm', NET])];

function jobArgs(h: Harness, profile: JobProfile, network: string, env: string[], argv: string[]): string[] {
  const runtime = profile === 'agent' || profile === 'review';
  const { tree, inDir, outDir } = h.workspace;
  return [
    'run',
    '-i',
    '--rm',
    '--pull',
    'never',
    '--name',
    `roster-${EXEC_ID}-${profile}`,
    '--user',
    '1000:1000',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/home/agent:uid=1000,gid=1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    '4g',
    '--cpus',
    '2',
    '--network',
    network,
    '--dns',
    '0.0.0.0',
    '--mount',
    `type=bind,source=${tree},target=/workspace${profile === 'review' ? ',readonly' : ''}`,
    '--mount',
    `type=bind,source=${inDir},target=/roster/in,readonly`,
    ...(runtime
      ? [
          '--mount',
          `type=bind,source=${outDir},target=/roster/out`,
          '--mount',
          `type=bind,source=${join(inDir, 'managed-settings.json')},target=/etc/claude-code/managed-settings.json,readonly`,
        ]
      : []),
    ...env.flatMap((name) => ['--env', name]),
    RUNTIME_IMAGE,
    ...argv,
  ];
}

const RUNTIME_ENV_NAMES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_AUTOUPDATER',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'LANG',
];
const CLAUDE_ARGV = ['claude', '-p', '--output-format', 'stream-json', '--verbose'];

function everyText(h: Harness): string {
  return JSON.stringify(h.docker.calls.map((call) => ({ args: call.args, input: call.input }))) + h.warnings.join('\n');
}

function assertNoLeak(h: Harness): void {
  for (const call of h.docker.calls) {
    expect(call.cwd).toBe(h.cwd);
    expect(call.args.join('\n')).not.toContain(FAKE_TOKEN);
    for (const secret of [PARENT_GH, PARENT_CLAUDE, FAKE_GH]) expect(JSON.stringify(call)).not.toContain(secret);
    expect(call.env).not.toHaveProperty('GH_TOKEN');
    expect(call.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(call.env).not.toHaveProperty('NODE_OPTIONS');
  }
  const withToken = h.docker.calls.filter((call) => JSON.stringify(call.env).includes(FAKE_TOKEN));
  expect(withToken.every((call) => call.kind === 'spawn' && call.args[0] === 'run')).toBe(true);
}

// ---------------------------------------------------------------------------------------------

describe('DockerSandbox.run: calls per profile', () => {
  it('agent: network, proxy, job with the prompt on stdin, cleanup, in that order', async () => {
    const h = harness();
    const exit = await h.sandbox.run(request(h, 'agent'));

    expect(exit).toEqual({ exitCode: 0, timedOut: false, stopped: false, startedAt: START.toISOString(), endedAt: START.toISOString() });
    expect(shape(h.docker.calls)).toEqual([
      ...PROXY_SETUP(['api.anthropic.com']),
      spawned(jobArgs(h, 'agent', NET, RUNTIME_ENV_NAMES, CLAUDE_ARGV), 'Do the task.\n'),
      ...CLEANUP,
    ]);
    for (const call of h.docker.calls) {
      if (call.args[0] !== 'run') expect(call.env).toEqual(BASE_ENV);
    }
    const job = h.docker.calls.find((call) => call.args[0] === 'run');
    expect(job?.env).toEqual({
      ...BASE_ENV,
      CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
      HOME: '/home/agent',
      CLAUDE_CONFIG_DIR: '/home/agent/.claude',
      HTTPS_PROXY: PROXY_URL,
      HTTP_PROXY: PROXY_URL,
      NO_PROXY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      LANG: 'C.UTF-8',
    });
    assertNoLeak(h);

    expect(readFileSync(join(h.workspace.inDir, 'managed-settings.json'), 'utf8')).toBe(SETTINGS_JSON);
    expect(readFileSync(join(h.workspace.inDir, 'prompt.md'), 'utf8')).toBe('Do the task.\n');
    expect(readFileSync(join(h.logDir, 'agent.jsonl'), 'utf8')).toBe('{"type":"result","subtype":"success"}\n');
    expect(readFileSync(join(h.logDir, 'agent.stderr.log'), 'utf8')).toBe('');
    expect(readFileSync(join(h.logDir, 'proxy.log'), 'utf8')).toBe(`${LISTENING}\n`);
  });

  it('review: same as agent with the work tree read-only', async () => {
    const h = harness();
    await h.sandbox.run(request(h, 'review'));
    expect(shape(h.docker.calls)).toEqual([
      ...PROXY_SETUP(['api.anthropic.com']),
      spawned(jobArgs(h, 'review', NET, RUNTIME_ENV_NAMES, CLAUDE_ARGV), 'Do the task.\n'),
      ...CLEANUP,
    ]);
    expect(existsSync(join(h.logDir, 'review.jsonl'))).toBe(true);
    assertNoLeak(h);
  });

  it('setup: proxy with the registry allowlist, no token, .log files', async () => {
    const h = harness();
    await h.sandbox.run(request(h, 'setup'));
    expect(shape(h.docker.calls)).toEqual([
      ...PROXY_SETUP(['registry.npmjs.org']),
      spawned(
        jobArgs(h, 'setup', NET, ['HOME', 'LANG', 'CI', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'], [
          'sh',
          '-c',
          'npm ci --ignore-scripts',
        ]),
        '',
      ),
      ...CLEANUP,
    ]);
    const job = h.docker.calls.find((call) => call.args[0] === 'run');
    expect(job?.env).toEqual({
      ...BASE_ENV,
      HOME: '/home/agent',
      LANG: 'C.UTF-8',
      CI: '1',
      HTTPS_PROXY: PROXY_URL,
      HTTP_PROXY: PROXY_URL,
      NO_PROXY: '',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(existsSync(join(h.logDir, 'setup.log'))).toBe(true);
    expect(existsSync(join(h.logDir, 'setup.stderr.log'))).toBe(true);
    assertNoLeak(h);
  });

  it('verify: no network, no proxy, one docker call', async () => {
    const h = harness();
    const exit = await h.sandbox.run(request(h, 'verify', { egressHosts: ['api.anthropic.com'] }));
    expect(exit.exitCode).toBe(0);
    expect(shape(h.docker.calls)).toEqual([spawned(jobArgs(h, 'verify', 'none', ['HOME', 'LANG', 'CI'], ['sh', '-c', 'npm test']), '')]);
    expect(h.docker.calls[0]?.env).toEqual({ ...BASE_ENV, HOME: '/home/agent', LANG: 'C.UTF-8', CI: '1' });
    expect(existsSync(join(h.logDir, 'proxy.log'))).toBe(false);
    assertNoLeak(h);
  });

  it('returns the container exit code', async () => {
    const h = harness({
      job: (child) => {
        child.err('boom\n');
        child.exit(3);
      },
    });
    const exit = await h.sandbox.run(request(h, 'verify'));
    expect(exit).toMatchObject({ exitCode: 3, timedOut: false, stopped: false });
    expect(readFileSync(join(h.logDir, 'verify.stderr.log'), 'utf8')).toBe('boom\n');
  });
});

describe('DockerSandbox.run: timeout and stop', () => {
  it('kills the container by name at the timeout, then removes proxy and network', async () => {
    const h = harness({ job: (child) => child.out('{"type":"system","subtype":"init"}\n') });
    const exit = await h.sandbox.run(request(h, 'agent', { timeoutMs: 50 }));
    expect(exit).toMatchObject({ exitCode: null, timedOut: true, stopped: false });
    expect(shape(h.docker.calls).slice(-3)).toEqual([exec(['kill', `roster-${EXEC_ID}-agent`]), ...CLEANUP]);
    const job = h.docker.children.find((child) => child.call.args[0] === 'run');
    expect(job?.cliKilled).toBe(false);
    expect(readFileSync(join(h.logDir, 'agent.jsonl'), 'utf8')).toBe('{"type":"system","subtype":"init"}\n');
  });

  it('ends the docker process and removes the container when docker kill does not end the job', async () => {
    const h = harness({ job: () => undefined, killIgnored: true });
    const exit = await h.sandbox.run(request(h, 'verify', { timeoutMs: 30 }));
    expect(exit).toMatchObject({ exitCode: null, timedOut: true });
    expect(shape(h.docker.calls).slice(1)).toEqual([exec(['kill', `roster-${EXEC_ID}-verify`]), exec(['rm', '-f', `roster-${EXEC_ID}-verify`])]);
    expect(h.docker.children[0]?.cliKilled).toBe(true);
  });

  it('kill(executionId) during a run marks the exit as stopped', async () => {
    let sandbox: DockerSandbox | undefined;
    const h = harness({
      exec: (args) => (args[0] === 'ps' ? { exitCode: 0, stdout: `${PROXY_NAME}\nroster-${EXEC_ID}-agent\n`, stderr: '' } : undefined),
      job: async () => {
        await sandbox?.kill(EXEC_ID);
      },
    });
    sandbox = h.sandbox;
    const exit = await h.sandbox.run(request(h, 'agent'));
    expect(exit).toMatchObject({ exitCode: null, timedOut: false, stopped: true });
  });
});

describe('DockerSandbox.run: cleanup on errors', () => {
  it('removes proxy and network when the network cannot be created, and redacts the error', async () => {
    const h = harness({
      exec: (args) =>
        args[1] === 'create' ? { exitCode: 1, stdout: '', stderr: `Error response from daemon: bad ${FAKE_TOKEN} ${FAKE_GH}\n` } : undefined,
    });
    const error = await h.sandbox.run(request(h, 'agent')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as Error).message).toBe(`docker failed (exit 1): network create: Error response from daemon: bad ${REDACTED} ${REDACTED}`);
    expect(shape(h.docker.calls)).toEqual([...PROXY_SETUP(['api.anthropic.com']).slice(0, 3), ...CLEANUP]);
    expect(h.docker.calls.some((call) => call.args[0] === 'run')).toBe(false);
  });

  it('removes proxy and network when the proxy exits before it is ready', async () => {
    const h = harness({
      proxy: (child) => {
        child.err('egress-proxy: no allowed host given\n');
        child.exit(2);
      },
    });
    const error = await h.sandbox.run(request(h, 'agent')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as Error).message).toContain('egress proxy exited before it was ready');
    expect(shape(h.docker.calls)).toEqual([...PROXY_SETUP(['api.anthropic.com']), ...CLEANUP]);
    expect(readFileSync(join(h.logDir, 'proxy.log'), 'utf8')).toBe('egress-proxy: no allowed host given\n');
  });

  it('removes proxy and network when the proxy never becomes ready', async () => {
    const h = harness({ proxy: (child) => child.out('not json\n') }, { proxyStartTimeoutMs: 30 });
    const error = await h.sandbox.run(request(h, 'agent')).catch((e: unknown) => e);
    expect((error as Error).message).toContain('egress proxy did not start');
    expect(shape(h.docker.calls)).toEqual([...PROXY_SETUP(['api.anthropic.com']), ...CLEANUP]);
  });

  it('removes proxy and network when docker cannot start the job, and closes the logs', async () => {
    const h = harness({ job: (child) => child.fail(new ExternalCommandError('docker', null, 'could not run (ENOENT)')) });
    const error = await h.sandbox.run(request(h, 'agent')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect(shape(h.docker.calls).slice(-2)).toEqual(CLEANUP);
    expect(existsSync(join(h.logDir, 'agent.jsonl'))).toBe(true);
  });

  it('keeps the job result when cleanup fails, and reports the failure redacted', async () => {
    const h = harness({
      exec: (args) => {
        if (args[0] === 'network' && args[1] === 'rm') return { exitCode: 1, stdout: '', stderr: `error: busy ${FAKE_TOKEN}` };
        if (args[0] === 'rm') return new ExternalCommandError('docker', null, 'killed after 60 s');
        return undefined;
      },
    });
    const exit = await h.sandbox.run(request(h, 'agent'));
    expect(exit.exitCode).toBe(0);
    expect(h.warnings).toEqual([
      `docker rm ${PROXY_NAME} failed: docker failed (exit none): killed after 60 s`,
      `docker network rm ${NET} failed: error: busy ${REDACTED}`,
    ]);
  });

  it('runs again after a finished run of the same execution', async () => {
    const h = harness();
    await h.sandbox.run(request(h, 'verify'));
    await h.sandbox.run(request(h, 'verify'));
    expect(h.docker.calls).toHaveLength(2);
  });
});

describe('DockerSandbox.run: refused requests start nothing', () => {
  const refused: [string, (h: Harness) => SandboxRunRequest][] = [
    ['GH_TOKEN in the environment', (h) => request(h, 'agent', { invocation: { ...invocation('agent'), env: ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'] } })],
    ['GITHUB_TOKEN value', (h) => request(h, 'agent', { envValues: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, GITHUB_TOKEN: FAKE_GH } })],
    ['the Claude token for verify', (h) => request(h, 'verify', { invocation: { ...invocation('verify'), env: ['CLAUDE_CODE_OAUTH_TOKEN'] }, envValues: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } })],
    ['a log path with another name', (h) => request(h, 'agent', { logPath: join(h.logDir, 'agent.log') })],
    ['a relative log path', (_h) => request(_h, 'agent', { logPath: 'agent.jsonl' })],
    ['an in file outside the in directory', (h) => request(h, 'verify', { invocation: { ...invocation('verify'), inFiles: [{ name: '../tree/x', content: '' }] } })],
    ['a stdin file that is not an in file', (h) => request(h, 'verify', { invocation: { ...invocation('verify'), stdinFile: 'prompt.md' } })],
    ['a missing managed settings file', (h) => request(h, 'agent', { invocation: { ...invocation('agent'), inFiles: [{ name: 'prompt.md', content: 'x' }] } })],
    ['an empty egress allowlist', (h) => request(h, 'agent', { egressHosts: [] })],
    ['a wildcard egress host', (h) => request(h, 'setup', { egressHosts: ['*.npmjs.org'] })],
    ['a job named proxy', (h) => request(h, 'verify', { job: 'proxy', logPath: join(h.logDir, 'proxy.log') })],
    ['a zero timeout', (h) => request(h, 'verify', { timeoutMs: 0 })],
    ['a work tree outside the workspace', (h) => request(h, 'verify', { workspace: { ...h.workspace, tree: tmpdir() } })],
  ];

  it.each(refused)('refuses %s', async (_, build) => {
    const h = harness();
    const error = await h.sandbox.run(build(h)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxInputError);
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
    expect((error as Error).message).not.toContain(FAKE_GH);
    expect(h.docker.calls).toEqual([]);
  });

  it('refuses a second job of the same execution while one runs', async () => {
    let second: unknown;
    const h = harness({
      job: async (child) => {
        second = await h.sandbox.run(request(h, 'verify')).catch((e: unknown) => e);
        child.exit(0);
      },
    });
    await h.sandbox.run(request(h, 'verify'));
    expect(second).toBeInstanceOf(SandboxInputError);
  });

  it('refuses a proxy image that is not an image reference', () => {
    expect(() => createDockerSandbox({ proxyImage: '--privileged' })).toThrow(SandboxInputError);
  });
});

describe('DockerSandbox.run: job logs (ADR 0031)', () => {
  it('redacts a secret split across two stdout chunks; the redacted line still parses as JSON', async () => {
    const line = `{"type":"user","message":{"content":[{"type":"tool_result","content":"CLAUDE_CODE_OAUTH_TOKEN=${FAKE_TOKEN}"}]}}\n`;
    const cut = line.indexOf(FAKE_TOKEN) + 7;
    const h = harness({
      job: (child) => {
        child.out(line.slice(0, cut));
        child.out(line.slice(cut));
        child.err(`stderr ${FAKE_TOKEN.slice(0, 5)}`);
        child.err(`${FAKE_TOKEN.slice(5)} gh ${FAKE_GH}\n`);
        child.exit(0);
      },
    });
    await h.sandbox.run(request(h, 'agent'));
    const jsonl = readFileSync(join(h.logDir, 'agent.jsonl'), 'utf8');
    expect(jsonl).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(jsonl)).toEqual({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: `CLAUDE_CODE_OAUTH_TOKEN=${REDACTED}` }] },
    });
    expect(readFileSync(join(h.logDir, 'agent.stderr.log'), 'utf8')).toBe(`stderr ${REDACTED} gh ${REDACTED}\n`);
  });

  it('never writes stderr into the .jsonl file', async () => {
    const h = harness({
      job: (child) => {
        child.out('{"n":1}\n');
        child.err('warning: something\n');
        child.out('{"n":2}\n');
        child.err('unterminated stderr');
        child.exit(1);
      },
    });
    await h.sandbox.run(request(h, 'agent'));
    expect(readFileSync(join(h.logDir, 'agent.jsonl'), 'utf8')).toBe('{"n":1}\n{"n":2}\n');
    expect(readFileSync(join(h.logDir, 'agent.stderr.log'), 'utf8')).toBe('warning: something\nunterminated stderr\n');
  });

  it('lets a second reader see each complete line before the job ends', async () => {
    const seen: string[] = [];
    const h = harness({
      job: async (child) => {
        const path = join(h.logDir, 'agent.jsonl');
        child.out('{"n":1}\n{"n":');
        seen.push(readFileSync(path, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        child.out('2}\n');
        seen.push(readFileSync(path, 'utf8'));
        child.out('{"n":3}');
        seen.push(readFileSync(path, 'utf8'));
        child.exit(0);
      },
    });
    await h.sandbox.run(request(h, 'agent'));
    expect(seen).toEqual(['{"n":1}\n', '{"n":1}\n{"n":2}\n', '{"n":1}\n{"n":2}\n']);
    expect(readFileSync(join(h.logDir, 'agent.jsonl'), 'utf8')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
  });

  it('appends the logs of a second job with the same step name', async () => {
    const h = harness({
      job: (child) => {
        child.out('run\n');
        child.exit(0);
      },
    });
    await h.sandbox.run(request(h, 'verify'));
    await h.sandbox.run(request(h, 'verify'));
    expect(readFileSync(join(h.logDir, 'verify.log'), 'utf8')).toBe('run\nrun\n');
  });

  it('redacts the proxy log too', async () => {
    const h = harness({ proxy: (child) => child.out(`${LISTENING}\n{"event":"decision","target":"${FAKE_TOKEN}.example.com:443"}\n`) });
    await h.sandbox.run(request(h, 'agent'));
    expect(readFileSync(join(h.logDir, 'proxy.log'), 'utf8')).toBe(`${LISTENING}\n{"event":"decision","target":"${REDACTED}.example.com:443"}\n`);
  });
});

describe('DockerSandbox.kill', () => {
  it('kills and removes only containers named roster-<execution-id>-*, then removes the network', async () => {
    const h = harness({
      exec: (args) =>
        args[0] === 'ps'
          ? {
              exitCode: 0,
              stdout: [`roster-${EXEC_ID}-agent`, PROXY_NAME, `roster-${EXEC_ID}4-agent`, `x-roster-${EXEC_ID}-agent`, ''].join('\n'),
              stderr: '',
            }
          : args[0] === 'kill' && args[1] === PROXY_NAME
            ? { exitCode: 1, stdout: '', stderr: 'Error response from daemon: container is not running' }
            : undefined,
    });
    await h.sandbox.kill(EXEC_ID);
    expect(shape(h.docker.calls)).toEqual([
      exec(['ps', '-a', '--filter', `name=roster-${EXEC_ID}-`, '--format', '{{.Names}}']),
      exec(['kill', `roster-${EXEC_ID}-agent`]),
      exec(['rm', '-f', `roster-${EXEC_ID}-agent`]),
      exec(['kill', PROXY_NAME]),
      exec(['rm', '-f', PROXY_NAME]),
      exec(['network', 'rm', NET]),
    ]);
    expect(h.warnings).toEqual([]);
    for (const call of h.docker.calls) expect(call.env).toEqual(BASE_ENV);
  });

  it('removes the network when no container is left', async () => {
    const h = harness();
    await h.sandbox.kill(EXEC_ID);
    expect(shape(h.docker.calls)).toEqual([
      exec(['ps', '-a', '--filter', `name=roster-${EXEC_ID}-`, '--format', '{{.Names}}']),
      exec(['network', 'rm', NET]),
    ]);
  });

  it('refuses an execution id that is not one', async () => {
    const h = harness();
    await expect(h.sandbox.kill('.*')).rejects.toBeInstanceOf(SandboxInputError);
    expect(h.docker.calls).toEqual([]);
  });

  it('fails when docker ps fails', async () => {
    const h = harness({ exec: (args) => (args[0] === 'ps' ? { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } : undefined) });
    await expect(h.sandbox.kill(EXEC_ID)).rejects.toThrow('ps: Cannot connect to the Docker daemon');
  });
});

describe('DockerSandbox.available', () => {
  it('runs docker info with a 20 s timeout', async () => {
    const h = harness({ exec: () => ({ exitCode: 0, stdout: '29.7.2\n', stderr: '' }) });
    expect(await h.sandbox.available()).toEqual({ available: true });
    expect(shape(h.docker.calls)).toEqual([exec(['info', '--format', '{{.ServerVersion}}'], AVAILABLE_TIMEOUT_MS)]);
    expect(AVAILABLE_TIMEOUT_MS).toBe(20_000);
    expect(h.docker.calls[0]?.env).toEqual(BASE_ENV);
  });

  it('reports a non-zero exit with the last error line', async () => {
    const h = harness({ exec: () => ({ exitCode: 1, stdout: '', stderr: 'Server:\r\nerror during connect: pipe not found\u001b[0m\n' }) });
    expect(await h.sandbox.available()).toEqual({
      available: false,
      reason: 'docker info exited with 1: error during connect: pipe not found [0m',
    });
  });

  it('reports a docker that cannot run or times out', async () => {
    const h = harness({ exec: () => new ExternalCommandError('docker', null, 'killed after 20 s') });
    expect(await h.sandbox.available()).toEqual({ available: false, reason: 'docker failed (exit none): killed after 20 s' });
  });
});

describe('isListeningLine', () => {
  it('recognizes only the proxy listening event', () => {
    expect(isListeningLine(LISTENING)).toBe(true);
    expect(isListeningLine('{"event":"decision"}')).toBe(false);
    expect(isListeningLine('listening')).toBe(false);
    expect(isListeningLine('null')).toBe(false);
  });
});

describe('no secret in any recorded call', () => {
  it('holds across every profile', async () => {
    for (const profile of ['agent', 'review', 'setup', 'verify'] as const) {
      const h = harness();
      await h.sandbox.run(request(h, profile));
      assertNoLeak(h);
      expect(everyText(h)).not.toContain(FAKE_TOKEN);
    }
  });
});

