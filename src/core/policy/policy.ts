// Fixed MVP policy (ADR 0024) and protected paths (ADR 0025). Pure: the caller reads
// `policies/mvp.json` and `policies/protected-paths.json` from `origin/main` and passes the parsed
// JSON to `parsePolicy`. Nothing here reads a file.

import { JOB_KINDS } from '../domain/execution.ts';
import type { JobKind } from '../domain/execution.ts';
import { isRecord } from '../domain/validation.ts';
import { PolicyError } from './errors.ts';
import { globMatch, isValidGlob } from './glob.ts';

/** Operation classes of ADR 0024 and the one value each may hold. */
export const OPERATION_VALUES = {
  read: ['allow'],
  write_worktree: ['allow'],
  run_commands: ['allow'],
  install_dependencies: ['approve'],
  vcs_write: ['roster_only'],
  delete_outside_worktree: ['deny'],
  migrate: ['deny'],
  deploy: ['deny'],
  change_safety: ['deny'],
} as const;

export type OperationClass = keyof typeof OPERATION_VALUES;

/** Keys of `timeoutMinutes`: one per job kind, plus the two command-only container jobs. */
export const TIMEOUT_KEYS = [...JOB_KINDS, 'setup', 'verify'] as const;

export type TimeoutKey = (typeof TIMEOUT_KEYS)[number];

export interface PolicyLimits {
  /** Cap on an agent's `max-turns`. */
  readonly maxTurns: number;
  /** Docker memory value, for example `4g`. */
  readonly memory: string;
  readonly cpus: number;
  readonly pids: number;
  readonly maxRunsPerNight: number;
}

export interface Policy {
  readonly operations: Readonly<Record<OperationClass, string>>;
  readonly limits: PolicyLimits;
  readonly timeoutMinutes: Readonly<Record<TimeoutKey, number>>;
  readonly providerHosts: readonly string[];
  readonly registryHosts: readonly string[];
  /** Default dependency manifests (ADR 0024). */
  readonly dependencyManifests: readonly string[];
  /** Protected for every project (ADR 0025). */
  readonly protectedDefaults: readonly string[];
  /** Protected only in the Roster repo (ADR 0025). */
  readonly protectedRoster: readonly string[];
}

type Json = Readonly<Record<string, unknown>>;

function stringList(
  source: Json,
  key: string,
  where: string,
  problems: string[],
  check: (item: string) => boolean,
  rule: string,
): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${where}.${key} must be a non-empty array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !check(item)) {
      problems.push(`${where}.${key}[${index}] ${rule}`);
    } else {
      out.push(item);
    }
  }
  return out;
}

function positive(source: Json, key: string, where: string, problems: string[]): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    problems.push(`${where}.${key} must be a positive integer`);
    return 1;
  }
  return value;
}

function section(root: Json, key: string, file: string, problems: string[]): Json {
  const value = root[key];
  if (!isRecord(value)) {
    problems.push(`${file}.${key} must be an object`);
    return {};
  }
  return value;
}

const isHost = (item: string): boolean => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(item);

/**
 * Validates the content of both policy files. Throws `PolicyError` listing every problem. Unknown
 * keys are ignored. Operation values are fixed: a different value is an error, not a setting.
 */
