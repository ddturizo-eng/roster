// Project registry reader (plan 002 section 6, ADR 0018): reads every `projects/*.json` from
// `origin/main` of the Roster repo, validates it, caches the valid ones in the store with the commit
// they were read at, and reports the invalid ones with file and field. Nothing is fetched here; the
// caller (`sync`, T18) fetches first. Registration text is untrusted: messages describe the rule that
// failed and never echo the value.

import type { Project, ProjectRegistration } from '../domain/project.ts';
import { SLUG_PATTERN } from '../domain/ids.ts';
import { IssueCollector, indexPath } from '../domain/validation.ts';
import type { ValidationIssue } from '../domain/validation.ts';
import { isValidGlob } from '../policy/glob.ts';
import { mergeProjectPolicy } from '../policy/policy.ts';
import type { Policy, ProjectPolicy } from '../policy/policy.ts';
import type { ClockPort } from '../../ports/clock.ts';
import type { StorePort } from '../../ports/store.ts';
import type { VcsPort } from '../../ports/vcs.ts';

/** Ref the registrations are read from (plan 002 section 6). */
export const REGISTRY_REF = 'origin/main';
export const REGISTRY_DIR = 'projects';

const REMOTE_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const MAX_TEXT = 500;
const MAX_ITEMS = 50;

export interface RegistryIssue {
  /** Repo-relative path of the registration file, for example `projects/web.json`. */
  readonly file: string;
  /** Field that failed, for example `remote` or `setup[1]`; `$` when the file as a whole is invalid. */
  readonly field: string;
  readonly message: string;
}

export type RegistrationParse =
  | { readonly ok: true; readonly registration: ProjectRegistration }
  | { readonly ok: false; readonly issues: readonly RegistryIssue[] };

function toIssue(file: string, issue: ValidationIssue): RegistryIssue {
  return { file, field: issue.path === '$' ? '$' : issue.path.replace(/^\$\./, ''), message: issue.message };
}

/**
 * Validates the content of one registration file. `slug` is the file name without `.json`; `name`
 * must equal it. Never throws.
 */
export function parseRegistration(text: string, slug: string, file: string): RegistrationParse {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, issues: [{ file, field: '$', message: 'must be valid JSON' }] };
  }
  const c = new IssueCollector();
  const root = c.object(json, '$');
  if (root === undefined) return { ok: false, issues: c.issues.map((i) => toIssue(file, i)) };

  const text500 = { maxLength: MAX_TEXT, nonEmpty: true };
  const name = c.requiredString(root, 'name', '$', { ...text500, pattern: SLUG_PATTERN });
  if (name !== undefined && name !== slug) {
    c.add('$.name', 'pattern', 'must equal the file name without .json');
  }
  const repoPath = c.requiredString(root, 'repoPath', '$', {
    ...text500,
    pattern: /^[^\u0000-\u001f]+$/,
  });
  const remote = c.requiredString(root, 'remote', '$', { ...text500, pattern: REMOTE_PATTERN });
  const defaultBranch = c.requiredEnum(root, 'defaultBranch', '$', ['main'] as const);
  const image = c.requiredString(root, 'image', '$', { ...text500, pattern: /^[^\s\u0000-\u001f]+$/ });

  const commands = (key: 'setup' | 'verify'): string[] => {
    const items = c.array(root, key, '$', { required: true, maxItems: MAX_ITEMS }) ?? [];
    const out: string[] = [];
    for (const [i, item] of items.entries()) {
      const value = c.checkString(item, indexPath(`$.${key}`, i), { ...text500, pattern: /^[^\u0000-\u001f]+$/ });
      if (value !== undefined) out.push(value);
    }
    return out;
  };
  const globs = (key: 'dependencyManifests' | 'protectedPaths'): string[] => {
    const items = c.array(root, key, '$', { required: true, maxItems: MAX_ITEMS }) ?? [];
    const out: string[] = [];
    for (const [i, item] of items.entries()) {
      const path = indexPath(`$.${key}`, i);
      const value = c.checkString(item, path, text500);
      if (value === undefined) continue;
      if (value.startsWith('!')) c.add(path, 'pattern', 'must not remove a default; a project can only add');
      else if (!isValidGlob(value)) c.add(path, 'pattern', 'must be a valid glob');
      else out.push(value);
    }
    return out;
  };
  const setup = commands('setup');
  const verify = commands('verify');
  const dependencyManifests = globs('dependencyManifests');
  const protectedPaths = globs('protectedPaths');

  if (c.issues.length > 0) return { ok: false, issues: c.issues.map((i) => toIssue(file, i)) };
  return {
    ok: true,
    registration: {
      name: name as string,
      repoPath: repoPath as string,
      remote: remote as string,
      defaultBranch: defaultBranch as 'main',
      setup,
      verify,
      dependencyManifests,
      protectedPaths,
      image: image as string,
    },
  };
}

