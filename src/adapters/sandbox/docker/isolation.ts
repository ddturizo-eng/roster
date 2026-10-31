// Container isolation flags (ADR 0023, ADR 0024, plan 002 sections 9.2-9.4 and 9.6, spike T14).
// Protected path (ADR 0025): only the human pushes changes to this file. It is written once, in T15,
// and covers every job profile, `agent`, `review`, `setup` and `verify`, plus the egress proxy, so
// later tasks use it without touching it.
//
// Everything that decides what a container can reach is built here, from validated input:
// - job containers: `docker run -i --rm --pull never --name roster-<execution-id>-<job>`, uid 1000,
//   read-only root, tmpfs `/tmp` (noexec, spike finding 12) and `/home/agent` owned by uid 1000
//   (T13 finding: a plain tmpfs is root-owned and unwritable for uid 1000), `--cap-drop ALL`,
//   `no-new-privileges`, PID, memory and CPU limits from the policy, the per-execution internal
//   network or `none`, `--dns 0.0.0.0`, the mount table of section 9.3 and nothing else, and
//   `--env NAME` by name only (values reach the docker child's environment, never an argument);
// - `-i` because the prompt goes on stdin (spike finding 1);
// - `--pull never`: images are built locally from the pinned install (ADR 0025) and are never pulled,
//   so an image of the same name published on a registry can never run with the Claude token;
// - the environment allowlist per profile (section 9.4); `NODE_USE_ENV_PROXY=1` for setup (spike
//   finding 9). `GH_TOKEN`, `GITHUB_TOKEN` and every name not listed here are refused;
// - the egress proxy: `roster/egress-proxy` on the internal network plus the default bridge, no
//   mounts, no environment, listening on `http://roster-<execution-id>-proxy:3128` (spike finding 8),
//   arguments `host` (port 443 only, T13).

import { basename, dirname, isAbsolute, join } from 'node:path';
import { JOB_PROFILES } from '../../../core/domain/execution.ts';
import type { JobProfile } from '../../../core/domain/execution.ts';
import { isExecutionId } from '../../../core/domain/ids.ts';
import { SandboxInputError } from './errors.ts';

/** uid:gid of user `agent` in the runtime image and of the proxy user (T13). */
export const CONTAINER_USER = '1000:1000';

/** Home of uid 1000; a fresh tmpfs per container. */
export const CONTAINER_HOME = '/home/agent';

/** Port the egress proxy listens on (container/egress-proxy/decision.ts). */
export const PROXY_PORT = 3128;

/** The only destination port the proxy forwards to. */
export const PROXY_ALLOWED_PORT = 443;

/** The managed settings file in the job's `in` directory, mounted read-only for agent and review. */
export const MANAGED_SETTINGS_FILE = 'managed-settings.json';

/** Container paths of the mount table (plan 002 section 9.3). */
export const MOUNT_TARGETS = {
  workspace: '/workspace',
  in: '/roster/in',
  out: '/roster/out',
  managedSettings: '/etc/claude-code/managed-settings.json',
} as const;

/** Container name suffix reserved for the egress proxy. */
export const PROXY_JOB = 'proxy';

/** Resource limits of the proxy container: it only relays CONNECT tunnels. */
export const PROXY_LIMITS = { memory: '256m', cpus: 1, pids: 128 } as const;

export interface ProfileRules {
  /** `proxy`: the per-execution internal network and the egress proxy; `none`: no network at all. */
  readonly network: 'proxy' | 'none';
  readonly workspaceReadOnly: boolean;
  /** `/roster/out` is mounted (read-write). */
  readonly outMount: boolean;
  /** The managed settings file is mounted read-only at `/etc/claude-code/managed-settings.json`. */
  readonly managedSettings: boolean;
  /** Names passed to the container, in this order. */
  readonly env: readonly string[];
  /** Names in `env` whose value comes from the request (secrets); the rest are fixed below. */
  readonly secretEnv: readonly string[];
}

const RUNTIME_ENV = [
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
] as const;

