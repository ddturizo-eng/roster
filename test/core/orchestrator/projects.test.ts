import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePolicy } from '../../../src/core/policy/policy.ts';
import { PolicyError } from '../../../src/core/policy/errors.ts';
import { parseRegistration, projectPolicy, readProjects } from '../../../src/core/orchestrator/projects.ts';
import type { LoadedProject } from '../../../src/core/orchestrator/projects.ts';
import { FakeClock, FAKE_START_TIME } from '../../fakes/clock.ts';
import { FakeStore } from '../../fakes/store.ts';
import { FakeVcs } from '../../fakes/vcs.ts';

const ROSTER = 'C:\\roster';
const COMMIT = 'abc1234';

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../policies/${name}`, import.meta.url), 'utf8'));
}
const policy = parsePolicy(readJson('mvp.json'), readJson('protected-paths.json'));

function registration(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    repoPath: `C:\\code\\${name}`,
    remote: `https://github.com/acme/${name}`,
    defaultBranch: 'main',
    setup: ['npm ci --ignore-scripts'],
    verify: ['npm run typecheck', 'npm test'],
    dependencyManifests: ['requirements.txt'],
    protectedPaths: ['infra/**'],
    image: 'roster/runtime-claude',
    ...overrides,
  };
}

function setup(files: Record<string, string>): { vcs: FakeVcs; store: FakeStore; deps: Parameters<typeof readProjects>[0] } {
  const vcs = new FakeVcs();
  vcs.seedRef(ROSTER, 'origin/main', COMMIT);
  for (const [path, text] of Object.entries(files)) vcs.seedFile(ROSTER, COMMIT, path, text);
  const store = new FakeStore();
  return { vcs, store, deps: { vcs, store, clock: new FakeClock(), rosterRepoPath: ROSTER } };
}

