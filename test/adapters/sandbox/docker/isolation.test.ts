import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROFILES,
  SandboxInputError,
  egressArguments,
  isExecutionContainer,
  jobContainerName,
  jobEnvironment,
  jobRunCommand,
  networkCreateCommand,
  proxyConnectCommand,
  proxyCreateCommand,
  proxyStartCommand,
  proxyUrl,
} from '../../../../src/adapters/sandbox/docker/index.ts';
import type { JobContainerSpec } from '../../../../src/adapters/sandbox/docker/index.ts';
import { JOB_PROFILES } from '../../../../src/core/domain/execution.ts';
import type { JobProfile } from '../../../../src/core/domain/execution.ts';

// Protected isolation flags (plan 002 section 9.3): exact argument lists per profile, so any change
// to a flag, a mount or an environment name fails here.

const EXEC_ID = '20261031120000-abc123';
const FAKE_TOKEN = 'sk-ant-oat01-FAKE0123456789abcdefFAKE0123456789';
const RUNTIME_IMAGE = 'roster/runtime-claude:0686dd2d2af4d90cf817bd974df4f4b3785c8e48';
const PROXY_IMAGE = 'roster/egress-proxy:0686dd2d2af4d90cf817bd974df4f4b3785c8e48';
const ROOT = join(tmpdir(), 'roster-it', 'workspaces', 'roster', EXEC_ID);
const TREE = join(ROOT, 'tree');
const IN = join(ROOT, 'in');
const OUT = join(ROOT, 'out');
const SETTINGS = join(IN, 'managed-settings.json');
const LIMITS = { memory: '4g', cpus: 2, pids: 512 };
const NET = `roster-net-${EXEC_ID}`;
const PROXY = `http://roster-${EXEC_ID}-proxy:3128`;
const CLAUDE_ARGV = ['claude', '-p', '--output-format', 'stream-json', '--verbose'];

function spec(profile: JobProfile, overrides: Partial<JobContainerSpec> = {}): JobContainerSpec {
  const runtime = profile === 'agent' || profile === 'review';
  return {
    executionId: EXEC_ID,
    job: profile,
    profile,
    image: RUNTIME_IMAGE,
    argv: runtime ? CLAUDE_ARGV : ['sh', '-c', 'npm test'],
    envNames: runtime ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [],
    envValues: runtime ? { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } : {},
    mounts: { root: ROOT, tree: TREE, inDir: IN, outDir: OUT },
    limits: LIMITS,
    ...overrides,
  };
}

const COMMON = (job: string, network: string): string[] => [
  'run',
  '-i',
  '--rm',
  '--pull',
  'never',
  '--name',
  `roster-${EXEC_ID}-${job}`,
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
];

const RUNTIME_ENV_ARGS = [
  '--env',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '--env',
  'HOME',
  '--env',
  'CLAUDE_CONFIG_DIR',
  '--env',
  'HTTPS_PROXY',
  '--env',
  'HTTP_PROXY',
  '--env',
  'NO_PROXY',
  '--env',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  '--env',
  'DISABLE_AUTOUPDATER',
  '--env',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  '--env',
  'LANG',
];

const RUNTIME_ENV_VALUES = {
  CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
  HOME: '/home/agent',
  CLAUDE_CONFIG_DIR: '/home/agent/.claude',
  HTTPS_PROXY: PROXY,
  HTTP_PROXY: PROXY,
  NO_PROXY: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  LANG: 'C.UTF-8',
};