/** The four job profiles of plan 002 section 9.2. */
export const PROFILES: Readonly<Record<JobProfile, ProfileRules>> = {
  agent: {
    network: 'proxy',
    workspaceReadOnly: false,
    outMount: true,
    managedSettings: true,
    env: RUNTIME_ENV,
    secretEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
  },
  review: {
    network: 'proxy',
    workspaceReadOnly: true,
    outMount: true,
    managedSettings: true,
    env: RUNTIME_ENV,
    secretEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
  },
  setup: {
    network: 'proxy',
    workspaceReadOnly: false,
    outMount: false,
    managedSettings: false,
    env: ['HOME', 'LANG', 'CI', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'],
    secretEnv: [],
  },
  verify: {
    network: 'none',
    workspaceReadOnly: false,
    outMount: false,
    managedSettings: false,
    env: ['HOME', 'LANG', 'CI'],
    secretEnv: [],
  },
};

/** Fixed values of the non-secret names, for a container of `executionId`. */
function fixedValue(name: string, executionId: string): string | undefined {
  switch (name) {
    case 'HOME':
      return CONTAINER_HOME;
    case 'CLAUDE_CONFIG_DIR':
      return `${CONTAINER_HOME}/.claude`;
    case 'HTTPS_PROXY':
    case 'HTTP_PROXY':
      return proxyUrl(executionId);
    case 'NO_PROXY':
      return '';
    case 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':
    case 'DISABLE_AUTOUPDATER':
    case 'NODE_USE_ENV_PROXY':
    case 'CI':
      return '1';
    case 'ENABLE_CLAUDEAI_MCP_SERVERS':
      return 'false';
    case 'LANG':
      return 'C.UTF-8';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Names

const JOB_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);
const IMAGE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
const MEMORY = /^[1-9][0-9]{0,5}[kmg]$/;
const MAX_PATH_LENGTH = 1000;
const MAX_ARGV = 200;
const MAX_ARG_LENGTH = 100_000;

function checkExecutionId(executionId: string): void {
  if (typeof executionId !== 'string' || !isExecutionId(executionId)) {
    throw new SandboxInputError('execution id', 'must be <yyyymmddhhmmss>-<6 hex>');
  }
}

function checkJob(job: string): void {
  if (typeof job !== 'string' || !JOB_NAME.test(job)) throw new SandboxInputError('job', 'must match ^[a-z][a-z0-9-]{0,31}$');
  if (job === PROXY_JOB) throw new SandboxInputError('job', `"${PROXY_JOB}" is reserved for the egress proxy`);
}

function checkProfile(profile: string): asserts profile is JobProfile {
  if (!(JOB_PROFILES as readonly string[]).includes(profile)) {
    throw new SandboxInputError('profile', `must be one of ${JOB_PROFILES.join(', ')}`);
  }
}

/** `roster-net-<execution-id>`: the per-execution `--internal` network. */
export function networkName(executionId: string): string {
  checkExecutionId(executionId);
  return `roster-net-${executionId}`;
}

/** `roster-<execution-id>-`: every container of an execution starts with this. */
export function containerPrefix(executionId: string): string {
  checkExecutionId(executionId);
  return `roster-${executionId}-`;
}

/** `roster-<execution-id>-<job>`. */
export function jobContainerName(executionId: string, job: string): string {
  checkJob(job);
  return `${containerPrefix(executionId)}${job}`;
}

/** `roster-<execution-id>-proxy`. */
export function proxyContainerName(executionId: string): string {
  return `${containerPrefix(executionId)}${PROXY_JOB}`;
}

/** `http://roster-<execution-id>-proxy:3128`: the proxy by container name (spike finding 8). */
export function proxyUrl(executionId: string): string {
  return `http://${proxyContainerName(executionId)}:${PROXY_PORT}`;
}

/** True for a container name Roster gave to a container of `executionId`. */
export function isExecutionContainer(executionId: string, name: string): boolean {
  const prefix = containerPrefix(executionId);
  return name.startsWith(prefix) && JOB_NAME.test(name.slice(prefix.length));
}

/** Validates an image reference; refuses anything that could be read as an option. */
export function checkImage(image: string, field = 'image'): string {
  if (typeof image !== 'string' || image.length === 0 || image.length > 255 || !IMAGE.test(image)) {
    throw new SandboxInputError(field, 'must be a lowercase image reference such as roster/runtime-claude:<commit>');
  }
  return image;
}

/** The proxy's arguments: lowercase host names, `host` or `host:443` accepted, `host` returned. */
export function egressArguments(hosts: readonly string[]): string[] {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new SandboxInputError('egress hosts', 'must not be empty');
  const result: string[] = [];
  for (const entry of hosts) {
    if (typeof entry !== 'string') throw new SandboxInputError('egress hosts', 'must be strings');
    const host = entry.endsWith(`:${PROXY_ALLOWED_PORT}`) ? entry.slice(0, -`:${PROXY_ALLOWED_PORT}`.length) : entry;
    if (!HOSTNAME.test(host)) {
      throw new SandboxInputError('egress hosts', `${JSON.stringify(entry.slice(0, 80))} is not a lowercase host name or host:443`);
    }
    if (!result.includes(host)) result.push(host);
  }
  return result;
}

function checkHostPath(path: string, field: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new SandboxInputError(field, `must be 1 to ${MAX_PATH_LENGTH} characters`);
  }
  // `,` and `"` would break the CSV of `--mount`; control characters have no place in a path.
  if (/[,"\u0000-\u001f\u007f]/.test(path)) throw new SandboxInputError(field, 'must not contain commas, quotes or control characters');
  if (!isAbsolute(path)) throw new SandboxInputError(field, 'must be an absolute path');
  return path;
}

function checkLimits(limits: JobLimitsInput): void {
  if (typeof limits.memory !== 'string' || !MEMORY.test(limits.memory)) {
    throw new SandboxInputError('memory limit', 'must be a number followed by k, m or g, for example 4g');
  }
  if (typeof limits.cpus !== 'number' || !Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 64) {
    throw new SandboxInputError('cpu limit', 'must be a number above 0 and at most 64');
  }
  if (!Number.isInteger(limits.pids) || limits.pids < 16 || limits.pids > 65_536) {
    throw new SandboxInputError('pids limit', 'must be an integer from 16 to 65536');
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

/** One docker command: its arguments and the values its child environment must add. */
export interface DockerCommand {
  readonly args: readonly string[];
  /** Container environment values, forwarded by docker through `--env NAME`. Never in `args`. */
  readonly env: Readonly<Record<string, string>>;
}

export interface JobLimitsInput {
  readonly memory: string;
  readonly cpus: number;
  readonly pids: number;
}

export interface JobMountSources {
  /** `workspaces\<p>\<id>`; the three sources below must be its direct children. */
  readonly root: string;
  readonly tree: string;
  readonly inDir: string;
  readonly outDir: string;
}

export interface JobContainerSpec {
  readonly executionId: string;
  readonly job: string;
  readonly profile: JobProfile;
  readonly image: string;
  /** Command and arguments run inside the container. */
  readonly argv: readonly string[];
  /** Names the job asks for; each must be allowed for the profile. */
  readonly envNames: readonly string[];
  /** Values of the secret names in `envNames`, and of nothing else. */
  readonly envValues: Readonly<Record<string, string>>;
  readonly mounts: JobMountSources;
  readonly limits: JobLimitsInput;
}

function bind(source: string, target: string, readOnly: boolean): string[] {
  return ['--mount', `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`];
}

function mountArgs(profile: JobProfile, mounts: JobMountSources): string[] {
  const rules = PROFILES[profile];
  const root = checkHostPath(mounts.root, 'workspace root');
  const sources = { tree: mounts.tree, inDir: mounts.inDir, outDir: mounts.outDir };
  for (const [field, path] of Object.entries(sources)) {
    checkHostPath(path, `workspace ${field}`);
    if (dirname(path) !== root || basename(path).length === 0) {
      throw new SandboxInputError(`workspace ${field}`, 'must be a direct child of the workspace root');
    }
  }
  if (new Set(Object.values(sources)).size !== 3) throw new SandboxInputError('workspace', 'tree, in and out must differ');

  const args = [...bind(mounts.tree, MOUNT_TARGETS.workspace, rules.workspaceReadOnly), ...bind(mounts.inDir, MOUNT_TARGETS.in, true)];
  if (rules.outMount) args.push(...bind(mounts.outDir, MOUNT_TARGETS.out, false));
  if (rules.managedSettings) {
    args.push(...bind(checkHostPath(join(mounts.inDir, MANAGED_SETTINGS_FILE), 'managed settings'), MOUNT_TARGETS.managedSettings, true));
  }
  return args;
}

/**
 * The names passed with `--env` (profile order) and their values for the docker child: fixed values
 * for non-secret names, request values for the secret names the job asked for.
 */
export function jobEnvironment(
  profile: JobProfile,
  executionId: string,
  envNames: readonly string[],
  envValues: Readonly<Record<string, string>>,
): { readonly names: readonly string[]; readonly values: Readonly<Record<string, string>> } {
  checkProfile(profile);
  checkExecutionId(executionId);
  const rules = PROFILES[profile];
  if (!Array.isArray(envNames)) throw new SandboxInputError('environment', 'must be a list of names');
  for (const name of envNames) {
    if (typeof name !== 'string' || !rules.env.includes(name)) {
      throw new SandboxInputError('environment', `${JSON.stringify(String(name).slice(0, 60))} is not allowed for the ${profile} profile`);
    }
  }
  for (const name of Object.keys(envValues)) {
    if (!rules.secretEnv.includes(name)) {
      throw new SandboxInputError('environment', `a value for ${JSON.stringify(name.slice(0, 60))} is not accepted for the ${profile} profile`);
    }
    if (!envNames.includes(name)) throw new SandboxInputError('environment', `a value is given for ${name}, which the job does not ask for`);
  }

  const names: string[] = [];
  const values: Record<string, string> = {};
  for (const name of rules.env) {
    if (rules.secretEnv.includes(name)) {
      if (!envNames.includes(name)) continue;
      const value = envValues[name];
      // Shape only: the value itself never appears in a message.
      if (typeof value !== 'string' || value.length === 0 || /[\s\u0000]/.test(value)) {
        throw new SandboxInputError('environment', `the value of ${name} is missing, empty or has whitespace`);
      }
      values[name] = value;
    } else {
      values[name] = fixedValue(name, executionId) ?? '';
    }
    names.push(name);
  }
  return { names, values };
}

/** `docker run` of a job container, exactly as in plan 002 section 9.3. */
export function jobRunCommand(spec: JobContainerSpec): DockerCommand {
  checkProfile(spec.profile);
  const rules = PROFILES[spec.profile];
  const name = jobContainerName(spec.executionId, spec.job);
  const image = checkImage(spec.image);
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.length > MAX_ARGV) {
    throw new SandboxInputError('argv', `must have 1 to ${MAX_ARGV} entries`);
  }
  for (const arg of spec.argv) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || arg.includes('\u0000')) {
      throw new SandboxInputError('argv', `entries must be strings of at most ${MAX_ARG_LENGTH} characters without NUL`);
    }
  }
  checkLimits(spec.limits);
  const environment = jobEnvironment(spec.profile, spec.executionId, spec.envNames, spec.envValues);
  const network = rules.network === 'proxy' ? networkName(spec.executionId) : 'none';

  const args = [
    'run',
    '-i',
    '--rm',
    '--pull',
    'never',
    '--name',
    name,
    '--user',
    CONTAINER_USER,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    `${CONTAINER_HOME}:uid=1000,gid=1000`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(spec.limits.pids),
    '--memory',
    spec.limits.memory,
    '--cpus',
    String(spec.limits.cpus),
    '--network',
    network,
    '--dns',
    '0.0.0.0',
    ...mountArgs(spec.profile, spec.mounts),
    ...environment.names.flatMap((envName) => ['--env', envName]),
    image,
    ...spec.argv,
  ];
  return { args, env: environment.values };
}

/** `docker network create --internal roster-net-<execution-id>`: no route out (H7). */
export function networkCreateCommand(executionId: string): DockerCommand {
  return { args: ['network', 'create', '--internal', networkName(executionId)], env: {} };
}

/**
 * `docker create` of the egress proxy: attached to the internal network only; `proxyConnectCommand`
 * adds the default bridge before it starts. Hardened like a job container, no mounts, no environment.
 */
export function proxyCreateCommand(executionId: string, image: string, hosts: readonly string[]): DockerCommand {
  const args = [
    'create',
    '--rm',
    '--pull',
    'never',
    '--name',
    proxyContainerName(executionId),
    '--user',
    CONTAINER_USER,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(PROXY_LIMITS.pids),
    '--memory',
    PROXY_LIMITS.memory,
    '--cpus',
    String(PROXY_LIMITS.cpus),
    '--network',
    networkName(executionId),
    checkImage(image, 'proxy image'),
    ...egressArguments(hosts),
  ];
  return { args, env: {} };
}

/** `docker network connect bridge roster-<execution-id>-proxy`: the proxy's only way out. */
export function proxyConnectCommand(executionId: string): DockerCommand {
  return { args: ['network', 'connect', 'bridge', proxyContainerName(executionId)], env: {} };
}

/** `docker start -a roster-<execution-id>-proxy`: runs the proxy and streams its decision log. */
export function proxyStartCommand(executionId: string): DockerCommand {
  return { args: ['start', '-a', proxyContainerName(executionId)], env: {} };
}