/** A valid registration and its cached store row. */
export interface LoadedProject {
  readonly project: Project;
  readonly registration: ProjectRegistration;
  /** True when this registration is the Roster repo itself (ADR 0025 adds the Roster-repo patterns). */
  readonly isRosterRepo: boolean;
}

export interface RegistryReadResult {
  /** Roster repo commit `origin/main` pointed to; every project was read at it. */
  readonly commit: string;
  readonly projects: readonly LoadedProject[];
  /** Invalid files; they are skipped and not cached. */
  readonly issues: readonly RegistryIssue[];
}

export interface RegistryDeps {
  readonly vcs: VcsPort;
  readonly store: StorePort;
  readonly clock: ClockPort;
  /** Local path of the Roster repo (`config.json`). */
  readonly rosterRepoPath: string;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Reads, validates and caches every registration at the current `origin/main`. Valid files are
 * upserted in one store transaction; invalid ones are returned as issues and leave the store alone.
 */
export async function readProjects(deps: RegistryDeps): Promise<RegistryReadResult> {
  const { vcs, store, clock, rosterRepoPath } = deps;
  const commit = await vcs.resolveRef(rosterRepoPath, REGISTRY_REF);
  const files = (await vcs.listFiles(rosterRepoPath, commit, REGISTRY_DIR))
    .filter((path) => /^projects\/[^/]+\.json$/.test(path))
    .sort();

  const projects: LoadedProject[] = [];
  const issues: RegistryIssue[] = [];
  const syncedAt = clock.now().toISOString();
  for (const file of files) {
    const slug = file.slice(REGISTRY_DIR.length + 1, -'.json'.length);
    const text = await vcs.showFile(rosterRepoPath, commit, file);
    if (text === null) {
      issues.push({ file, field: '$', message: 'file not found at the registry commit' });
      continue;
    }
    const parsed = parseRegistration(text, slug, file);
    if (!parsed.ok) {
      issues.push(...parsed.issues);
      continue;
    }
    const registration = parsed.registration;
    const match = REMOTE_PATTERN.exec(registration.remote) as RegExpExecArray;
    projects.push({
      project: {
        name: registration.name,
        repoPath: registration.repoPath,
        remoteUrl: registration.remote,
        ownerRepo: `${match[1]}/${match[2]}`,
        registrationCommit: commit,
        syncedAt,
      },
      registration,
      isRosterRepo: samePath(registration.repoPath, rosterRepoPath),
    });
  }
  store.transaction(() => {
    for (const loaded of projects) store.upsertProject(loaded.project);
  });
  return { commit, projects, issues };
}

/**
 * Protected paths and dependency manifests of one project: the policy defaults plus the project's
 * additions, never removing a default. The Roster repo also gets the ADR 0025 Roster-only patterns.
 * Throws `PolicyError` if the registration tries to remove a default.
 */
export function projectPolicy(policy: Policy, loaded: LoadedProject): ProjectPolicy {
  return mergeProjectPolicy(
    policy,
    {
      protectedPaths: loaded.registration.protectedPaths,
      dependencyManifests: loaded.registration.dependencyManifests,
    },
    { rosterRepo: loaded.isRosterRepo },
  );
}
