// Git adapter (VcsPort, plan 002 sections 4.3 and 8, ADR 0018, ADR 0023, ADR 0025, ADR 0029).
//
// Workspaces: `<workspaceRoot>\<project>\<execution-id>\{git, tree, in, out}`. The git dir is separate
// and never mounted; the work tree has no `.git` entry. Instead of `git clone` (which would write a
// `.git` file into the work tree) the workspace is built with `init`, a fetch from the project's
// local path (objects come from disk), then `origin` is pointed at the GitHub remote and fetched with
// `--prune`, so `origin/*` mirrors GitHub and a branch that exists only in the human's local repo is
// never mistaken for a resumable one.
//
// Every git call is `execFile('git', [...])` (runner.ts) with the safe prefix of `safeArgs`:
// `--git-dir`, `--work-tree`, `core.hooksPath` pointed at an empty directory, `core.fsmonitor=false`,
// `core.autocrlf=false` and an empty credential helper list. Git passes `-c` settings on to the git
// processes it spawns, so they hold for those too. Only `push` adds a credential helper, and only
// through the push guard (`../push-guard.ts`). The composition root hands in its factory
// `createPushGuard` as `pushGuard`; `createWorkspace` calls it once with the project's branch rules
// (ADR 0032), and the workspace keeps that guard and base branch for its whole life.
//
// Work tree content is untrusted (prompt injection, ADR 0023): before changed paths are listed and
// before a commit, every `.git` entry anywhere in the work tree is deleted, so neither a planted
// top-level `.git` nor a nested repository (which git would treat as a submodule and run git inside)
// can bring its own config or hooks.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ExternalCommandError, NotFoundError, RosterError } from '../../../core/domain/errors.ts';
import { SLUG_PATTERN, isExecutionId } from '../../../core/domain/ids.ts';
import type { WorkspacePaths } from '../../../core/domain/runtime.ts';
import type { CommitAuthor, GitWorkspace, VcsPort, WorkspaceSource } from '../../../ports/vcs.ts';
import { GitInputError } from './errors.ts';
import { execFileGitRunner, gitEnv } from './runner.ts';
import type { GitOutput, GitRunner } from './runner.ts';

/**
 * The push guard's interface, returned by `createPushGuard` in `src/adapters/vcs/push-guard.ts`
 * (protected). `pushArguments` returns everything after the safe prefix; `assertSafePush` checks the
 * complete argument list right before it runs. Both throw PushRejectedError.
 */
export interface PushGuard {
  pushArguments(branch: string): readonly string[];
  assertSafePush(argv: readonly string[]): void;
}

/** The branch rules a guard is bound to (ADR 0032 section 1). */
export interface PushGuardRules {
  readonly baseBranch: string;
  readonly branchPrefix: string;
}

/** The signature of `createPushGuard`: validates the rules (throws PushRejectedError) and binds a guard. */
export type PushGuardFactory = (rules: PushGuardRules) => PushGuard;

export interface GitVcsOptions {
  /** `workspaces\` under the Roster data dir (machine config `workspaceRoot`). */
  readonly workspaceRoot: string;
  /**
   * `createPushGuard` from `src/adapters/vcs/push-guard.ts`, called once per workspace with the
   * source's rules. Required: there is no unguarded push.
   */
  readonly pushGuard: PushGuardFactory;
  /** Defaults to `execFileGitRunner()`. Tests wrap it to record calls. */
  readonly runner?: GitRunner;
  /** Environment the allowlist is taken from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Empty directory used as `core.hooksPath` and init template. Defaults to `<workspaceRoot>\.empty-hooks`. */
  readonly emptyDir?: string;
}

const HEX_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF_CHARS = /^[A-Za-z0-9._/@^~{}-]+$/;
const BRANCH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_MESSAGE_LENGTH = 10_000;

/** The arguments every git call starts with (ADR 0023). */
export function safeArgs(gitDir: string, workTree: string, emptyDir: string): string[] {
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

function checkRef(ref: string, field = 'ref'): void {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 250) throw new GitInputError(field, 'must be 1 to 250 characters');
  if (ref.startsWith('-')) throw new GitInputError(field, 'must not start with "-"');
  if (!REF_CHARS.test(ref)) throw new GitInputError(field, 'has characters git refs do not use');
}

function checkBranchName(name: string, field = 'branch'): void {
  checkRef(name, field);
  if (name.includes('..') || name.endsWith('/') || name.startsWith('/') || /[@^~{}]/.test(name)) {
    throw new GitInputError(field, 'is not a plain branch name');
  }
  for (const segment of name.split('/')) {
    if (!BRANCH_SEGMENT.test(segment) || segment.endsWith('.lock') || segment.endsWith('.')) {
      throw new GitInputError(field, 'is not a plain branch name');
    }
  }
}