export function parsePolicy(mvp: unknown, protectedPaths: unknown): Policy {
  const problems: string[] = [];
  const mvpRoot: Json = isRecord(mvp) ? mvp : {};
  const protectedRoot: Json = isRecord(protectedPaths) ? protectedPaths : {};
  if (!isRecord(mvp)) {
    problems.push('mvp.json must be an object');
  }
  if (!isRecord(protectedPaths)) {
    problems.push('protected-paths.json must be an object');
  }

  const operationsIn = section(mvpRoot, 'operations', 'mvp.json', problems);
  const operations: Record<string, string> = {};
  for (const [name, allowed] of Object.entries(OPERATION_VALUES)) {
    const value = operationsIn[name];
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      problems.push(`mvp.json.operations.${name} must be ${allowed.join(' or ')}`);
    } else {
      operations[name] = value;
    }
  }

  const limitsIn = section(mvpRoot, 'limits', 'mvp.json', problems);
  const memory = limitsIn['memory'];
  if (typeof memory !== 'string' || !/^[1-9][0-9]*[mg]$/.test(memory)) {
    problems.push('mvp.json.limits.memory must look like 4g or 512m');
  }
  const limits: PolicyLimits = {
    maxTurns: positive(limitsIn, 'maxTurns', 'mvp.json.limits', problems),
    memory: typeof memory === 'string' ? memory : '',
    cpus: positive(limitsIn, 'cpus', 'mvp.json.limits', problems),
    pids: positive(limitsIn, 'pids', 'mvp.json.limits', problems),
    maxRunsPerNight: positive(limitsIn, 'maxRunsPerNight', 'mvp.json.limits', problems),
  };

  const timeoutsIn = section(mvpRoot, 'timeoutMinutes', 'mvp.json', problems);
  const timeoutMinutes: Record<string, number> = {};
  for (const key of TIMEOUT_KEYS) {
    timeoutMinutes[key] = positive(timeoutsIn, key, 'mvp.json.timeoutMinutes', problems);
  }

  const hostRule = 'must be a lower-case host name';
  const globRule = 'must be a valid glob';
  const providerHosts = stringList(mvpRoot, 'providerHosts', 'mvp.json', problems, isHost, hostRule);
  const registryHosts = stringList(mvpRoot, 'registryHosts', 'mvp.json', problems, isHost, hostRule);
  const manifests = stringList(mvpRoot, 'dependencyManifests', 'mvp.json', problems, isValidGlob, globRule);
  const protectedDefaults = stringList(protectedRoot, 'defaults', 'protected-paths.json', problems, isValidGlob, globRule);
  const protectedRoster = stringList(protectedRoot, 'roster', 'protected-paths.json', problems, isValidGlob, globRule);

  if (problems.length > 0) {
    throw new PolicyError(problems);
  }
  return {
    operations: operations as Record<OperationClass, string>,
    limits,
    timeoutMinutes: timeoutMinutes as Record<TimeoutKey, number>,
    providerHosts,
    registryHosts,
    dependencyManifests: manifests,
    protectedDefaults,
    protectedRoster,
  };
}

/** Protected patterns and dependency manifests that apply to one project. */
export interface ProjectPolicy {
  readonly protectedPaths: readonly string[];
  readonly dependencyManifests: readonly string[];
}

export interface ProjectAdditions {
  readonly protectedPaths?: readonly string[];
  readonly dependencyManifests?: readonly string[];
}

function union(base: readonly string[], extra: readonly string[]): string[] {
  return [...base, ...extra.filter((item) => !base.includes(item))];
}

function additionProblems(list: readonly string[], key: string): string[] {
  const problems: string[] = [];
  for (const [index, item] of list.entries()) {
    if (item.startsWith('!')) {
      problems.push(`${key}[${index}] tries to remove a default; a project can only add`);
    } else if (!isValidGlob(item)) {
      problems.push(`${key}[${index}] must be a valid glob`);
    }
  }
  return problems;
}

/**
 * Defaults plus the project's additions. `rosterRepo` adds the Roster-repo patterns of ADR 0025.
 * A `!pattern` entry or an invalid glob throws `PolicyError`; defaults are never removed.
 */
export function mergeProjectPolicy(
  policy: Policy,
  additions: ProjectAdditions = {},
  options: { readonly rosterRepo?: boolean } = {},
): ProjectPolicy {
  const protectedExtra = additions.protectedPaths ?? [];
  const manifestExtra = additions.dependencyManifests ?? [];
  const problems = [
    ...additionProblems(protectedExtra, 'protectedPaths'),
    ...additionProblems(manifestExtra, 'dependencyManifests'),
  ];
  if (problems.length > 0) {
    throw new PolicyError(problems);
  }
  const base =
    options.rosterRepo === true ? [...policy.protectedDefaults, ...policy.protectedRoster] : policy.protectedDefaults;
  return {
    protectedPaths: union(base, protectedExtra),
    dependencyManifests: union(policy.dependencyManifests, manifestExtra),
  };
}

export interface ProtectedMatch {
  readonly path: string;
  readonly pattern: string;
}

export interface ChangeCheck {
  /** Changed paths that match a protected pattern (the hire exception is already applied). */
  readonly protectedMatches: readonly ProtectedMatch[];
  /** Changed paths the job kind may not touch, including malformed paths. */
  readonly outsideAllowed: readonly string[];
  /** Changed dependency manifests. */
  readonly changedManifests: readonly string[];
  /** True when all three lists are empty. */
  readonly clean: boolean;
}

export interface CheckChangesInput {
  readonly policy: Policy;
  readonly jobKind: JobKind;
  readonly changedPaths: readonly string[];
  readonly projectPolicy: ProjectPolicy;
  /** Feature directory under `specs/`, for example `002-local-core`. Required for `analyst` and `architect`. */
  readonly feature?: string;
}

