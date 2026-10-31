import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor.ts';
import type { DoctorDeps } from '../../src/cli/commands/doctor.ts';
import type { BranchProtection } from '../../src/ports/forge.ts';
import { machine, ROSTER } from './support.ts';

const PROTECTED: BranchProtection = { state: 'known', prRequired: true, forcePushBlocked: true };

function setup(protection: Record<string, BranchProtection>, nodeVersion = '24.1.0') {
  const m = machine();
  m.forge.responses.setDefault('branchProtection', (repo, branch) => protection[`${repo}:${branch}`] ?? PROTECTED);
  const deps: DoctorDeps = {
    vcs: m.vcs,
    store: m.store,
    clock: m.clock,
    forge: m.forge,
    sandbox: m.sandbox,
    secrets: m.secrets,
    console: m.console,
    rosterRepoPath: ROSTER,
    nodeVersion,
  };
  return { ...m, deps };
}

describe('roster doctor', () => {
  it('passes when everything is in order, for base develop and main both protected', async () => {
    const { deps, console, forge } = setup({});
    expect(await runDoctor([], deps)).toBe(0);
    expect(console.stdout.filter((line) => line.startsWith('[FAIL]'))).toEqual([]);
    expect(console.stdout).toContain('[ ok ] web: branch develop is protected');
    expect(console.stdout).toContain('[ ok ] web: branch main is protected');
    expect(console.stdout).toContain('[ ok ] roster: branch main is protected');
    expect(console.stdout).toContain('All checks passed.');
    // main is checked once for the Roster repo (base main) and once for web (differs from develop).
    expect(forge.log.of('forge').filter((c) => c.method === 'branchProtection').map((c) => c.args)).toEqual([
      ['acme/roster', 'main'],
      ['acme/web', 'develop'],
      ['acme/web', 'main'],
    ]);
  });

  it('fails when the base branch develop is not protected, and says what is missing', async () => {
    const { deps, console } = setup({ 'acme/web:develop': { state: 'known', prRequired: true, forcePushBlocked: false } });
    expect(await runDoctor([], deps)).toBe(1);
    expect(console.stdout).toContain('[FAIL] web: branch develop is not protected: force push is not blocked');
    expect(console.stdout).toContain('1 check(s) failed.');
  });

  it('fails when main is present but unprotected', async () => {
    const { deps, console } = setup({ 'acme/web:main': { state: 'known', prRequired: false, forcePushBlocked: false } });
    expect(await runDoctor([], deps)).toBe(1);
    expect(console.stdout).toContain(
      '[FAIL] web: branch main is not protected: pull request is not required, force push is not blocked',
    );
  });

  it('reports a missing main without failing', async () => {
    const { deps, console } = setup({ 'acme/web:main': { state: 'missing' } });
    expect(await runDoctor([], deps)).toBe(0);
    const line = console.stdout.find((entry) => entry.includes('web: branch main'));
    expect(line).toMatch(/^\[warn\] web: branch main was not found on GitHub; reported, not failed/);
    expect(console.stdout.filter((entry) => entry.startsWith('[FAIL]'))).toEqual([]);
  });

  it('fails when the base branch itself is missing', async () => {
    const { deps, console } = setup({ 'acme/web:develop': { state: 'missing' } });
    expect(await runDoctor([], deps)).toBe(1);
    expect(console.stdout).toContain('[FAIL] web: branch develop does not exist on GitHub');
  });

  it('fails when protection cannot be read with the token (not verified)', async () => {
    const { deps, console } = setup({ 'acme/web:develop': { state: 'unknown' } });
    expect(await runDoctor([], deps)).toBe(1);
    expect(console.stdout.some((line) => line.startsWith('[FAIL] web: branch develop: protection cannot be read'))).toBe(true);
  });

  it('fails a project whose GitHub check throws, and keeps checking the others', async () => {
    const { deps, console, forge } = setup({});
    forge.responses.queueError('canRead', new Error('boom'));
    expect(await runDoctor([], deps)).toBe(1);
    expect(console.stdout.some((line) => line.startsWith('[FAIL] roster: GitHub check failed'))).toBe(true);
    expect(console.stdout).toContain('[ ok ] web: branch develop is protected');
  });

  it('fails on Docker, tokens and Node, and never prints a secret', async () => {
    const { deps, console, sandbox, secrets } = setup({}, '22.4.0');
    sandbox.responses.queue('available', { available: false, reason: 'daemon not running' });
    secrets.values.delete('claude-oauth-token');
    expect(await runDoctor([], deps)).toBe(1);
    const text = console.stdout.join('\n');
    expect(text).toContain('[FAIL] Node 22.4.0; Node 24 or newer is required');
    expect(text).toContain('[FAIL] Docker is not reachable: daemon not running');
    expect(text).toContain('[FAIL] Claude token is missing; run roster auth set claude');
    expect(text).toContain('[ ok ] GitHub token is stored');
    expect(text).not.toContain('fake-gh-0000');
    expect(secrets.log.of('secrets').map((c) => c.method)).toEqual(['has', 'has']);
  });

  it('skips the GitHub checks and fails when the GitHub token is missing', async () => {
    const { deps, console, secrets, forge } = setup({});
    secrets.values.delete('github-token');
    expect(await runDoctor([], deps)).toBe(1);
    expect(forge.log.of('forge')).toEqual([]);
    expect(console.stdout).toContain('[FAIL] web: not checked, the GitHub token is missing');
  });

  it('fails when the registry cannot be read', async () => {
    const { deps, console, vcs } = setup({});
    vcs.responses.queueError('fetch', new Error('offline'));
    expect(await runDoctor([], deps)).toBe(1);
    expect(console.stdout.some((line) => line.startsWith('[FAIL] The project registry cannot be read'))).toBe(true);
  });

  it('prints usage and exits 1 for extra arguments', async () => {
    const { deps, console } = setup({});
    expect(await runDoctor(['now'], deps)).toBe(1);
    expect(console.stderr).toEqual(['Usage: roster doctor']);
  });
});