describe('parseRegistration', () => {
  it('accepts a valid registration', () => {
    const result = parseRegistration(JSON.stringify(registration('web')), 'web', 'projects/web.json');
    expect(result).toEqual({ ok: true, registration: registration('web') });
  });

  const invalid: [string, Record<string, unknown> | null, string][] = [
    ['name missing', { name: undefined }, 'name'],
    ['name not a slug', { name: 'Web' }, 'name'],
    ['name differs from file', { name: 'other' }, 'name'],
    ['repoPath missing', { repoPath: undefined }, 'repoPath'],
    ['repoPath empty', { repoPath: '' }, 'repoPath'],
    ['repoPath not a string', { repoPath: 4 }, 'repoPath'],
    ['remote not github', { remote: 'https://gitlab.com/acme/web' }, 'remote'],
    ['remote ssh', { remote: 'git@github.com:acme/web.git' }, 'remote'],
    ['remote with trailing path', { remote: 'https://github.com/acme/web/tree/main' }, 'remote'],
    ['remote missing', { remote: undefined }, 'remote'],
    ['defaultBranch not main', { defaultBranch: 'master' }, 'defaultBranch'],
    ['defaultBranch missing', { defaultBranch: undefined }, 'defaultBranch'],
    ['setup missing', { setup: undefined }, 'setup'],
    ['setup not an array', { setup: 'npm ci' }, 'setup'],
    ['setup item empty', { setup: ['npm ci', ''] }, 'setup[1]'],
    ['verify item not a string', { verify: [1] }, 'verify[0]'],
    ['verify missing', { verify: undefined }, 'verify'],
    ['dependencyManifests missing', { dependencyManifests: undefined }, 'dependencyManifests'],
    ['dependencyManifests removes a default', { dependencyManifests: ['!package.json'] }, 'dependencyManifests[0]'],
    ['dependencyManifests bad glob', { dependencyManifests: ['/abs/x'] }, 'dependencyManifests[0]'],
    ['protectedPaths removes a default', { protectedPaths: ['ok/**', '!.github/**'] }, 'protectedPaths[1]'],
    ['protectedPaths not an array', { protectedPaths: {} }, 'protectedPaths'],
    ['image missing', { image: undefined }, 'image'],
    ['image with space', { image: 'a b' }, 'image'],
    ['not an object', null, '$'],
  ];
  it.each(invalid)('rejects: %s', (_label, overrides, field) => {
    const body = overrides === null ? [1, 2] : registration('web', overrides);
    const result = parseRegistration(JSON.stringify(body), 'web', 'projects/web.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => [i.file, i.field])).toContainEqual(['projects/web.json', field]);
  });

  it('rejects invalid JSON with the whole file as the field', () => {
    const result = parseRegistration('{nope', 'web', 'projects/web.json');
    expect(result).toEqual({
      ok: false,
      issues: [{ file: 'projects/web.json', field: '$', message: 'must be valid JSON' }],
    });
  });

  it('never echoes the offending value', () => {
    const result = parseRegistration(
      JSON.stringify(registration('web', { remote: 'https://evil.example/SECRET' })),
      'web',
      'projects/web.json',
    );
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('readProjects', () => {
  it('reads two projects, caches both with the commit and stamps the time', async () => {
    const { store, deps } = setup({
      'projects/web.json': JSON.stringify(registration('web')),
      'projects/api.json': JSON.stringify(registration('api')),
      'projects/README.md': 'ignored',
    });
    const result = await readProjects(deps);
    expect(result.commit).toBe(COMMIT);
    expect(result.issues).toEqual([]);
    expect(result.projects.map((p) => p.project.name)).toEqual(['api', 'web']);
    expect(store.listProjects()).toEqual([
      {
        name: 'api',
        repoPath: 'C:\\code\\api',
        remoteUrl: 'https://github.com/acme/api',
        ownerRepo: 'acme/api',
        registrationCommit: COMMIT,
        syncedAt: FAKE_START_TIME,
      },
      {
        name: 'web',
        repoPath: 'C:\\code\\web',
        remoteUrl: 'https://github.com/acme/web',
        ownerRepo: 'acme/web',
        registrationCommit: COMMIT,
        syncedAt: FAKE_START_TIME,
      },
    ]);
  });

  it('reads at the resolved commit, not the moving ref, and does not fetch', async () => {
    const { vcs, deps } = setup({ 'projects/web.json': JSON.stringify(registration('web')) });
    await readProjects(deps);
    expect(vcs.log.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'vcs.resolveRef',
      'vcs.listFiles',
      'vcs.showFile',
    ]);
    expect(vcs.log.calls[0]?.args).toEqual([ROSTER, 'origin/main']);
    expect(vcs.log.calls[2]?.args).toEqual([ROSTER, COMMIT, 'projects/web.json']);
  });

  it('reports invalid files with file and field, skips them and caches the valid ones', async () => {
    const { store, deps } = setup({
      'projects/web.json': JSON.stringify(registration('web')),
      'projects/bad.json': JSON.stringify(registration('bad', { remote: 'nope', image: '' })),
      'projects/broken.json': '{',
    });
    const result = await readProjects(deps);
    expect(result.projects.map((p) => p.project.name)).toEqual(['web']);
    expect(result.issues.map((i) => [i.file, i.field])).toEqual([
      ['projects/bad.json', 'remote'],
      ['projects/bad.json', 'image'],
      ['projects/broken.json', '$'],
    ]);
    expect(store.listProjects().map((p) => p.name)).toEqual(['web']);
  });

  it('flags the registration whose repoPath is the Roster repo', async () => {
    const { deps } = setup({
      'projects/roster.json': JSON.stringify(registration('roster', { repoPath: 'c:/roster/' })),
      'projects/web.json': JSON.stringify(registration('web')),
    });
    const result = await readProjects(deps);
    expect(result.projects.map((p) => [p.project.name, p.isRosterRepo])).toEqual([
      ['roster', true],
      ['web', false],
    ]);
  });

  it('returns nothing for an empty registry', async () => {
    const { deps } = setup({});
    expect(await readProjects(deps)).toEqual({ commit: COMMIT, projects: [], issues: [] });
  });
});

describe('projectPolicy', () => {
  async function load(name: string, repoPath?: string): Promise<LoadedProject> {
    const { deps } = setup({
      [`projects/${name}.json`]: JSON.stringify(registration(name, repoPath === undefined ? {} : { repoPath })),
    });
    return (await readProjects(deps)).projects[0] as LoadedProject;
  }

  it('adds project paths and manifests to the defaults and keeps every default', async () => {
    const merged = projectPolicy(policy, await load('web'));
    expect(merged.protectedPaths).toEqual([...policy.protectedDefaults, 'infra/**']);
    expect(merged.dependencyManifests).toEqual([...policy.dependencyManifests, 'requirements.txt']);
    for (const p of policy.protectedRoster) expect(merged.protectedPaths).not.toContain(p);
  });

  it('adds the Roster-repo patterns for the Roster project only', async () => {
    const merged = projectPolicy(policy, await load('roster', ROSTER));
    for (const p of [...policy.protectedDefaults, ...policy.protectedRoster, 'infra/**']) {
      expect(merged.protectedPaths).toContain(p);
    }
  });

  it('throws when a registration tries to remove a default', async () => {
    const loaded = await load('web');
    const bad: LoadedProject = {
      ...loaded,
      registration: { ...loaded.registration, protectedPaths: ['!.github/**'] },
    };
    expect(() => projectPolicy(policy, bad)).toThrow(PolicyError);
  });
});