function checkRepoPath(path: string, field: string): void {
  if (typeof path !== 'string' || path.length === 0) throw new GitInputError(field, 'is empty');
  if (path.includes('\0') || /[\r\n]/.test(path)) throw new GitInputError(field, 'has control characters');
  if (path.startsWith('-') || path.startsWith('/') || path.includes('\\')) {
    throw new GitInputError(field, 'must be a relative, "/"-separated path');
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new GitInputError(field, 'has an empty, "." or ".." segment');
  }
}

function checkLocation(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new GitInputError(field, 'is empty');
  if (value.startsWith('-')) throw new GitInputError(field, 'must not start with "-"');
  if (/[\0\r\n]/.test(value)) throw new GitInputError(field, 'has control characters');
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) throw new GitInputError(field, 'must not use a git remote helper transport');
}

function checkAuthorPart(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new GitInputError(field, 'must be 1 to 200 characters');
  }
  if (/[\0\r\n<>]/.test(value)) throw new GitInputError(field, 'must not contain line breaks, "<" or ">"');
}

function splitNul(output: string): string[] {
  return output
    .split('\0')
    .map((entry) => entry.replace(/^\n+/, ''))
    .filter((entry) => entry.length > 0);
}

function redact(text: string, secret: string | undefined): string {
  return secret === undefined || secret.length === 0 ? text : text.split(secret).join('[REDACTED]');
}

/** One line of git's stderr for an error message: last non-empty line, redacted, control chars removed. */
function summarize(stderr: string, secret: string | undefined): string {
  const lines = redact(stderr, secret)
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1) ?? 'no error output';
  return last.length > 300 ? `${last.slice(0, 300)}...` : last;
}

/**
 * Deletes every entry named `.git` (any case) anywhere under `root`, without following symbolic
 * links or junctions. Exported for tests.
 */
export function removeGitEntries(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name.toLowerCase() === '.git') rmSync(path, { recursive: true, force: true });
      else if (entry.isDirectory()) pending.push(path);
    }
  }
}

interface RunOptions {
  /** Extra environment for this call only (author identity, `GH_TOKEN`). */
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  /** Redacted from any error text. */
  readonly secret?: string;
  /** Called with the complete argument list before git runs; throws to stop the call. */
  readonly check?: (argv: readonly string[]) => void;
}

