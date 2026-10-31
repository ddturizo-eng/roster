import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PolicyError } from '../../../src/core/policy/errors.ts';
import { globMatch, isValidGlob } from '../../../src/core/policy/glob.ts';
import {
  checkChanges,
  limitsFor,
  mergeProjectPolicy,
  parsePolicy,
  TIMEOUT_KEYS,
} from '../../../src/core/policy/policy.ts';
import type { Policy } from '../../../src/core/policy/policy.ts';

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../policies/${name}`, import.meta.url), 'utf8'));
}

const mvp = readJson('mvp.json');
const protectedFile = readJson('protected-paths.json');
const policy: Policy = parsePolicy(mvp, protectedFile);
const external = mergeProjectPolicy(policy);
const rosterRepo = mergeProjectPolicy(policy, {}, { rosterRepo: true });

describe('globMatch', () => {
  const cases: [string, string, boolean][] = [
    ['a/b', 'a/b', true],
    ['a/b', 'a/c', false],
    ['a/b', 'A/b', false],
    ['*.ts', 'x.ts', true],
    ['*.ts', 'a/x.ts', false],
    ['a/*/c', 'a/b/c', true],
    ['a/*/c', 'a/b/d/c', false],
    ['a/**', 'a/b', true],
    ['a/**', 'a/b/c/d', true],
    ['a/**', 'ab/c', false],
    ['**/x.json', 'x.json', true],
    ['**/x.json', 'a/b/x.json', true],
    ['a/**/z', 'a/z', true],
    ['a/**/z', 'a/b/c/z', true],
    ['a/**/z', 'a/b/c/y', false],
    ['pre*mid*suf', 'pre-mid-suf', true],
    ['pre*mid*suf', 'premidsuf', true],
    ['pre*mid*suf', 'presuf', false],
    ['a*a', 'a', false],
    ['.mcp.json', '.mcp.json', true],
    ['.mcp.json', 'x/.mcp.json', false],
  ];
  it.each(cases)('%s vs %s is %s', (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
  });

  it.each(['', '/a', 'a//b', 'a\\b', 'a**', 'a/b**c', 'a/'])('rejects the invalid pattern %j', (pattern) => {
    expect(isValidGlob(pattern)).toBe(false);
    expect(globMatch(pattern, 'a/b')).toBe(false);
  });
});

describe('policy files', () => {
  it('parse and hold the ADR 0024 values', () => {
    expect(policy.operations.install_dependencies).toBe('approve');
    expect(policy.operations.vcs_write).toBe('roster_only');
    expect(policy.providerHosts).toEqual(['api.anthropic.com']);
    expect(policy.registryHosts).toEqual(['registry.npmjs.org']);
    expect(policy.dependencyManifests).toEqual([
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
    ]);
    expect(policy.timeoutMinutes).toEqual({
      specialist: 90,
      'hr-director': 20,
      analyst: 20,
      architect: 60,
      reviewer: 20,
      setup: 15,
      verify: 20,
    });
    expect(policy.limits).toMatchObject({ memory: '4g', cpus: 2, pids: 512, maxRunsPerNight: 5 });
  });

  it('hold the ADR 0025 patterns', () => {
    expect(policy.protectedDefaults).toEqual([
      '.claude/**',
      '.mcp.json',
      '.github/workflows/**',
      '.devcontainer/**',
      'specs/constitution.md',
    ]);
    expect(policy.protectedRoster).toEqual([
      'policies/**',
      'container/**',
      'projects/**',
      'agents/**',
      'skills/**',
      'scripts/install.ps1',
      'scripts/sync-agents.ps1',
      'src/core/policy/**',
      'src/adapters/vcs/push-guard.ts',
      'src/adapters/sandbox/docker/isolation.ts',
      'src/adapters/runtime/claude-code/managed-settings.ts',
    ]);
  });

  it('are rejected when malformed, listing every problem', () => {
    const bad = parsePolicyError({}, { defaults: ['a//b'] });
    expect(bad.problems.length).toBeGreaterThan(5);
    const changed = { ...(mvp as object), operations: { ...(mvp as { operations: object }).operations, deploy: 'allow' } };
    expect(parsePolicyError(changed, protectedFile).problems).toEqual(['mvp.json.operations.deploy must be deny']);
  });
});

function parsePolicyError(a: unknown, b: unknown): PolicyError {
  try {
    parsePolicy(a, b);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyError);
    return error as PolicyError;
  }
  throw new Error('expected PolicyError');
}

describe('protected patterns', () => {
  const defaultCases: [string, string][] = [
    ['.claude/settings.json', '.claude/**'],
    ['.claude/agents/x/y.md', '.claude/**'],
    ['.mcp.json', '.mcp.json'],
    ['.github/workflows/ci.yml', '.github/workflows/**'],
    ['.devcontainer/devcontainer.json', '.devcontainer/**'],
    ['specs/constitution.md', 'specs/constitution.md'],
  ];
  const rosterCases: [string, string][] = [
    ['policies/mvp.json', 'policies/**'],
    ['container/egress-proxy/proxy.ts', 'container/**'],
    ['projects/roster.json', 'projects/**'],
    ['agents/x.md', 'agents/**'],
    ['skills/registry.md', 'skills/**'],
    ['scripts/install.ps1', 'scripts/install.ps1'],
    ['scripts/sync-agents.ps1', 'scripts/sync-agents.ps1'],
    ['src/core/policy/policy.ts', 'src/core/policy/**'],
    ['src/adapters/vcs/push-guard.ts', 'src/adapters/vcs/push-guard.ts'],
    ['src/adapters/sandbox/docker/isolation.ts', 'src/adapters/sandbox/docker/isolation.ts'],
    ['src/adapters/runtime/claude-code/managed-settings.ts', 'src/adapters/runtime/claude-code/managed-settings.ts'],
  ];

  it.each([...defaultCases, ...rosterCases])('%s matches %s in the Roster repo', (path, pattern) => {
    const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: [path], projectPolicy: rosterRepo });
    expect(result.protectedMatches).toEqual([{ path, pattern }]);
    expect(result.clean).toBe(false);
  });

  it.each(defaultCases)('%s matches %s in any project', (path, pattern) => {
    const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: [path], projectPolicy: external });
    expect(result.protectedMatches).toEqual([{ path, pattern }]);
  });

  it.each(rosterCases)('%s is not protected in another project', (path) => {
    const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: [path], projectPolicy: external });
    expect(result.protectedMatches).toEqual([]);
  });

  it.each(['src/core/policy.ts', 'scripts/other.ps1', 'x/.mcp.json', '.github/CODEOWNERS', 'specs/constitution.md.bak'])(
    '%s is not protected',
    (path) => {
      const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: [path], projectPolicy: rosterRepo });
      expect(result.protectedMatches).toEqual([]);
    },
  );
});

describe('checkChanges by job kind', () => {
  const feature = '002-local-core';
  type Row = [string, Parameters<typeof checkChanges>[0]['jobKind'], string[], string[]];
  const rows: Row[] = [
    ['specialist anywhere unprotected', 'specialist', ['src/a.ts', 'docs/x.md'], []],
    ['analyst spec only', 'analyst', [`specs/${feature}/spec.md`], []],
    ['analyst plan', 'analyst', [`specs/${feature}/plan.md`], [`specs/${feature}/plan.md`]],
    ['analyst other feature', 'analyst', ['specs/003-x/spec.md'], ['specs/003-x/spec.md']],
    ['architect feature files and adr', 'architect', [`specs/${feature}/plan.md`, `specs/${feature}/a/b.md`, 'docs/adr/0030-x.md'], []],
    ['architect source', 'architect', ['src/a.ts'], ['src/a.ts']],
    ['hr-director agents and registry', 'hr-director', ['agents/new.md', 'skills/registry.md'], []],
    ['hr-director source', 'hr-director', ['src/a.ts'], ['src/a.ts']],
    ['reviewer nothing', 'reviewer', ['README.md'], ['README.md']],
    ['reviewer no changes', 'reviewer', [], []],
  ];
  it.each(rows)('%s', (_name, jobKind, changedPaths, outside) => {
    const result = checkChanges({ policy, jobKind, changedPaths, projectPolicy: rosterRepo, feature });
    expect(result.outsideAllowed).toEqual(outside);
    expect(result.protectedMatches.map((m) => m.path)).toEqual([]);
  });

  it('hire exception allows only agents/** and skills/registry.md', () => {
    const result = checkChanges({
      policy,
      jobKind: 'hr-director',
      changedPaths: ['agents/a.md', 'skills/registry.md', 'skills/x/SKILL.md', 'policies/mvp.json', '.claude/agents/a.md'],
      projectPolicy: rosterRepo,
    });
    expect(result.protectedMatches).toEqual([
      { path: 'skills/x/SKILL.md', pattern: 'skills/**' },
      { path: 'policies/mvp.json', pattern: 'policies/**' },
      { path: '.claude/agents/a.md', pattern: '.claude/**' },
    ]);
    expect(result.outsideAllowed).toEqual(['skills/x/SKILL.md', 'policies/mvp.json', '.claude/agents/a.md']);
  });

  it('other kinds get no hire exception', () => {
    const result = checkChanges({
      policy,
      jobKind: 'specialist',
      changedPaths: ['agents/a.md', 'skills/registry.md'],
      projectPolicy: rosterRepo,
    });
    expect(result.protectedMatches.map((m) => m.path)).toEqual(['agents/a.md', 'skills/registry.md']);
  });

  it('architect cannot write the constitution', () => {
    const result = checkChanges({
      policy,
      jobKind: 'architect',
      changedPaths: ['specs/constitution.md'],
      projectPolicy: rosterRepo,
      feature,
    });
    expect(result.protectedMatches).toHaveLength(1);
    expect(result.outsideAllowed).toEqual(['specs/constitution.md']);
  });

  it.each(['analyst', 'architect'] as const)('%s needs a safe feature name', (jobKind) => {
    for (const bad of [undefined, '', '../x', 'a/b', '*', '.hidden']) {
      expect(() =>
        checkChanges({ policy, jobKind, changedPaths: [], projectPolicy: external, ...(bad === undefined ? {} : { feature: bad }) }),
      ).toThrow(PolicyError);
    }
  });

  it.each(['../x', '/etc/passwd', 'a/../b', './a', 'a//b', 'a\\b', '.claude\\x', ''])(
    'reports the malformed path %j as outside',
    (path) => {
      const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: [path], projectPolicy: external });
      expect(result.outsideAllowed).toEqual([path]);
    },
  );
});

describe('dependency manifests', () => {
  it.each(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'web/package.json'])(
    '%s is a manifest',
    (path) => {
      const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: [path], projectPolicy: external });
      expect(result.changedManifests).toEqual([path]);
      expect(result.clean).toBe(false);
    },
  );

  it('ignores non-manifests and reports project manifests', () => {
    const project = mergeProjectPolicy(policy, { dependencyManifests: ['requirements.txt', 'backend/go.mod'] });
    const result = checkChanges({
      policy,
      jobKind: 'specialist',
      changedPaths: ['src/package.json.ts', 'requirements.txt', 'backend/go.mod', 'other/go.mod', 'a/requirements.txt'],
      projectPolicy: project,
    });
    expect(result.changedManifests).toEqual(['requirements.txt', 'backend/go.mod', 'a/requirements.txt']);
  });

  it('a clean change is clean', () => {
    const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: ['src/a.ts'], projectPolicy: rosterRepo });
    expect(result).toEqual({ protectedMatches: [], outsideAllowed: [], changedManifests: [], clean: true });
  });
});

describe('project policy', () => {
  it('adds project patterns and manifests to the defaults, without duplicates', () => {
    const project = mergeProjectPolicy(policy, {
      protectedPaths: ['infra/**', '.mcp.json'],
      dependencyManifests: ['Cargo.lock', 'package.json'],
    });
    expect(project.protectedPaths).toEqual([...policy.protectedDefaults, 'infra/**']);
    expect(project.dependencyManifests).toEqual([...policy.dependencyManifests, 'Cargo.lock']);
    const result = checkChanges({ policy, jobKind: 'specialist', changedPaths: ['infra/main.tf'], projectPolicy: project });
    expect(result.protectedMatches).toEqual([{ path: 'infra/main.tf', pattern: 'infra/**' }]);
  });

  it.each(['!.claude/**', '!specs/constitution.md', '/abs', 'a//b'])('rejects the addition %j', (item) => {
    expect(() => mergeProjectPolicy(policy, { protectedPaths: [item] })).toThrow(PolicyError);
    expect(() => mergeProjectPolicy(policy, { dependencyManifests: [item] })).toThrow(PolicyError);
  });

  it.each(policy.protectedDefaults)('rejects a project policy that dropped the default %s', (dropped) => {
    const weakened = { ...external, protectedPaths: external.protectedPaths.filter((p) => p !== dropped) };
    expect(() => checkChanges({ policy, jobKind: 'specialist', changedPaths: [], projectPolicy: weakened })).toThrow(
      PolicyError,
    );
  });

  it('rejects a project policy that dropped a default manifest', () => {
    const weakened = { ...external, dependencyManifests: ['package.json'] };
    expect(() => checkChanges({ policy, jobKind: 'specialist', changedPaths: [], projectPolicy: weakened })).toThrow(
      PolicyError,
    );
  });
});

describe('limitsFor', () => {
  it.each(TIMEOUT_KEYS)('defaults %s to the policy values', (key) => {
    expect(limitsFor(policy, key)).toEqual({
      maxTurns: 60,
      timeoutMinutes: policy.timeoutMinutes[key],
      memory: '4g',
      cpus: 2,
      pids: 512,
    });
  });

  const cases: [string, { maxTurns?: number; timeoutMinutes?: number }, number, number][] = [
    ['lower values are kept', { maxTurns: 10, timeoutMinutes: 30 }, 10, 30],
    ['higher values are capped', { maxTurns: 500, timeoutMinutes: 600 }, 60, 90],
    ['equal values are kept', { maxTurns: 60, timeoutMinutes: 90 }, 60, 90],
  ];
  it.each(cases)('specialist: %s', (_name, requested, turns, minutes) => {
    const limits = limitsFor(policy, 'specialist', requested);
    expect(limits.maxTurns).toBe(turns);
    expect(limits.timeoutMinutes).toBe(minutes);
  });

  it('caps the timeout by the key, not by the largest', () => {
    expect(limitsFor(policy, 'analyst', { timeoutMinutes: 90 }).timeoutMinutes).toBe(20);
    expect(limitsFor(policy, 'verify', { timeoutMinutes: 90 }).timeoutMinutes).toBe(20);
  });
});
