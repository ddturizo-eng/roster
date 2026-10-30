// Fake VcsPort and GitWorkspace. Repo-level reads answer from files a test seeded; workspace calls
// are recorded under the port name `workspace`. Recorded pushes never contain the token.

import type { WorkspacePaths } from '../../src/core/domain/runtime.ts';
import type { CommitAuthor, GitWorkspace, VcsPort, WorkspaceSource } from '../../src/ports/vcs.ts';
import { CallLog, Responses } from './recorder.ts';
import { REDACTED } from './secrets.ts';

export const FAKE_WORKSPACE_ROOT = '/fake/workspaces';
export const FAKE_BASE_COMMIT = 'base000';

export class FakeGitWorkspace implements GitWorkspace {
  readonly paths: WorkspacePaths;
  readonly #log: CallLog;
  readonly #responses: Responses<GitWorkspace>;
  readonly commits: { readonly id: string; readonly message: string; readonly author: CommitAuthor }[] = [];
  readonly pushes: string[] = [];

  constructor(paths: WorkspacePaths, log: CallLog, responses: Responses<GitWorkspace>) {
    this.paths = paths;
    this.#log = log;
    this.#responses = responses;
  }

  async prepareBranch(name: string): Promise<{ readonly resumed: boolean }> {
    this.#log.record('workspace', 'prepareBranch', [name]);
    return this.#responses.answer('prepareBranch', [name], () => ({ resumed: false }));
  }

  async changedPaths(base: string): Promise<readonly string[]> {
    this.#log.record('workspace', 'changedPaths', [base]);
    return this.#responses.answer('changedPaths', [base], () => []);
  }

  async commitAll(message: string, author: CommitAuthor): Promise<string | null> {
    this.#log.record('workspace', 'commitAll', [message, author]);
    return this.#responses.answer('commitAll', [message, author], () => {
      const id = `commit${this.commits.length + 1}`;
      this.commits.push({ id, message, author });
      return id;
    });
  }

  async showFile(ref: string, path: string): Promise<string | null> {
    this.#log.record('workspace', 'showFile', [ref, path]);
    return this.#responses.answer('showFile', [ref, path], () => null);
  }

  async headCommit(): Promise<string> {
    this.#log.record('workspace', 'headCommit', []);
    return this.#responses.answer('headCommit', [], () => this.commits.at(-1)?.id ?? FAKE_BASE_COMMIT);
  }

  async push(branch: string, ghToken: string): Promise<void> {
    this.#log.record('workspace', 'push', [branch, REDACTED]);
    this.#responses.answer('push', [branch, ghToken], () => {
      this.pushes.push(branch);
    });
  }
}

export class FakeVcs implements VcsPort {
  readonly log: CallLog;
  readonly responses = new Responses<VcsPort>();
  /** Scripted answers shared by every workspace this fake creates. */
  readonly workspaceResponses = new Responses<GitWorkspace>();
  readonly workspaces: FakeGitWorkspace[] = [];
  readonly #files = new Map<string, string>();
  readonly #refs = new Map<string, string>();
  readonly #lastCommits = new Map<string, string>();

  constructor(log: CallLog = new CallLog()) {
    this.log = log;
  }

  /** Seeds `path` at `ref` of `repoPath` for showFile and listFiles. */
  seedFile(repoPath: string, ref: string, path: string, content: string): this {
    this.#files.set(key(repoPath, ref, path), content);
    return this;
  }

  seedRef(repoPath: string, ref: string, commit: string): this {
    this.#refs.set(key(repoPath, ref), commit);
    return this;
  }

  seedLastCommit(repoPath: string, ref: string, path: string, commit: string): this {
    this.#lastCommits.set(key(repoPath, ref, path), commit);
    return this;
  }

  async createWorkspace(source: WorkspaceSource, executionId: string): Promise<GitWorkspace> {
    this.log.record('vcs', 'createWorkspace', [source, executionId]);
    return this.responses.answer('createWorkspace', [source, executionId], () => {
      const root = `${FAKE_WORKSPACE_ROOT}/${source.name}/${executionId}`;
      const workspace = new FakeGitWorkspace(
        { root, gitDir: `${root}/git`, tree: `${root}/tree`, inDir: `${root}/in`, outDir: `${root}/out` },
        this.log,
        this.workspaceResponses,
      );
      this.workspaces.push(workspace);
      return workspace;
    });
  }

  async fetch(repoPath: string): Promise<void> {
    this.log.record('vcs', 'fetch', [repoPath]);
    this.responses.answer('fetch', [repoPath], () => undefined);
  }

  async showFile(repoPath: string, ref: string, path: string): Promise<string | null> {
    this.log.record('vcs', 'showFile', [repoPath, ref, path]);
    return this.responses.answer('showFile', [repoPath, ref, path], () => this.#files.get(key(repoPath, ref, path)) ?? null);
  }

  async listFiles(repoPath: string, ref: string, dir: string): Promise<readonly string[]> {
    this.log.record('vcs', 'listFiles', [repoPath, ref, dir]);
    return this.responses.answer('listFiles', [repoPath, ref, dir], () => {
      const prefix = key(repoPath, ref, dir.endsWith('/') ? dir : `${dir}/`);
      return [...this.#files.keys()]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(key(repoPath, ref, '').length))
        .sort();
    });
  }

  async resolveRef(repoPath: string, ref: string): Promise<string> {
    this.log.record('vcs', 'resolveRef', [repoPath, ref]);
    return this.responses.answer('resolveRef', [repoPath, ref], () => this.#refs.get(key(repoPath, ref)) ?? FAKE_BASE_COMMIT);
  }

  async lastCommitTouching(repoPath: string, ref: string, path: string): Promise<string | null> {
    this.log.record('vcs', 'lastCommitTouching', [repoPath, ref, path]);
    return this.responses.answer(
      'lastCommitTouching',
      [repoPath, ref, path],
      () => this.#lastCommits.get(key(repoPath, ref, path)) ?? null,
    );
  }
}

function key(...parts: readonly string[]): string {
  return parts.join('\u0000');
}