/** Runs git against one git dir and work tree with the safe prefix. */
class GitContext {
  readonly gitDir: string;
  readonly workTree: string;
  readonly #emptyDir: string;
  readonly #runner: GitRunner;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(
    gitDir: string,
    workTree: string,
    emptyDir: string,
    runner: GitRunner,
    env: Readonly<Record<string, string | undefined>>,
  ) {
    this.gitDir = gitDir;
    this.workTree = workTree;
    this.#emptyDir = emptyDir;
    this.#runner = runner;
    this.#env = env;
  }

  /** Runs git and returns its output whatever the exit code. */
  async raw(args: readonly string[], options: RunOptions = {}): Promise<GitOutput> {
    ensureEmptyDir(this.#emptyDir);
    const argv = [...safeArgs(this.gitDir, this.workTree, this.#emptyDir), ...args];
    options.check?.(argv);
    // The empty directory is also the child's cwd: trusted, and outside every work tree (runner.ts).
    const call = { args: argv, env: gitEnv(this.#env, options.env), cwd: this.#emptyDir };
    return this.#runner(options.input === undefined ? call : { ...call, input: options.input });
  }

  /** Runs git and returns stdout; a non-zero exit becomes ExternalCommandError naming `label`. */
  async run(label: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
    const output = await this.raw(args, options);
    if (output.exitCode !== 0) {
      throw new ExternalCommandError('git', output.exitCode, `${label}: ${summarize(output.stderr, options.secret)}`);
    }
    return output.stdout;
  }

  /** The commit id `ref` points to, or null when it does not name a commit. */
  async commitOf(ref: string): Promise<string | null> {
    const output = await this.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const id = output.stdout.trim();
    return output.exitCode === 0 && HEX_ID.test(id) ? id : null;
  }

  async requireCommit(ref: string): Promise<string> {
    checkRef(ref);
    const id = await this.commitOf(ref);
    if (id === null) throw new NotFoundError('git ref', ref);
    return id;
  }

  async showFile(ref: string, path: string): Promise<string | null> {
    checkRepoPath(path, 'path');
    const commit = await this.requireCommit(ref);
    const object = `${commit}:${path}`;
    const type = await this.raw(['cat-file', '-t', object]);
    if (type.exitCode !== 0 || type.stdout.trim() !== 'blob') return null;
    return this.run('cat-file', ['cat-file', 'blob', object]);
  }
}

function ensureEmptyDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) {
    throw new RosterError(`The empty hooks directory is not empty: ${dir}`);
  }
}

class Workspace implements GitWorkspace {
  readonly paths: WorkspacePaths;
  readonly #git: GitContext;
  readonly #guard: PushGuard;
  readonly #baseBranch: string;

  constructor(paths: WorkspacePaths, git: GitContext, guard: PushGuard, baseBranch: string) {
    this.paths = paths;
    this.#git = git;
    this.#guard = guard;
    this.#baseBranch = baseBranch;
  }

  async prepareBranch(name: string): Promise<{ readonly resumed: boolean }> {
    checkBranchName(name);
    const remote = `refs/remotes/origin/${name}`;
    const resumed = (await this.#git.commitOf(remote)) !== null;
    let start = remote;
    if (!resumed) {
      start = `refs/remotes/origin/${this.#baseBranch}`;
      if ((await this.#git.commitOf(start)) === null) throw new NotFoundError('git ref', `origin/${this.#baseBranch}`);
    }
    await this.#git.run('checkout', ['checkout', '--quiet', '--no-track', '-B', name, start]);
    return { resumed };
  }

  async changedPaths(base: string): Promise<readonly string[]> {
    checkRef(base, 'base');
    removeGitEntries(this.paths.tree);
    const baseCommit = await this.#git.requireCommit(base);
    // Tracked files, committed or not, against the merge base of `base` and HEAD, so commits that
    // reached `main` after the branch started are not reported as changes of this branch.
    const worktree = await this.#git.run('diff', [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-relative',
      '--merge-base',
      baseCommit,
    ]);
    // Every commit of the range, so a change made and then undone inside the range still counts.
    const commits = await this.#git.run('log', [
      'log',
      '--format=',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-relative',
      `${baseCommit}..HEAD`,
    ]);
    // New files that `commitAll` would add (`add --all` honors the same ignore rules).
    const untracked = await this.#git.run('ls-files', ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']);
    const paths = new Set([...splitNul(worktree), ...splitNul(commits), ...splitNul(untracked)]);
    return [...paths].sort();
  }

  async commitAll(message: string, author: CommitAuthor): Promise<string | null> {
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_MESSAGE_LENGTH) {
      throw new GitInputError('commit message', `must be 1 to ${MAX_MESSAGE_LENGTH} characters`);
    }
    if (message.includes('\0')) throw new GitInputError('commit message', 'must not contain NUL');
    checkAuthorPart(author.name, 'author name');
    checkAuthorPart(author.email, 'author email');
    removeGitEntries(this.paths.tree);
    await this.#git.run('add', ['add', '--all']);
    const staged = await this.#git.raw(['diff', '--cached', '--quiet', '--no-ext-diff']);
    if (staged.exitCode === 0) return null;
    if (staged.exitCode !== 1) {
      throw new ExternalCommandError('git', staged.exitCode, `diff: ${summarize(staged.stderr, undefined)}`);
    }
    const identity = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    };
    await this.#git.run('commit', ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace', '--file=-'], {
      env: identity,
      input: message,
    });
    return this.headCommit();
  }

  async showFile(ref: string, path: string): Promise<string | null> {
    return this.#git.showFile(ref, path);
  }

  async headCommit(): Promise<string> {
    const id = await this.#git.commitOf('HEAD');
    if (id === null) throw new NotFoundError('git ref', 'HEAD');
    return id;
  }

  async push(branch: string, ghToken: string): Promise<void> {
    if (typeof ghToken !== 'string' || ghToken.length === 0 || /[\s\0]/.test(ghToken)) {
      throw new GitInputError('GitHub token', 'is empty or has whitespace');
    }
    const args = this.#guard.pushArguments(branch);
    await this.#git.run('push', args, {
      env: { GH_TOKEN: ghToken },
      secret: ghToken,
      check: (argv) => this.#guard.assertSafePush(argv),
    });
  }
}

/** Resolves the git dir of a local repository: `.git` directory, or the `gitdir:` of a `.git` file. */
function localGitDir(repoPath: string): string {
  const dotGit = join(repoPath, '.git');
  if (!existsSync(dotGit)) throw new GitInputError('repo path', `${repoPath} is not a git repository`);
  if (statSync(dotGit).isDirectory()) return dotGit;
  const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  const target = match?.[1]?.trim();
  if (target === undefined || target.length === 0) throw new GitInputError('repo path', `${repoPath} has an unreadable .git file`);
  return resolve(repoPath, target);
}

export class GitVcs implements VcsPort {
  readonly #workspaceRoot: string;
  readonly #guardFactory: PushGuardFactory;
  readonly #runner: GitRunner;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #emptyDir: string;

