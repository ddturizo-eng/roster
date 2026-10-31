import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXED_ENV,
  GitInputError,
  PASS_THROUGH_ENV,
  createGitVcs,
  execFileGitRunner,
  removeGitEntries,
} from '../../../../src/adapters/vcs/git/index.ts';
import type {
  GitCall,
  GitRunner,
  GitVcs,
  PushGuard,
  PushGuardFactory,
  PushGuardRules,
} from '../../../../src/adapters/vcs/git/index.ts';
import { createPushGuard } from '../../../../src/adapters/vcs/push-guard.ts';
import {
  ExternalCommandError,
  NotFoundError,
  PushRejectedError,
  RosterError,
} from '../../../../src/core/domain/errors.ts';
import type { GitWorkspace, WorkspaceSource } from '../../../../src/ports/vcs.ts';

// Real git against temporary repositories: `origin.git` is a bare repository standing in for GitHub,
// `local` is the human's clone of it (the project's `repoPath`). The adapter runs with a hostile
// global git config (hooks path, fsmonitor, gpg signing, autocrlf) to prove its `-c` settings win.

const FAKE_TOKEN = 'ghp_FAKE0123456789abcdefFAKE0123456789ab';
const PARENT_TOKEN = 'ghp_PARENTshouldNEVERreachGIT0000000000';
const AUTHOR = { name: 'Roster Bot', email: 'roster@example.invalid' };
const HOOK_NAMES = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-checkout',
  'reference-transaction',
  'pre-push',
  'pre-auto-gc',
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const slash = (path: string): string => path.replace(/\\/g, '/');

function hookScript(marker: string): string {
  return `#!/bin/sh\necho ran >> "${slash(marker)}"\nexit 0\n`;
}

function plantHooks(hooksDir: string, markers: string, prefix: string): void {
  mkdirSync(hooksDir, { recursive: true });
  for (const name of [...HOOK_NAMES, 'fsmonitor']) {
    writeFileSync(join(hooksDir, name), hookScript(join(markers, `${prefix}${name}`)), { mode: 0o755 });
  }
}

interface Fixture {
  readonly base: string;
  readonly origin: string;
  readonly local: string;
  readonly markers: string;
  readonly workspaceRoot: string;
  readonly emptyDir: string;
  readonly adapterHome: string;
  readonly calls: GitCall[];
  readonly guardChecks: string[][];
  /** Rules every call of the guard factory received, in order. */
  readonly factoryCalls: PushGuardRules[];
  readonly vcs: GitVcs;
  readonly source: WorkspaceSource;
  /** Runs the test's own git (not the adapter) with an isolated, harmless config. */
  git(cwd: string, args: readonly string[], env?: Record<string, string>): string;
  /** Set to make the recording runner answer `push` calls with this failure instead of running git. */
  failPush: { stderr: string } | null;
}

let executionCounter = 0;
function nextExecutionId(): string {
  executionCounter += 1;
  return `20261030120000-${executionCounter.toString(16).padStart(6, '0')}`;
}

function setup(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'roster-git-'));
  dirs.push(base);
  const helperHome = join(base, 'helper-home');
  const adapterHome = join(base, 'adapter-home');
  const markers = join(base, 'markers');
  const hostileHooks = join(base, 'hostile-hooks');
  for (const dir of [helperHome, adapterHome, markers]) mkdirSync(dir, { recursive: true });
  plantHooks(hostileHooks, markers, 'global-');
  writeFileSync(
    join(adapterHome, '.gitconfig'),
    [
      '[core]',
      `\thooksPath = ${slash(hostileHooks)}`,
      `\tfsmonitor = ${slash(join(hostileHooks, 'fsmonitor'))}`,
      '\tautocrlf = true',
      '[commit]',
      '\tgpgsign = true',
      '[push]',
      '\tfollowTags = true',
      '',
    ].join('\n'),
  );

  const helperEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    HOME: helperHome,
    USERPROFILE: helperHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Seed',
    GIT_AUTHOR_EMAIL: 'seed@example.invalid',
    GIT_COMMITTER_NAME: 'Seed',
    GIT_COMMITTER_EMAIL: 'seed@example.invalid',
  };
  const git = (cwd: string, args: readonly string[], env: Record<string, string> = {}): string =>
    execFileSync(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
      { cwd, env: { ...helperEnv, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '--quiet']);
  const files: Record<string, string> = {
    'a.txt': 'a\n',
    'b.txt': 'b\n',
    '.gitignore': 'ignored/\n',
    'projects/one.json': '{"name":"one"}\n',
    'projects/two.json': '{"name":"two"}\n',
    'docs/readme.md': '# docs\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), content);
  }
  git(seed, ['add', '--all']);
  git(seed, ['commit', '--quiet', '-m', 'init']);
  git(seed, ['tag', '-a', 'v1', '-m', 'v1']);
  // A gitflow base branch one commit ahead of `main` (ADR 0032).
  git(seed, ['checkout', '--quiet', '-b', 'develop']);
  writeFileSync(join(seed, 'develop-only.txt'), 'd\n');
  git(seed, ['add', '--all']);
  git(seed, ['commit', '--quiet', '-m', 'develop']);
  git(seed, ['checkout', '--quiet', 'main']);

  const origin = join(base, 'origin.git');
  git(base, ['clone', '--quiet', '--bare', seed, origin]);
  // `origin.git` stands in for GitHub. A push over the local transport starts `git-receive-pack`
  // in it without the pusher's `-c` settings (git drops them for local transports), so it would
  // read the hostile global config of the adapter's HOME. The remote's own hooks are GitHub's side,
  // outside this adapter, so they are pinned off here.
  const originHooks = join(base, 'origin-hooks');
  mkdirSync(originHooks);
  git(origin, ['config', 'core.hooksPath', originHooks]);
  const local = join(base, 'local');
  git(base, ['clone', '--quiet', origin, local]);

  // A branch on origin that a run can resume, and a branch that exists only in the local repo.
  git(local, ['checkout', '--quiet', '-b', 'agent/001-T01']);
  writeFileSync(join(local, 'c.txt'), 'c\n');
  git(local, ['add', '--all']);
  git(local, ['commit', '--quiet', '-m', 'c']);
  git(local, ['push', '--quiet', 'origin', 'agent/001-T01']);
  git(local, ['checkout', '--quiet', 'main']);
  git(local, ['branch', 'agent/001-T03']);

  const workspaceRoot = join(base, 'workspaces');
  const emptyDir = join(workspaceRoot, '.empty-hooks');
  const calls: GitCall[] = [];
  const guardChecks: string[][] = [];
  const factoryCalls: PushGuardRules[] = [];
  const real = execFileGitRunner();
  const fixture: Fixture = {
    base,
    origin,
    local,
    markers,
    workspaceRoot,
    emptyDir,
    adapterHome,
    calls,
    guardChecks,
    factoryCalls,
    git,
    failPush: null,
    source: { name: 'demo', repoPath: local, remoteUrl: origin, baseBranch: 'main', branchPrefix: 'agent' },
    vcs: undefined as unknown as GitVcs,
  };
  const runner: GitRunner = async (call) => {
    calls.push(call);
    if (fixture.failPush !== null && call.args.includes('push')) {
      return { exitCode: 128, stdout: '', stderr: fixture.failPush.stderr };
    }
    return real(call);
  };
  const spyFactory: PushGuardFactory = (rules) => {
    factoryCalls.push(rules);
    const guard = createPushGuard(rules);
    return {
      pushArguments: (branch) => guard.pushArguments(branch),
      assertSafePush: (argv) => {
        guardChecks.push([...argv]);
        guard.assertSafePush(argv);
      },
    };
  };
  const vcs = createGitVcs({
    workspaceRoot,
    pushGuard: spyFactory,
    runner,
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: adapterHome,
      USERPROFILE: adapterHome,
      GH_TOKEN: PARENT_TOKEN,
      GITHUB_TOKEN: PARENT_TOKEN,
      GIT_DIR: join(base, 'evil-git-dir'),
      GIT_CONFIG_PARAMETERS: "'core.hookspath=/evil'",
    },
  });
  return Object.assign(fixture, { vcs });
}

