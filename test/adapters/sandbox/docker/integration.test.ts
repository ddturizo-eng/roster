import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REDACTED, createDockerSandbox } from '../../../../src/adapters/sandbox/docker/index.ts';
import type { WorkspacePaths } from '../../../../src/core/domain/runtime.ts';

// Opt-in integration test against a real Docker (ROSTER_DOCKER_IT=1). It never calls Claude and uses
// no real secret: the "token" is a fake value whose only purpose is to prove it is redacted from the
// logs. It needs the images of T13, built locally:
//   docker build --build-arg ROSTER_COMMIT=<commit> -t roster/runtime-claude:<commit> container/runtime-claude
//   docker build --build-arg ROSTER_COMMIT=<commit> -t roster/egress-proxy:<commit> container/egress-proxy
// The images are taken from ROSTER_DOCKER_IT_RUNTIME_IMAGE and ROSTER_DOCKER_IT_PROXY_IMAGE, else the
// newest local tag of each.

const ENABLED = process.env.ROSTER_DOCKER_IT === '1';
const FAKE_TOKEN = `sk-ant-oat01-FAKEintegration${randomBytes(8).toString('hex')}`;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
}

function newestImage(repository: string): string {
  const tag = docker(['images', repository, '--format', '{{.Tag}}']).split(/\r?\n/)[0];
  if (tag === undefined || tag.length === 0 || tag === '<none>') throw new Error(`no local image ${repository}; build it first`);
  return `${repository}:${tag}`;
}

function executionId(): string {
  const now = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `${now}-${randomBytes(3).toString('hex')}`;
}

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(id: string): { readonly paths: WorkspacePaths; readonly logDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'roster-docker-it-'));
  dirs.push(base);
  const root = join(base, 'workspaces', 'it', id);
  const paths: WorkspacePaths = { root, gitDir: join(root, 'git'), tree: join(root, 'tree'), inDir: join(root, 'in'), outDir: join(root, 'out') };
  for (const dir of [paths.tree, paths.inDir, paths.outDir]) mkdirSync(dir, { recursive: true });
  return { paths, logDir: join(base, 'logs', id) };
}

function leftovers(id: string): { containers: string; networks: string } {
  return {
    containers: docker(['ps', '-a', '--filter', `name=roster-${id}-`, '--format', '{{.Names}}']),
    networks: docker(['network', 'ls', '--filter', `name=roster-net-${id}`, '--format', '{{.Name}}']),
  };
}

const PROBE = `
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const http = require('http');
const canWrite = (p) => { try { fs.writeFileSync(p, 'x'); return true; } catch { return false; } };
const r = {
  uid: process.getuid(), gid: process.getgid(),
  homeEnv: process.env.HOME, ci: process.env.CI ?? null,
  hasToken: process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined,
  ghToken: process.env.GH_TOKEN ?? null,
  root: canWrite('/x'), tmp: canWrite('/tmp/x'), home: canWrite('/home/agent/x'),
  workspace: canWrite('/workspace/probe.txt'), in: canWrite('/roster/in/x'), out: canWrite('/roster/out/x'),
  settings: fs.existsSync('/etc/claude-code/managed-settings.json') ? fs.readFileSync('/etc/claude-code/managed-settings.json', 'utf8') : null,
  settingsWritable: canWrite('/etc/claude-code/managed-settings.json'),
};
const steps = [
  (next) => dns.lookup('example.com', (e) => { r.dns = e ? e.code : 'resolved'; next(); }),
  (next) => {
    const s = net.connect({ host: '1.1.1.1', port: 443 });
    const t = setTimeout(() => { r.direct = 'timeout'; s.destroy(); next(); }, 3000);
    s.on('connect', () => { clearTimeout(t); r.direct = 'connected'; s.destroy(); next(); });
    s.on('error', (e) => { clearTimeout(t); r.direct = e.code; next(); });
  },
  (next) => {
    if (!process.env.HTTPS_PROXY) { r.denied = null; next(); return; }
    const u = new URL(process.env.HTTPS_PROXY);
    const req = http.request({ host: u.hostname, port: u.port, method: 'CONNECT', path: 'example.com:443' });
    req.on('connect', (res, socket) => { r.denied = res.statusCode; socket.destroy(); next(); });
    req.on('error', (e) => { r.denied = e.code; next(); });
    req.end();
  },
];
const run = (i) => {
  if (i < steps.length) { steps[i](() => run(i + 1)); return; }
  console.log(JSON.stringify({ ...r, echo: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }));
  console.error('stderr echo ' + (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'none'));
};
run(0);
`;

