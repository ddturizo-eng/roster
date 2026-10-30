// VcsPort (plan 002 sections 4.3 and 8, ADR 0018, ADR 0023): git on the host. Workspaces use a
// separate git dir so no `.git` reaches the container; every push goes through the push guard.
// Git-side data (registrations, policies, agents, specs) is read only from `origin/main`.

import type { Project } from '../core/domain/project.ts';
import type { WorkspacePaths } from '../core/domain/runtime.ts';

/** Where a workspace is cloned from: the local repo path, with `origin` set to the GitHub remote. */
export type WorkspaceSource = Pick<Project, 'name' | 'repoPath' | 'remoteUrl'>;

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

/** One execution's clone. Every call passes `--git-dir`, `--work-tree` and the safe config. */
export interface GitWorkspace {
  readonly paths: WorkspacePaths;
  /**
   * Checks out `origin/<name>` when it exists (`resumed: true`); otherwise creates `name` from
   * `origin/main`.
   */
  prepareBranch(name: string): Promise<{ readonly resumed: boolean }>;
  /** Paths changed between `base` and the work tree, committed or not, `/`-separated. */
  changedPaths(base: string): Promise<readonly string[]>;
  /** Commits every change; returns the commit id, or null when there was nothing to commit. */
  commitAll(message: string, author: CommitAuthor): Promise<string | null>;
  /** Content of `path` at `ref`, or null when it does not exist there. */
  showFile(ref: string, path: string): Promise<string | null>;
  headCommit(): Promise<string>;
  /**
   * Pushes `branch` through the push guard: only `refs/heads/agent/*`, never `main`, never forced.
   * The token reaches only the push child process. Rejects with PushRejectedError.
   */
  push(branch: string, ghToken: string): Promise<void>;
}

export interface VcsPort {
  /** Clones `source` into `workspaces\<project>\<execution-id>\`, sets `origin` and fetches. */
  createWorkspace(source: WorkspaceSource, executionId: string): Promise<GitWorkspace>;
  /** `git fetch origin` in a local repo (the Roster repo or a registered project). */
  fetch(repoPath: string): Promise<void>;
  /** Content of `path` at `ref` in a local repo, or null when it does not exist there. */
  showFile(repoPath: string, ref: string, path: string): Promise<string | null>;
  /** Paths of the files under `dir` at `ref`, `/`-separated and relative to the repo root. */
  listFiles(repoPath: string, ref: string, dir: string): Promise<readonly string[]>;
  /** The commit id `ref` points to. */
  resolveRef(repoPath: string, ref: string): Promise<string>;
  /** The latest commit on `ref` that changed `path` (for import evidence), or null when none. */
  lastCommitTouching(repoPath: string, ref: string, path: string): Promise<string | null>;
}