function safe(gitDir: string, workTree: string, emptyDir: string): string[] {
  return [
    `--git-dir=${gitDir}`,
    `--work-tree=${workTree}`,
    '-c',
    `core.hooksPath=${emptyDir}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.autocrlf=false',
    '-c',
    'credential.helper=',
  ];
}

async function workspace(f: Fixture): Promise<GitWorkspace> {
  return f.vcs.createWorkspace(f.source, nextExecutionId());
}

function wsGit(f: Fixture, ws: GitWorkspace, args: readonly string[]): string {
  return f.git(f.base, [`--git-dir=${ws.paths.gitDir}`, `--work-tree=${ws.paths.tree}`, ...args]);
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function markers(f: Fixture): string[] {
  return readdirSync(f.markers).sort();
}

const allowedEnvNames = new Set<string>([...PASS_THROUGH_ENV, ...Object.keys(FIXED_ENV)]);

function expectCleanEnv(call: GitCall): void {
  for (const name of Object.keys(call.env)) expect(allowedEnvNames.has(name), name).toBe(true);
  expect(call.env.GIT_TERMINAL_PROMPT).toBe('0');
}

describe('GitVcs workspaces', { timeout: 120_000 }, () => {
  it('builds the workspace with exact git calls, a separate git dir and no .git in the work tree', async () => {
    const f = setup();
    const id = nextExecutionId();
    const ws = await f.vcs.createWorkspace(f.source, id);

    const root = join(f.workspaceRoot, 'demo', id);
    expect(ws.paths).toEqual({
      root,
      gitDir: join(root, 'git'),
      tree: join(root, 'tree'),
      inDir: join(root, 'in'),
      outDir: join(root, 'out'),
    });
    const prefix = safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir);
    expect(f.calls.map((call) => call.args)).toEqual([
      [...prefix, 'init', '--quiet', `--template=${f.emptyDir}`, '--initial-branch=main'],
      [...prefix, 'remote', 'add', 'origin', f.local],
      [...prefix, 'fetch', '--quiet', '--no-tags', 'origin'],
      [...prefix, 'remote', 'set-url', 'origin', f.origin],
      [...prefix, 'fetch', '--quiet', '--no-tags', '--prune', 'origin'],
    ]);
    for (const call of f.calls) {
      expect(call.cwd).toBe(f.emptyDir);
      expectCleanEnv(call);
      expect(call.env.GH_TOKEN).toBeUndefined();
    }

    expect(readdirSync(ws.paths.tree)).toEqual([]);
    expect(existsSync(join(ws.paths.gitDir, 'HEAD'))).toBe(true);
    expect(existsSync(ws.paths.inDir) && existsSync(ws.paths.outDir)).toBe(true);
    expect(readdirSync(f.emptyDir)).toEqual([]);
    expect(existsSync(join(ws.paths.gitDir, 'hooks'))).toBe(false);
    expect(wsGit(f, ws, ['config', 'remote.origin.url']).trim()).toBe(f.origin);
    // `origin/*` mirrors the GitHub stand-in: the local-only branch was pruned. (Newer git also
    // records `origin/HEAD` on fetch; it is not a branch.)
    const remoteRefs = wsGit(f, ws, ['for-each-ref', '--format=%(refname)', 'refs/remotes']).trim().split('\n');
    expect(remoteRefs.filter((ref) => ref !== 'refs/remotes/origin/HEAD')).toEqual([
      'refs/remotes/origin/agent/001-T01',
      'refs/remotes/origin/develop',
      'refs/remotes/origin/main',
    ]);
    expect(markers(f)).toEqual([]);
    // The guard factory ran once, with a frozen copy of the source's rules.
    expect(f.factoryCalls).toEqual([{ baseBranch: 'main', branchPrefix: 'agent' }]);
    expect(Object.isFrozen(f.factoryCalls[0])).toBe(true);
  });

  it('refuses invalid branch rules through the guard before writing or running anything', async () => {
    const f = setup();
    const cases: Partial<PushGuardRules>[] = [
      { branchPrefix: 'main' },
      { branchPrefix: 'Feature' },
      { baseBranch: 'agent/main' },
      { baseBranch: 'feature', branchPrefix: 'feature' },
      { baseBranch: '-x' },
    ];
    for (const rules of cases) {
      const error = await f.vcs.createWorkspace({ ...f.source, ...rules }, nextExecutionId()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PushRejectedError);
    }
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.workspaceRoot, 'demo'))).toBe(false);
  });

  it('calls the guard factory once per workspace and keeps the rules it was created with', async () => {
    const f = setup();
    const source = { ...f.source, baseBranch: 'develop', branchPrefix: 'feature' };
    const ws = await f.vcs.createWorkspace(source, nextExecutionId());
    // Changing the caller's object afterwards changes nothing in the workspace.
    source.baseBranch = 'main';
    source.branchPrefix = 'agent';
    expect(await ws.prepareBranch('feature/agent-001-T02')).toEqual({ resumed: false });
    expect(await ws.headCommit()).toBe(f.git(f.origin, ['rev-parse', 'refs/heads/develop']).trim());
    const callsBefore = f.calls.length;
    await expect(ws.push('agent/001-T02', FAKE_TOKEN)).rejects.toBeInstanceOf(PushRejectedError);
    expect(f.calls.length).toBe(callsBefore);
    expect(f.factoryCalls).toEqual([{ baseBranch: 'develop', branchPrefix: 'feature' }]);
  });

  it('refuses unsafe inputs before running git', async () => {
    const f = setup();
    const id = nextExecutionId();
    const cases: [WorkspaceSource, string][] = [
      [f.source, '2026-bad'],
      [f.source, '../20261030120000-abcdef'],
      [{ ...f.source, name: '../evil' }, id],
      [{ ...f.source, name: 'Demo' }, id],
      [{ ...f.source, repoPath: 'relative/repo' }, id],
      [{ ...f.source, repoPath: '--upload-pack=evil' }, id],
      [{ ...f.source, remoteUrl: '--upload-pack=evil' }, id],
      [{ ...f.source, remoteUrl: 'ext::sh -c evil' }, id],
      [{ ...f.source, remoteUrl: 'https://github.com/o/r\nx' }, id],
    ];
    for (const [source, executionId] of cases) {
      await expect(f.vcs.createWorkspace(source, executionId)).rejects.toBeInstanceOf(GitInputError);
    }
    expect(f.calls).toEqual([]);

    await f.vcs.createWorkspace(f.source, id);
    await expect(f.vcs.createWorkspace(f.source, id)).rejects.toThrow(/already exists/);
  });

  it('refuses to run git when the empty hooks directory is not empty', async () => {
    const f = setup();
    mkdirSync(f.emptyDir, { recursive: true });
    writeFileSync(join(f.emptyDir, 'pre-commit'), hookScript(join(f.markers, 'planted')));
    await expect(workspace(f)).rejects.toBeInstanceOf(RosterError);
    expect(f.calls).toEqual([]);
  });

  it('requires a push guard factory and an absolute workspace root', () => {
    expect(() => createGitVcs({ workspaceRoot: 'relative', pushGuard: createPushGuard })).toThrow(GitInputError);
    expect(() => createGitVcs({ workspaceRoot: tmpdir(), pushGuard: undefined as unknown as PushGuardFactory })).toThrow(
      GitInputError,
    );
    // A bound guard object instead of the factory is refused too.
    const bound = createPushGuard({ baseBranch: 'main', branchPrefix: 'agent' });
    expect(() => createGitVcs({ workspaceRoot: tmpdir(), pushGuard: bound as unknown as PushGuardFactory })).toThrow(
      GitInputError,
    );
  });

  it('refuses a factory that does not return a guard', async () => {
    const f = setup();
    const vcs = createGitVcs({
      workspaceRoot: join(f.base, 'other-workspaces'),
      pushGuard: (() => ({})) as unknown as PushGuardFactory,
      runner: async (call) => {
        f.calls.push(call);
        return execFileGitRunner()(call);
      },
    });
    await expect(vcs.createWorkspace(f.source, nextExecutionId())).rejects.toBeInstanceOf(GitInputError);
    expect(f.calls).toEqual([]);
  });
});

describe('GitWorkspace.prepareBranch', { timeout: 120_000 }, () => {
  it('resumes a branch that exists on origin', async () => {
    const f = setup();
    const ws = await workspace(f);
    f.calls.length = 0;

    expect(await ws.prepareBranch('agent/001-T01')).toEqual({ resumed: true });

    const prefix = safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir);
    expect(f.calls.map((call) => call.args)).toEqual([
      [...prefix, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/agent/001-T01^{commit}'],
      [...prefix, 'checkout', '--quiet', '--no-track', '-B', 'agent/001-T01', 'refs/remotes/origin/agent/001-T01'],
    ]);
    const originHead = f.git(f.origin, ['rev-parse', 'refs/heads/agent/001-T01']).trim();
    expect(await ws.headCommit()).toBe(originHead);
    expect(readFileSync(join(ws.paths.tree, 'c.txt'), 'utf8')).toBe('c\n');
    expect(wsGit(f, ws, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/agent/001-T01');
    expect(existsSync(join(ws.paths.tree, '.git'))).toBe(false);
  });

  it('creates a fresh branch from origin/main', async () => {
    const f = setup();
    const ws = await workspace(f);
    f.calls.length = 0;

    expect(await ws.prepareBranch('agent/001-T02')).toEqual({ resumed: false });

    const prefix = safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir);
    expect(f.calls.map((call) => call.args)).toEqual([
      [...prefix, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/agent/001-T02^{commit}'],
      [...prefix, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      [...prefix, 'checkout', '--quiet', '--no-track', '-B', 'agent/001-T02', 'refs/remotes/origin/main'],
    ]);
    expect(await ws.headCommit()).toBe(f.git(f.origin, ['rev-parse', 'refs/heads/main']).trim());
    expect(existsSync(join(ws.paths.tree, 'c.txt'))).toBe(false);
  });

  it('creates a fresh branch from origin/develop when the base branch is develop', async () => {
    const f = setup();
    const ws = await f.vcs.createWorkspace({ ...f.source, baseBranch: 'develop', branchPrefix: 'feature' }, nextExecutionId());
    f.calls.length = 0;

    expect(await ws.prepareBranch('feature/agent-001-T02')).toEqual({ resumed: false });

    const prefix = safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir);
    expect(f.calls.map((call) => call.args)).toEqual([
      [...prefix, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature/agent-001-T02^{commit}'],
      [...prefix, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/develop^{commit}'],
      [...prefix, 'checkout', '--quiet', '--no-track', '-B', 'feature/agent-001-T02', 'refs/remotes/origin/develop'],
    ]);
    expect(await ws.headCommit()).toBe(f.git(f.origin, ['rev-parse', 'refs/heads/develop']).trim());
    expect(readFileSync(join(ws.paths.tree, 'develop-only.txt'), 'utf8')).toBe('d\n');
    expect(wsGit(f, ws, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/feature/agent-001-T02');
  });

  it('resumes a branch that exists on origin when the base branch is develop', async () => {
    const f = setup();
    f.git(f.local, ['fetch', '--quiet', 'origin']);
    f.git(f.local, ['checkout', '--quiet', '-b', 'feature/agent-001-T05', 'origin/develop']);
    write(f.local, 'e.txt', 'e\n');
    f.git(f.local, ['add', '--all']);
    f.git(f.local, ['commit', '--quiet', '-m', 'e']);
    f.git(f.local, ['push', '--quiet', 'origin', 'feature/agent-001-T05']);
    f.git(f.local, ['checkout', '--quiet', 'main']);

    const ws = await f.vcs.createWorkspace({ ...f.source, baseBranch: 'develop', branchPrefix: 'feature' }, nextExecutionId());
    f.calls.length = 0;
    expect(await ws.prepareBranch('feature/agent-001-T05')).toEqual({ resumed: true });
    const prefix = safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir);
    expect(f.calls.map((call) => call.args)).toEqual([
      [...prefix, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature/agent-001-T05^{commit}'],
      [
        ...prefix,
        'checkout',
        '--quiet',
        '--no-track',
        '-B',
        'feature/agent-001-T05',
        'refs/remotes/origin/feature/agent-001-T05',
      ],
    ]);
    expect(await ws.headCommit()).toBe(f.git(f.origin, ['rev-parse', 'refs/heads/feature/agent-001-T05']).trim());
    expect(readFileSync(join(ws.paths.tree, 'e.txt'), 'utf8')).toBe('e\n');
    expect(readFileSync(join(ws.paths.tree, 'develop-only.txt'), 'utf8')).toBe('d\n');
  });

  it('fails with NotFoundError naming origin/<baseBranch> when the base branch is missing', async () => {
    const f = setup();
    const ws = await f.vcs.createWorkspace({ ...f.source, baseBranch: 'trunk' }, nextExecutionId());
    const error = await ws.prepareBranch('agent/001-T02').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).id).toBe('origin/trunk');
    expect((error as Error).message).toBe('git ref not found: origin/trunk');
    expect(f.calls.some((call) => call.args.includes('checkout'))).toBe(false);
  });

  it('does not resume a branch that exists only in the local repo', async () => {
    const f = setup();
    const ws = await workspace(f);
    expect(await ws.prepareBranch('agent/001-T03')).toEqual({ resumed: false });
  });

  it('refuses names that are not plain branch names', async () => {
    const f = setup();
    const ws = await workspace(f);
    f.calls.length = 0;
    for (const name of ['-b', 'agent/../main', 'agent/x.lock', 'agent/x@{1}', 'a b', '', 'agent/']) {
      await expect(ws.prepareBranch(name)).rejects.toBeInstanceOf(GitInputError);
    }
    expect(f.calls).toEqual([]);
  });
});

describe('GitWorkspace.changedPaths and commitAll', { timeout: 120_000 }, () => {
  it('lists modified, deleted and new files, not ignored ones, committed or not', async () => {
    const f = setup();
    const ws = await workspace(f);
    await ws.prepareBranch('agent/001-T02');
    write(ws.paths.tree, 'a.txt', 'changed\n');
    rmSync(join(ws.paths.tree, 'b.txt'));
    write(ws.paths.tree, 'new/n.txt', 'n\n');
    write(ws.paths.tree, 'ignored/x.txt', 'x\n');
    f.calls.length = 0;

    expect(await ws.changedPaths('origin/main')).toEqual(['a.txt', 'b.txt', 'new/n.txt']);
    const prefix = safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir);
    const mainId = f.git(f.origin, ['rev-parse', 'refs/heads/main']).trim();
    expect(f.calls.map((call) => call.args)).toEqual([
      [...prefix, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}'],
      [...prefix, 'diff', '--name-only', '-z', '--no-renames', '--no-relative', '--merge-base', mainId],
      [...prefix, 'log', '--format=', '--name-only', '-z', '--no-renames', '--no-relative', `${mainId}..HEAD`],
      [...prefix, 'ls-files', '--others', '--exclude-standard', '--full-name', '-z'],
    ]);

    expect(await ws.commitAll('001-T02: change files', AUTHOR)).toMatch(/^[0-9a-f]{40}$/);
    expect(await ws.changedPaths('origin/main')).toEqual(['a.txt', 'b.txt', 'new/n.txt']);
  });

  it('uses the merge base and every commit of the range', async () => {
    const f = setup();
    // On the resumable branch: add a protected file in one commit and remove it in the next.
    f.git(f.local, ['checkout', '--quiet', 'agent/001-T01']);
    write(f.local, 'policies/p.json', '{}\n');
    f.git(f.local, ['add', '--all']);
    f.git(f.local, ['commit', '--quiet', '-m', 'add protected']);
    f.git(f.local, ['rm', '--quiet', 'policies/p.json']);
    f.git(f.local, ['commit', '--quiet', '-m', 'remove protected']);
    f.git(f.local, ['push', '--quiet', 'origin', 'agent/001-T01']);
    // Meanwhile `main` moves on.
    f.git(f.local, ['checkout', '--quiet', 'main']);
    write(f.local, 'main-only.txt', 'm\n');
    f.git(f.local, ['add', '--all']);
    f.git(f.local, ['commit', '--quiet', '-m', 'main moves']);
    f.git(f.local, ['push', '--quiet', 'origin', 'main']);

    const ws = await workspace(f);
    expect(await ws.prepareBranch('agent/001-T01')).toEqual({ resumed: true });
    expect(await ws.changedPaths('origin/main')).toEqual(['c.txt', 'policies/p.json']);
  });

  it('returns null when there is nothing to commit, and commits as the given author otherwise', async () => {
    const f = setup();
    const ws = await workspace(f);
    await ws.prepareBranch('agent/001-T02');
    const before = await ws.headCommit();
    f.calls.length = 0;

    expect(await ws.commitAll('001-T02: nothing', AUTHOR)).toBeNull();
    const prefix = safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir);
    expect(f.calls.map((call) => call.args)).toEqual([
      [...prefix, 'add', '--all'],
      [...prefix, 'diff', '--cached', '--quiet', '--no-ext-diff'],
    ]);
    expect(await ws.headCommit()).toBe(before);

    write(ws.paths.tree, 'crlf.txt', 'one\r\ntwo\r\n');
    f.calls.length = 0;
    const message = '001-T02: add crlf file\n\nAgent: specialist\nExecution: 20261030120000-abcdef\n# kept line';
    const id = await ws.commitAll(message, AUTHOR);

    const commitCall = f.calls.find((call) => call.args.includes('commit'));
    expect(commitCall?.args).toEqual([
      ...prefix,
      'commit',
      '--quiet',
      '--no-verify',
      '--no-gpg-sign',
      '--cleanup=whitespace',
      '--file=-',
    ]);
    expect(commitCall?.input).toBe(message);
    expect(commitCall?.env).toMatchObject({
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
    });
    expect(id).toBe(await ws.headCommit());
    expect(id).not.toBe(before);
    const logged = wsGit(f, ws, ['log', '-1', '--format=%an|%ae|%cn|%ce|%B', 'HEAD']).trim();
    expect(logged).toBe(`${AUTHOR.name}|${AUTHOR.email}|${AUTHOR.name}|${AUTHOR.email}|${message}`);
    // core.autocrlf=false wins over the hostile global `autocrlf = true`: bytes are kept.
    expect(await ws.showFile('HEAD', 'crlf.txt')).toBe('one\r\ntwo\r\n');
  });

  it('refuses invalid commit messages and authors', async () => {
    const f = setup();
    const ws = await workspace(f);
    await ws.prepareBranch('agent/001-T02');
    f.calls.length = 0;
    await expect(ws.commitAll('', AUTHOR)).rejects.toBeInstanceOf(GitInputError);
    await expect(ws.commitAll('x\0y', AUTHOR)).rejects.toBeInstanceOf(GitInputError);
    await expect(ws.commitAll('ok', { name: 'a\nb', email: 'e@x' })).rejects.toBeInstanceOf(GitInputError);
    await expect(ws.commitAll('ok', { name: 'a', email: '<e@x>' })).rejects.toBeInstanceOf(GitInputError);
    expect(f.calls).toEqual([]);
  });
});

describe('hostile repositories and work trees', { timeout: 120_000 }, () => {
  it('never runs hooks planted in the clone source, the workspace git dir or the global config', async () => {
    const f = setup();
    plantHooks(join(f.local, '.git', 'hooks'), f.markers, 'source-');
    // Control: the planted hooks are real. A plain commit in the source runs its pre-commit hook,
    // and a commit under the hostile global config runs the global one.
    f.git(f.local, ['commit', '--quiet', '--allow-empty', '-m', 'control']);
    expect(markers(f)).toContain('source-pre-commit');
    const control = join(f.base, 'control');
    f.git(f.base, ['init', '--quiet', control]);
    f.git(control, ['commit', '--quiet', '--allow-empty', '-m', 'control'], {
      HOME: f.adapterHome,
      USERPROFILE: f.adapterHome,
    });
    expect(markers(f)).toContain('global-pre-commit');
    for (const marker of markers(f)) rmSync(join(f.markers, marker));

    const ws = await workspace(f);
    plantHooks(join(ws.paths.gitDir, 'hooks'), f.markers, 'workspace-');
    await ws.prepareBranch('agent/001-T02');
    write(ws.paths.tree, 'work.txt', 'work\n');
    await ws.changedPaths('origin/main');
    expect(await ws.commitAll('001-T02: work', AUTHOR)).not.toBeNull();
    await ws.push('agent/001-T02', FAKE_TOKEN);
    await f.vcs.fetch(f.local);
    await f.vcs.showFile(f.local, 'origin/main', 'a.txt');

    expect(markers(f)).toEqual([]);
  });

  it('deletes .git entries the work tree gains, top-level and nested, before listing or committing', async () => {
    const f = setup();
    const ws = await workspace(f);
    await ws.prepareBranch('agent/001-T02');
    const fsmonitorConfig = `[core]\n\tfsmonitor = ${slash(join(f.base, 'hostile-hooks', 'fsmonitor'))}\n`;
    write(ws.paths.tree, '.git/config', fsmonitorConfig);
    write(ws.paths.tree, '.git/HEAD', 'ref: refs/heads/main\n');
    plantHooks(join(ws.paths.tree, '.git', 'hooks'), f.markers, 'tree-');
    write(ws.paths.tree, 'sub/.git/config', fsmonitorConfig);
    write(ws.paths.tree, 'sub/.git/HEAD', 'ref: refs/heads/main\n');
    mkdirSync(join(ws.paths.tree, 'sub', '.git', 'objects'), { recursive: true });
    mkdirSync(join(ws.paths.tree, 'sub', '.git', 'refs'), { recursive: true });
    write(ws.paths.tree, 'sub/f.txt', 'f\n');
    write(ws.paths.tree, 'deep/er/.git', 'gitdir: ../../../evil\n');

    expect(await ws.changedPaths('origin/main')).toEqual(['sub/f.txt']);
    expect(existsSync(join(ws.paths.tree, '.git'))).toBe(false);
    expect(existsSync(join(ws.paths.tree, 'sub', '.git'))).toBe(false);
    expect(existsSync(join(ws.paths.tree, 'deep', 'er', '.git'))).toBe(false);

    write(ws.paths.tree, 'sub/.git/HEAD', 'ref: refs/heads/main\n');
    expect(await ws.commitAll('001-T02: sub', AUTHOR)).not.toBeNull();
    expect(existsSync(join(ws.paths.tree, 'sub', '.git'))).toBe(false);
    // `sub` is a plain directory in the commit, not a gitlink (mode 160000).
    expect(wsGit(f, ws, ['ls-tree', '-r', 'HEAD', 'sub']).trim()).toMatch(/^100644 blob [0-9a-f]{40}\tsub\/f\.txt$/);
    expect(markers(f)).toEqual([]);
  });

  it('removeGitEntries removes .git in any case and keeps everything else', () => {
    const root = mkdtempSync(join(tmpdir(), 'roster-dotgit-'));
    dirs.push(root);
    write(root, 'a/.Git/config', 'x');
    write(root, 'a/keep.txt', 'k');
    write(root, 'b/c/.GIT', 'gitdir: x');
    write(root, 'b/c/.gitignore', 'x');
    write(root, '.github/workflows/ci.yml', 'x');
    removeGitEntries(root);
    expect(readdirSync(join(root, 'a'))).toEqual(['keep.txt']);
    expect(readdirSync(join(root, 'b', 'c'))).toEqual(['.gitignore']);
    expect(existsSync(join(root, '.github', 'workflows', 'ci.yml'))).toBe(true);
  });
});

describe('GitWorkspace.showFile and headCommit', { timeout: 120_000 }, () => {
  it('reads blobs at a ref and returns null for missing paths and directories', async () => {
    const f = setup();
    const ws = await workspace(f);
    await ws.prepareBranch('agent/001-T01');
    expect(await ws.showFile('origin/main', 'projects/one.json')).toBe('{"name":"one"}\n');
    expect(await ws.showFile('HEAD', 'c.txt')).toBe('c\n');
    expect(await ws.showFile('origin/main', 'c.txt')).toBeNull();
    expect(await ws.showFile('origin/main', 'projects')).toBeNull();
    await expect(ws.showFile('origin/nope', 'a.txt')).rejects.toBeInstanceOf(NotFoundError);
    await expect(ws.showFile('-p', 'a.txt')).rejects.toBeInstanceOf(GitInputError);
    for (const path of ['../a.txt', '/a.txt', 'a\\b.txt', '', 'a//b', './a.txt', '-x']) {
      await expect(ws.showFile('HEAD', path)).rejects.toBeInstanceOf(GitInputError);
    }
  });

  it('fails headCommit before any branch is prepared', async () => {
    const f = setup();
    const ws = await workspace(f);
    await expect(ws.headCommit()).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('GitWorkspace.push', { timeout: 120_000 }, () => {
  async function committed(f: Fixture, branch: string): Promise<GitWorkspace> {
    const ws = await workspace(f);
    await ws.prepareBranch(branch);
    write(ws.paths.tree, 'pushed.txt', 'p\n');
    await ws.commitAll(`${branch}: work`, AUTHOR);
    return ws;
  }

  it('pushes an agent branch through the guard with the token only in the push child', async () => {
    const f = setup();
    const ws = await committed(f, 'agent/001-T02');
    const head = await ws.headCommit();
    const firstPushCall = f.calls.length;

    await ws.push('agent/001-T02', FAKE_TOKEN);

    expect(f.git(f.origin, ['rev-parse', 'refs/heads/agent/001-T02']).trim()).toBe(head);
    const pushCalls = f.calls.slice(firstPushCall);
    expect(pushCalls).toHaveLength(1);
    const [pushCall] = pushCalls;
    const expected = [
      ...safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir),
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      '--no-verify',
      '--no-follow-tags',
      '--no-signed',
      '--recurse-submodules=no',
      'origin',
      'refs/heads/agent/001-T02:refs/heads/agent/001-T02',
    ];
    expect(pushCall?.args).toEqual(expected);
    expect(f.guardChecks).toEqual([expected]);
    expect(pushCall?.env.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(pushCall?.cwd).toBe(f.emptyDir);
    if (pushCall !== undefined) {
      const { GH_TOKEN: _token, ...rest } = pushCall.env;
      expectCleanEnv({ ...pushCall, env: rest });
    }

    // The token is never an argument, never in any other child's environment, never persisted.
    for (const call of f.calls) {
      expect(call.args.join('\0')).not.toContain(FAKE_TOKEN);
      expect(call.args.join('\0')).not.toContain(PARENT_TOKEN);
      expect(JSON.stringify(call.env)).not.toContain(PARENT_TOKEN);
      if (call !== pushCall) expect(call.env.GH_TOKEN).toBeUndefined();
    }
    for (const config of [join(ws.paths.gitDir, 'config'), join(f.origin, 'config'), join(f.local, '.git', 'config')]) {
      const text = readFileSync(config, 'utf8');
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain('gh auth');
      expect(text).not.toMatch(/helper/);
    }
    // Only the agent branch was added on the remote.
    expect(f.git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads']).trim().split('\n')).toEqual([
      'refs/heads/agent/001-T01',
      'refs/heads/agent/001-T02',
      'refs/heads/develop',
      'refs/heads/main',
    ]);
  });

  it('pushes a feature/agent- branch for a develop-based project and refuses everything else', async () => {
    const f = setup();
    const ws = await f.vcs.createWorkspace({ ...f.source, baseBranch: 'develop', branchPrefix: 'feature' }, nextExecutionId());
    await ws.prepareBranch('feature/agent-001-T02');
    write(ws.paths.tree, 'pushed.txt', 'p\n');
    await ws.commitAll('001-T02: work', AUTHOR);
    const head = await ws.headCommit();
    const developBefore = f.git(f.origin, ['rev-parse', 'refs/heads/develop']).trim();
    const mainBefore = f.git(f.origin, ['rev-parse', 'refs/heads/main']).trim();
    const callsBefore = f.calls.length;

    for (const branch of ['develop', 'main', 'master', 'agent/001-T02', 'feature/login', 'feature/agent-', 'feature/agent-x/y']) {
      const error = await ws.push(branch, FAKE_TOKEN).catch((e: unknown) => e);
      expect(error, branch).toBeInstanceOf(PushRejectedError);
    }
    expect(f.calls.length).toBe(callsBefore);
    expect(f.guardChecks).toEqual([]);

    await ws.push('feature/agent-001-T02', FAKE_TOKEN);
    const pushCall = f.calls.at(-1);
    expect(pushCall?.args).toEqual([
      ...safe(ws.paths.gitDir, ws.paths.tree, f.emptyDir),
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      '--no-verify',
      '--no-follow-tags',
      '--no-signed',
      '--recurse-submodules=no',
      'origin',
      'refs/heads/feature/agent-001-T02:refs/heads/feature/agent-001-T02',
    ]);
    expect(f.guardChecks).toEqual([pushCall?.args]);
    expect(f.git(f.origin, ['rev-parse', 'refs/heads/feature/agent-001-T02']).trim()).toBe(head);
    expect(f.git(f.origin, ['rev-parse', 'refs/heads/develop']).trim()).toBe(developBefore);
    expect(f.git(f.origin, ['rev-parse', 'refs/heads/main']).trim()).toBe(mainBefore);
  });

  it('rejects main and every name outside agent/ before running git', async () => {
    const f = setup();
    const ws = await committed(f, 'agent/001-T02');
    const mainBefore = f.git(f.origin, ['rev-parse', 'refs/heads/main']).trim();
    const callsBefore = f.calls.length;

    for (const branch of ['main', 'refs/heads/main', 'feature/x', '+agent/001-T02', 'agent/001-T02:main', '--force']) {
      const error = await ws.push(branch, FAKE_TOKEN).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PushRejectedError);
      expect((error as Error).message).not.toContain(FAKE_TOKEN);
    }
    expect(f.calls.length).toBe(callsBefore);
    expect(f.guardChecks).toEqual([]);
    expect(f.git(f.origin, ['rev-parse', 'refs/heads/main']).trim()).toBe(mainBefore);
  });

  it('stops when the guard rejects the final argument list', async () => {
    const f = setup();
    const forcing: PushGuardFactory = (rules) => {
      const guard = createPushGuard(rules);
      // A broken guard version that adds --force must still be caught by the argv check.
      const broken: PushGuard = {
        pushArguments: (branch) => [...guard.pushArguments(branch).slice(0, 3), '--force', ...guard.pushArguments(branch).slice(3)],
        assertSafePush: (argv) => guard.assertSafePush(argv),
      };
      return broken;
    };
    const calls: GitCall[] = [];
    const vcs = createGitVcs({
      workspaceRoot: join(f.base, 'other-workspaces'),
      pushGuard: forcing,
      runner: async (call) => {
        calls.push(call);
        return execFileGitRunner()(call);
      },
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: f.adapterHome, USERPROFILE: f.adapterHome },
    });
    const other = await vcs.createWorkspace(f.source, nextExecutionId());
    await other.prepareBranch('agent/001-T02');
    await expect(other.push('agent/001-T02', FAKE_TOKEN)).rejects.toBeInstanceOf(PushRejectedError);
    expect(calls.some((call) => call.args.includes('push'))).toBe(false);
  });

  it('never force-pushes: a non-fast-forward push fails and the remote branch is unchanged', async () => {
    const f = setup();
    const ws = await workspace(f);
    await ws.prepareBranch('agent/001-T01');
    write(ws.paths.tree, 'mine.txt', 'mine\n');
    await ws.commitAll('001-T01: mine', AUTHOR);
    // Someone else moves the remote branch first.
    f.git(f.local, ['checkout', '--quiet', 'agent/001-T01']);
    write(f.local, 'theirs.txt', 'theirs\n');
    f.git(f.local, ['add', '--all']);
    f.git(f.local, ['commit', '--quiet', '-m', 'theirs']);
    f.git(f.local, ['push', '--quiet', 'origin', 'agent/001-T01']);
    const remoteBefore = f.git(f.origin, ['rev-parse', 'refs/heads/agent/001-T01']).trim();

    const error = await ws.push('agent/001-T01', FAKE_TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as ExternalCommandError).program).toBe('git');
    expect((error as Error).message).toMatch(/^git failed \(exit \d+\): push: /);
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
    expect(f.git(f.origin, ['rev-parse', 'refs/heads/agent/001-T01']).trim()).toBe(remoteBefore);
  });

  it('redacts the token from git error output', async () => {
    const f = setup();
    const ws = await committed(f, 'agent/001-T02');
    f.failPush = { stderr: `remote: invalid credentials ${FAKE_TOKEN}\nfatal: Authentication failed for ${FAKE_TOKEN}\n` };
    const error = await ws.push('agent/001-T02', FAKE_TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as Error).message).toBe('git failed (exit 128): push: fatal: Authentication failed for [REDACTED]');
  });

  it('refuses an empty or malformed token without echoing it', async () => {
    const f = setup();
    const ws = await committed(f, 'agent/001-T02');
    const callsBefore = f.calls.length;
    for (const token of ['', 'ghp_x\nghp_y', 'ghp_x y']) {
      const error = await ws.push('agent/001-T02', token).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitInputError);
      if (token.length > 0) expect((error as Error).message).not.toContain(token);
    }
    expect(f.calls.length).toBe(callsBefore);
  });
});

describe('GitVcs local repository reads', { timeout: 120_000 }, () => {
  it('fetches origin and reads blobs, file lists, refs and the last commit touching a path', async () => {
    const f = setup();
    const before = await f.vcs.resolveRef(f.local, 'origin/main');
    // Another clone moves origin/main.
    const other = join(f.base, 'other');
    f.git(f.base, ['clone', '--quiet', f.origin, other]);
    write(other, 'projects/two.json', '{"name":"two","v":2}\n');
    f.git(other, ['add', '--all']);
    f.git(other, ['commit', '--quiet', '-m', 'two v2']);
    f.git(other, ['push', '--quiet', 'origin', 'main']);
    const twoCommit = f.git(other, ['rev-parse', 'HEAD']).trim();
    f.calls.length = 0;

    await f.vcs.fetch(f.local);
    expect(f.calls.map((call) => call.args)).toEqual([
      [...safe(join(f.local, '.git'), f.local, f.emptyDir), 'fetch', '--quiet', 'origin'],
    ]);
    expect(f.calls[0]?.cwd).toBe(f.emptyDir);

    expect(await f.vcs.resolveRef(f.local, 'origin/main')).toBe(twoCommit);
    expect(before).not.toBe(twoCommit);
    expect(await f.vcs.showFile(f.local, 'origin/main', 'projects/two.json')).toBe('{"name":"two","v":2}\n');
    expect(await f.vcs.showFile(f.local, 'origin/main', 'projects/three.json')).toBeNull();
    expect(await f.vcs.listFiles(f.local, 'origin/main', 'projects')).toEqual(['projects/one.json', 'projects/two.json']);
    expect(await f.vcs.listFiles(f.local, 'origin/main', 'projects/')).toEqual(['projects/one.json', 'projects/two.json']);
    expect(await f.vcs.listFiles(f.local, 'origin/main', 'nothing-here')).toEqual([]);
    expect(await f.vcs.lastCommitTouching(f.local, 'origin/main', 'projects/two.json')).toBe(twoCommit);
    expect(await f.vcs.lastCommitTouching(f.local, 'origin/main', 'never.txt')).toBeNull();
    await expect(f.vcs.resolveRef(f.local, 'origin/nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.vcs.listFiles(f.local, 'origin/main', '../x')).rejects.toBeInstanceOf(GitInputError);
  });

  it('reads a linked worktree through its .git file and refuses paths that are not repositories', async () => {
    const f = setup();
    const linked = join(f.base, 'linked');
    f.git(f.local, ['worktree', 'add', '--quiet', linked, 'agent/001-T03']);
    expect(await f.vcs.showFile(linked, 'HEAD', 'a.txt')).toBe('a\n');
    await expect(f.vcs.fetch(join(f.base, 'markers'))).rejects.toBeInstanceOf(GitInputError);
    await expect(f.vcs.fetch('relative/repo')).rejects.toBeInstanceOf(GitInputError);
  });
});