describe('jobRunCommand: exact argument lists per profile', () => {
  it('agent: work tree rw, in ro, out rw, managed settings ro, internal network, runtime env', () => {
    const command = jobRunCommand(spec('agent'));
    expect(command.args).toEqual([
      ...COMMON('agent', NET),
      '--mount',
      `type=bind,source=${TREE},target=/workspace`,
      '--mount',
      `type=bind,source=${IN},target=/roster/in,readonly`,
      '--mount',
      `type=bind,source=${OUT},target=/roster/out`,
      '--mount',
      `type=bind,source=${SETTINGS},target=/etc/claude-code/managed-settings.json,readonly`,
      ...RUNTIME_ENV_ARGS,
      RUNTIME_IMAGE,
      ...CLAUDE_ARGV,
    ]);
    expect(command.env).toEqual(RUNTIME_ENV_VALUES);
  });

  it('review: like agent, but the work tree is read-only', () => {
    const command = jobRunCommand(spec('review'));
    expect(command.args).toEqual([
      ...COMMON('review', NET),
      '--mount',
      `type=bind,source=${TREE},target=/workspace,readonly`,
      '--mount',
      `type=bind,source=${IN},target=/roster/in,readonly`,
      '--mount',
      `type=bind,source=${OUT},target=/roster/out`,
      '--mount',
      `type=bind,source=${SETTINGS},target=/etc/claude-code/managed-settings.json,readonly`,
      ...RUNTIME_ENV_ARGS,
      RUNTIME_IMAGE,
      ...CLAUDE_ARGV,
    ]);
    expect(command.env).toEqual(RUNTIME_ENV_VALUES);
  });

  it('setup: work tree rw, in ro, no out, no settings, proxy env with NODE_USE_ENV_PROXY, no token', () => {
    const command = jobRunCommand(spec('setup', { argv: ['sh', '-c', 'npm ci --ignore-scripts'] }));
    expect(command.args).toEqual([
      ...COMMON('setup', NET),
      '--mount',
      `type=bind,source=${TREE},target=/workspace`,
      '--mount',
      `type=bind,source=${IN},target=/roster/in,readonly`,
      '--env',
      'HOME',
      '--env',
      'LANG',
      '--env',
      'CI',
      '--env',
      'HTTPS_PROXY',
      '--env',
      'HTTP_PROXY',
      '--env',
      'NO_PROXY',
      '--env',
      'NODE_USE_ENV_PROXY',
      RUNTIME_IMAGE,
      'sh',
      '-c',
      'npm ci --ignore-scripts',
    ]);
    expect(command.env).toEqual({
      HOME: '/home/agent',
      LANG: 'C.UTF-8',
      CI: '1',
      HTTPS_PROXY: PROXY,
      HTTP_PROXY: PROXY,
      NO_PROXY: '',
      NODE_USE_ENV_PROXY: '1',
    });
  });

  it('verify: network none, work tree rw, in ro, HOME, LANG and CI only', () => {
    const command = jobRunCommand(spec('verify'));
    expect(command.args).toEqual([
      ...COMMON('verify', 'none'),
      '--mount',
      `type=bind,source=${TREE},target=/workspace`,
      '--mount',
      `type=bind,source=${IN},target=/roster/in,readonly`,
      '--env',
      'HOME',
      '--env',
      'LANG',
      '--env',
      'CI',
      RUNTIME_IMAGE,
      'sh',
      '-c',
      'npm test',
    ]);
    expect(command.env).toEqual({ HOME: '/home/agent', LANG: 'C.UTF-8', CI: '1' });
  });

  it('omits the token when the job does not ask for it', () => {
    const command = jobRunCommand(spec('agent', { envNames: [], envValues: {} }));
    expect(command.args).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(command.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it.each(JOB_PROFILES)('%s: no secret value, extra mount, socket or host path in any argument', (profile) => {
    const { args } = jobRunCommand(spec(profile));
    expect(args.join('\n')).not.toContain(FAKE_TOKEN);
    expect(args.filter((arg) => arg.includes('='))).toEqual(
      args.filter((arg) => arg.startsWith('type=bind,') || arg.startsWith('/home/agent:')),
    );
    for (const forbidden of ['-v', '--volume', '--privileged', '--cap-add', '--env-file', '-e', '--device', '--ipc', '--pid', '--userns']) {
      expect(args).not.toContain(forbidden);
    }
    expect(args.join('\n')).not.toMatch(/docker\.sock|docker_engine|GH_TOKEN|GITHUB_TOKEN/);
    const mounts = args.filter((_, i) => args[i - 1] === '--mount');
    expect(mounts).toHaveLength(profile === 'agent' || profile === 'review' ? 4 : 2);
    for (const mount of mounts) {
      expect([TREE, IN, OUT, SETTINGS]).toContain(/source=([^,]+)/.exec(mount)?.[1]);
    }
  });
});

describe('profile environment allowlist', () => {
  it('never lists a GitHub variable and gives a value source to every name', () => {
    for (const profile of JOB_PROFILES) {
      const rules = PROFILES[profile];
      for (const name of rules.env) expect(name).not.toMatch(/^(GH|GITHUB)_|GIT_/);
      for (const name of rules.secretEnv) expect(rules.env).toContain(name);
    }
    expect(PROFILES.setup.secretEnv).toEqual([]);
    expect(PROFILES.verify.secretEnv).toEqual([]);
  });

  it.each(JOB_PROFILES)('%s refuses GH_TOKEN, GITHUB_TOKEN, PATH and unknown names', (profile) => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'PATH', 'USERPROFILE', 'DOCKER_HOST', 'ANTHROPIC_API_KEY']) {
      expect(() => jobEnvironment(profile, EXEC_ID, [name], {})).toThrow(SandboxInputError);
      expect(() => jobRunCommand(spec(profile, { envNames: [name], envValues: {} }))).toThrow(SandboxInputError);
    }
  });

  it.each(['setup', 'verify'] as const)('%s refuses the Claude token', (profile) => {
    expect(() =>
      jobRunCommand(spec(profile, { envNames: ['CLAUDE_CODE_OAUTH_TOKEN'], envValues: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } })),
    ).toThrow(SandboxInputError);
  });

  it('refuses values for fixed names, values without a name, and malformed secret values', () => {
    expect(() => jobEnvironment('agent', EXEC_ID, ['HOME'], { HOME: '/root' })).toThrow(SandboxInputError);
    expect(() => jobEnvironment('agent', EXEC_ID, [], { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN })).toThrow(SandboxInputError);
    expect(() => jobEnvironment('agent', EXEC_ID, ['CLAUDE_CODE_OAUTH_TOKEN'], {})).toThrow(SandboxInputError);
    for (const bad of ['', 'a b', 'a\nb', 'a\u0000b']) {
      expect(() => jobEnvironment('agent', EXEC_ID, ['CLAUDE_CODE_OAUTH_TOKEN'], { CLAUDE_CODE_OAUTH_TOKEN: bad })).toThrow(
        SandboxInputError,
      );
    }
  });

  it('never puts a secret value in an error message', () => {
    const error = (() => {
      try {
        jobEnvironment('agent', EXEC_ID, ['CLAUDE_CODE_OAUTH_TOKEN'], { CLAUDE_CODE_OAUTH_TOKEN: `${FAKE_TOKEN} x` });
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(SandboxInputError);
    expect(error?.message).not.toContain(FAKE_TOKEN);
  });
});

describe('jobRunCommand input checks', () => {
  const cases: [string, Partial<JobContainerSpec>][] = [
    ['bad execution id', { executionId: '2026-abc' }],
    ['job named proxy', { job: 'proxy' }],
    ['job with a slash', { job: 'agent/x' }],
    ['uppercase job', { job: 'Agent' }],
    ['image as an option', { image: '--privileged' }],
    ['image with uppercase', { image: 'Roster/runtime' }],
    ['empty argv', { argv: [] }],
    ['argv with NUL', { argv: ['a\u0000b'] }],
    ['relative tree', { mounts: { root: ROOT, tree: 'tree', inDir: IN, outDir: OUT } }],
    ['tree with a comma', { mounts: { root: ROOT, tree: join(ROOT, 'a,b'), inDir: IN, outDir: OUT } }],
    ['tree outside the root', { mounts: { root: ROOT, tree: tmpdir(), inDir: IN, outDir: OUT } }],
    ['tree equal to in', { mounts: { root: ROOT, tree: IN, inDir: IN, outDir: OUT } }],
    ['memory without unit', { limits: { ...LIMITS, memory: '4' } }],
    ['memory as an option', { limits: { ...LIMITS, memory: '-1' } }],
    ['zero cpus', { limits: { ...LIMITS, cpus: 0 } }],
    ['fractional pids', { limits: { ...LIMITS, pids: 1.5 } }],
  ];
  it.each(cases)('refuses %s', (_, overrides) => {
    expect(() => jobRunCommand(spec('agent', overrides))).toThrow(SandboxInputError);
  });

  it('refuses an unknown profile', () => {
    expect(() => jobRunCommand(spec('agent', { profile: 'root' as JobProfile }))).toThrow(SandboxInputError);
  });
});

describe('network and egress proxy commands', () => {
  it('creates an internal network per execution', () => {
    expect(networkCreateCommand(EXEC_ID)).toEqual({ args: ['network', 'create', '--internal', NET], env: {} });
  });

  it('creates the proxy hardened, on the internal network, with host arguments only', () => {
    expect(proxyCreateCommand(EXEC_ID, PROXY_IMAGE, ['api.anthropic.com', 'api.anthropic.com:443'])).toEqual({
      args: [
        'create',
        '--rm',
        '--pull',
        'never',
        '--name',
        `roster-${EXEC_ID}-proxy`,
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
        'api.anthropic.com',
      ],
      env: {},
    });
  });

  it('connects the proxy to the default bridge and starts it attached', () => {
    expect(proxyConnectCommand(EXEC_ID).args).toEqual(['network', 'connect', 'bridge', `roster-${EXEC_ID}-proxy`]);
    expect(proxyStartCommand(EXEC_ID).args).toEqual(['start', '-a', `roster-${EXEC_ID}-proxy`]);
    expect(proxyUrl(EXEC_ID)).toBe(PROXY);
  });

  it.each([[[]], [['*.anthropic.com']], [['api.anthropic.com:80']], [['API.anthropic.com']], [['-oops']], [['a b']], [['x.com:443:443']]])(
    'refuses egress hosts %j',
    (hosts) => {
      expect(() => egressArguments(hosts as string[])).toThrow(SandboxInputError);
    },
  );

  it('accepts host and host:443 and removes duplicates', () => {
    expect(egressArguments(['registry.npmjs.org:443', 'registry.npmjs.org', 'api.anthropic.com'])).toEqual([
      'registry.npmjs.org',
      'api.anthropic.com',
    ]);
  });
});

describe('container names', () => {
  it('names job containers roster-<execution-id>-<job>', () => {
    expect(jobContainerName(EXEC_ID, 'agent')).toBe(`roster-${EXEC_ID}-agent`);
  });

  it('recognizes only containers of the execution', () => {
    expect(isExecutionContainer(EXEC_ID, `roster-${EXEC_ID}-agent`)).toBe(true);
    expect(isExecutionContainer(EXEC_ID, `roster-${EXEC_ID}-proxy`)).toBe(true);
    expect(isExecutionContainer(EXEC_ID, `roster-${EXEC_ID}4-agent`)).toBe(false);
    expect(isExecutionContainer(EXEC_ID, `x-roster-${EXEC_ID}-agent`)).toBe(false);
    expect(isExecutionContainer(EXEC_ID, `roster-${EXEC_ID}-`)).toBe(false);
    expect(isExecutionContainer(EXEC_ID, `roster-${EXEC_ID}-a/b`)).toBe(false);
  });
});