/** The hire job may change exactly these paths and nothing else (ADR 0025, ADR 0027). */
const HIRE_PATHS: readonly string[] = ['agents/**', 'skills/registry.md'];

const FEATURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function allowedPaths(jobKind: JobKind, feature: string | undefined): readonly string[] | 'any' {
  switch (jobKind) {
    case 'specialist':
      return 'any';
    case 'hr-director':
      return HIRE_PATHS;
    case 'reviewer':
      return [];
    case 'analyst':
    case 'architect': {
      if (feature === undefined || !FEATURE_NAME.test(feature)) {
        throw new PolicyError([`a valid feature name is required for job kind ${jobKind}`]);
      }
      return jobKind === 'analyst' ? [`specs/${feature}/spec.md`] : [`specs/${feature}/**`, 'docs/adr/**'];
    }
  }
}

/** A well-formed repo-relative path: forward slashes, no empty, `.` or `..` segments. */
function isCleanPath(path: string): boolean {
  return path !== '' && !path.includes('\\') && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function isManifest(path: string, pattern: string): boolean {
  // A pattern without `/` names a file at any depth; one with `/` is matched against the whole path.
  return pattern.includes('/') ? globMatch(pattern, path) : globMatch(pattern, path.slice(path.lastIndexOf('/') + 1));
}

/**
 * Policy check on the paths a run changed (ADR 0024 table, ADR 0025). Never throws on a bad path:
 * a malformed path is reported as outside the allowed paths. Throws `PolicyError` when
 * `projectPolicy` lacks a default pattern or manifest, or a feature name is missing or unsafe.
 */
export function checkChanges(input: CheckChangesInput): ChangeCheck {
  const { policy, jobKind, changedPaths, projectPolicy } = input;
  const missing = [
    ...policy.protectedDefaults.filter((p) => !projectPolicy.protectedPaths.includes(p)),
    ...policy.dependencyManifests.filter((m) => !projectPolicy.dependencyManifests.includes(m)),
  ];
  if (missing.length > 0) {
    throw new PolicyError(missing.map((item) => `project policy removes the default ${item}`));
  }
  const allowed = allowedPaths(jobKind, input.feature);
  const exempt = jobKind === 'hr-director' ? HIRE_PATHS : [];

  const protectedMatches: ProtectedMatch[] = [];
  const outsideAllowed: string[] = [];
  const changedManifests: string[] = [];
  for (const path of changedPaths) {
    if (!isCleanPath(path)) {
      outsideAllowed.push(path);
      continue;
    }
    if (allowed !== 'any' && !allowed.some((pattern) => globMatch(pattern, path))) {
      outsideAllowed.push(path);
    }
    if (!exempt.some((pattern) => globMatch(pattern, path))) {
      const pattern = projectPolicy.protectedPaths.find((candidate) => globMatch(candidate, path));
      if (pattern !== undefined) {
        protectedMatches.push({ path, pattern });
      }
    }
    if (projectPolicy.dependencyManifests.some((pattern) => isManifest(path, pattern))) {
      changedManifests.push(path);
    }
  }
  return {
    protectedMatches,
    outsideAllowed,
    changedManifests,
    clean: protectedMatches.length === 0 && outsideAllowed.length === 0 && changedManifests.length === 0,
  };
}

export interface RequestedLimits {
  /** `max-turns` of the agent definition. */
  readonly maxTurns?: number;
  /** `timeout-minutes` of the agent definition. */
  readonly timeoutMinutes?: number;
}

export interface EffectiveLimits {
  readonly maxTurns: number;
  readonly timeoutMinutes: number;
  readonly memory: string;
  readonly cpus: number;
  readonly pids: number;
}

/**
 * Limits for one job. An agent's `max-turns` and `timeout-minutes` can only lower the policy value
 * (the timeout of the job kind or container job); an absent request gets the policy value.
 */
export function limitsFor(policy: Policy, key: TimeoutKey, requested: RequestedLimits = {}): EffectiveLimits {
  const cap = policy.timeoutMinutes[key];
  return {
    maxTurns: Math.min(requested.maxTurns ?? policy.limits.maxTurns, policy.limits.maxTurns),
    timeoutMinutes: Math.min(requested.timeoutMinutes ?? cap, cap),
    memory: policy.limits.memory,
    cpus: policy.limits.cpus,
    pids: policy.limits.pids,
  };
}