describe.skipIf(!ENABLED)('Docker sandbox against a real Docker (ROSTER_DOCKER_IT=1)', () => {
  const runtimeImage = ENABLED ? (process.env.ROSTER_DOCKER_IT_RUNTIME_IMAGE ?? newestImage('roster/runtime-claude')) : '';
  const proxyImage = ENABLED ? (process.env.ROSTER_DOCKER_IT_PROXY_IMAGE ?? newestImage('roster/egress-proxy')) : '';
  const sandbox = ENABLED ? createDockerSandbox({ proxyImage }) : undefined;
  const limits = { memory: '1g', cpus: 1, pids: 256 };

  it('docker is available', async () => {
    expect(await sandbox?.available()).toEqual({ available: true });
  }, 30_000);

  it('agent profile: uid 1000, read-only root, mounts, proxy denial, no route, token redacted from logs', async () => {
    const id = executionId();
    const { paths, logDir } = workspace(id);
    const exit = await sandbox?.run({
      executionId: id,
      job: 'agent',
      profile: 'agent',
      invocation: {
        image: runtimeImage,
        argv: ['node', '-e', PROBE],
        env: ['CLAUDE_CODE_OAUTH_TOKEN'],
        inFiles: [
          { name: 'prompt.md', content: 'probe\n' },
          { name: 'managed-settings.json', content: '{"permissions":{"defaultMode":"dontAsk"}}' },
        ],
        stdinFile: 'prompt.md',
      },
      workspace: paths,
      logPath: join(logDir, 'agent.jsonl'),
      timeoutMs: 120_000,
      limits,
      egressHosts: ['api.anthropic.com'],
      envValues: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
    });
    expect(exit).toMatchObject({ exitCode: 0, timedOut: false, stopped: false });

    const jsonl = readFileSync(join(logDir, 'agent.jsonl'), 'utf8');
    const stderr = readFileSync(join(logDir, 'agent.stderr.log'), 'utf8');
    expect(jsonl + stderr).not.toContain(FAKE_TOKEN);
    expect(stderr).toContain(`stderr echo ${REDACTED}`);
    const probe = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(probe).toMatchObject({
      uid: 1000,
      gid: 1000,
      homeEnv: '/home/agent',
      ci: null,
      hasToken: true,
      ghToken: null,
      root: false,
      tmp: true,
      home: true,
      workspace: true,
      in: false,
      out: true,
      settings: '{"permissions":{"defaultMode":"dontAsk"}}',
      settingsWritable: false,
      denied: 403,
      echo: REDACTED,
    });
    expect(probe.dns).not.toBe('resolved');
    expect(probe.direct).not.toBe('connected');
    expect(readFileSync(join(paths.tree, 'probe.txt'), 'utf8')).toBe('x');
    const proxyLog = readFileSync(join(logDir, 'proxy.log'), 'utf8');
    expect(proxyLog).toContain('"event":"listening"');
    expect(proxyLog).toContain('"decision":"deny"');
    expect(leftovers(id)).toEqual({ containers: '', networks: '' });
  }, 180_000);

  it('verify profile: no network at all and no token', async () => {
    const id = executionId();
    const { paths, logDir } = workspace(id);
    const exit = await sandbox?.run({
      executionId: id,
      job: 'verify',
      profile: 'verify',
      invocation: { image: runtimeImage, argv: ['node', '-e', PROBE], env: [], inFiles: [] },
      workspace: paths,
      logPath: join(logDir, 'verify.log'),
      timeoutMs: 120_000,
      limits,
      egressHosts: [],
      envValues: {},
    });
    expect(exit).toMatchObject({ exitCode: 0, timedOut: false });
    const probe = JSON.parse(readFileSync(join(logDir, 'verify.log'), 'utf8').trim()) as Record<string, unknown>;
    expect(probe).toMatchObject({ uid: 1000, ci: '1', hasToken: false, root: false, workspace: true, in: false, out: false, settings: null, denied: null, echo: null });
    expect(probe.dns).not.toBe('resolved');
    expect(probe.direct).not.toBe('connected');
  }, 180_000);

  it('kills the container at the timeout and leaves no container or network behind', async () => {
    const id = executionId();
    const { paths, logDir } = workspace(id);
    const exit = await sandbox?.run({
      executionId: id,
      job: 'setup',
      profile: 'setup',
      invocation: { image: runtimeImage, argv: ['node', '-e', 'console.log("started"); setTimeout(() => {}, 600000)'], env: [], inFiles: [] },
      workspace: paths,
      logPath: join(logDir, 'setup.log'),
      timeoutMs: 5_000,
      limits,
      egressHosts: ['registry.npmjs.org'],
      envValues: {},
    });
    expect(exit).toMatchObject({ exitCode: null, timedOut: true });
    expect(readFileSync(join(logDir, 'setup.log'), 'utf8')).toBe('started\n');
    expect(leftovers(id)).toEqual({ containers: '', networks: '' });
  }, 180_000);
});