  constructor(options: GitVcsOptions) {
    if (!isAbsolute(options.workspaceRoot)) throw new GitInputError('workspace root', 'must be an absolute path');
    if (typeof options.pushGuard !== 'function') throw new GitInputError('push guard', 'is required');
    this.#workspaceRoot = options.workspaceRoot;
    this.#guardFactory = options.pushGuard;
    this.#runner = options.runner ?? execFileGitRunner();
    this.#env = options.env ?? process.env;
    this.#emptyDir = options.emptyDir ?? join(options.workspaceRoot, '.empty-hooks');
  }

  async createWorkspace(source: WorkspaceSource, executionId: string): Promise<GitWorkspace> {
    if (!SLUG_PATTERN.test(source.name)) throw new GitInputError('project name', 'must match ^[a-z0-9-]+$');
    if (!isExecutionId(executionId)) throw new GitInputError('execution id', 'must be <yyyymmddhhmmss>-<6 hex>');
    checkLocation(source.repoPath, 'repo path');
    if (!isAbsolute(source.repoPath)) throw new GitInputError('repo path', 'must be an absolute path');
    checkLocation(source.remoteUrl, 'remote URL');
    // The rules are read once and bound here; the guard validates them (PushRejectedError) before
    // anything is written or run. Neither the guard nor the base branch can change afterwards.
    const rules: PushGuardRules = Object.freeze({ baseBranch: source.baseBranch, branchPrefix: source.branchPrefix });
    const guard = this.#guardFactory(rules);
    if (typeof guard?.pushArguments !== 'function' || typeof guard.assertSafePush !== 'function') {
      throw new GitInputError('push guard', 'did not return a guard');
    }
    checkBranchName(rules.baseBranch, 'base branch');

    const root = join(this.#workspaceRoot, source.name, executionId);
    if (existsSync(root)) throw new GitInputError('workspace', `${root} already exists`);
    const paths: WorkspacePaths = {
      root,
      gitDir: join(root, 'git'),
      tree: join(root, 'tree'),
      inDir: join(root, 'in'),
      outDir: join(root, 'out'),
    };
    for (const dir of [paths.tree, paths.inDir, paths.outDir]) mkdirSync(dir, { recursive: true });

    const git = this.#context(paths.gitDir, paths.tree);
    await git.run('init', ['init', '--quiet', `--template=${this.#emptyDir}`, '--initial-branch=main']);
    await git.run('remote', ['remote', 'add', 'origin', source.repoPath]);
    await git.run('fetch', ['fetch', '--quiet', '--no-tags', 'origin']);
    await git.run('remote', ['remote', 'set-url', 'origin', source.remoteUrl]);
    await git.run('fetch', ['fetch', '--quiet', '--no-tags', '--prune', 'origin']);
    removeGitEntries(paths.tree);
    return new Workspace(paths, git, guard, rules.baseBranch);
  }

  async fetch(repoPath: string): Promise<void> {
    await this.#repo(repoPath).run('fetch', ['fetch', '--quiet', 'origin']);
  }

  async showFile(repoPath: string, ref: string, path: string): Promise<string | null> {
    return this.#repo(repoPath).showFile(ref, path);
  }

  async listFiles(repoPath: string, ref: string, dir: string): Promise<readonly string[]> {
    const prefix = dir.replace(/\/+$/, '');
    checkRepoPath(prefix, 'dir');
    const git = this.#repo(repoPath);
    const commit = await git.requireCommit(ref);
    const output = await git.run('ls-tree', ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit, prefix]);
    return splitNul(output)
      .filter((path) => path.startsWith(`${prefix}/`))
      .sort();
  }

  async resolveRef(repoPath: string, ref: string): Promise<string> {
    return this.#repo(repoPath).requireCommit(ref);
  }

  async lastCommitTouching(repoPath: string, ref: string, path: string): Promise<string | null> {
    checkRepoPath(path, 'path');
    const git = this.#repo(repoPath);
    const commit = await git.requireCommit(ref);
    const id = (await git.run('log', ['log', '-1', '--format=%H', commit, '--', path])).trim();
    return id.length === 0 ? null : id;
  }

  #context(gitDir: string, workTree: string): GitContext {
    return new GitContext(gitDir, workTree, this.#emptyDir, this.#runner, this.#env);
  }

  #repo(repoPath: string): GitContext {
    checkLocation(repoPath, 'repo path');
    if (!isAbsolute(repoPath)) throw new GitInputError('repo path', 'must be an absolute path');
    return this.#context(localGitDir(repoPath), repoPath);
  }
}

/** Builds the VcsPort. The composition root passes `createPushGuard` from `src/adapters/vcs/push-guard.ts`. */
export function createGitVcs(options: GitVcsOptions): GitVcs {
  return new GitVcs(options);
}
