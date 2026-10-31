// `roster doctor` (plan 002 section 7.8, ADR 0032 section 5): pass/fail checks of this machine, for
// the checks that exist so far. Not yet checked (later tasks): pinned install and its distance from
// `origin/main` (T23), images of the pinned commit, Task Scheduler, free disk space.
//
// Claude authentication is checked only by the presence of the stored token, never by `apiKeySource`
// (spike finding 3). No secret value is read or printed.
//
// Branch protection of each registered project: the base branch must exist and be protected; `main`
// is checked when it differs from the base branch and exists, and a missing `main` is reported, not
// failed. "Protected" means pull request required and force push blocked. A protection the token
// cannot read (`unknown`) counts as not verified and fails.

import { readProjects } from '../../core/orchestrator/projects.ts';
import type { LoadedProject, RegistryDeps } from '../../core/orchestrator/projects.ts';
import type { ConsolePort } from '../../ports/console.ts';
import type { BranchProtection, ForgePort } from '../../ports/forge.ts';
import type { SandboxPort } from '../../ports/sandbox.ts';
import type { SecretsPort } from '../../ports/secrets.ts';
import { describeError } from '../describe-error.ts';

export const DOCTOR_USAGE = 'Usage: roster doctor';
export const MIN_NODE_MAJOR = 24;

export type CheckStatus = 'ok' | 'fail' | 'warn';

export interface Check {
  readonly status: CheckStatus;
  readonly text: string;
}

export interface DoctorDeps extends RegistryDeps {
  readonly forge: ForgePort;
  readonly sandbox: SandboxPort;
  readonly secrets: SecretsPort;
  readonly console: ConsolePort;
  /** `process.versions.node`, injected for tests. */
  readonly nodeVersion: string;
}

const ok = (text: string): Check => ({ status: 'ok', text });
const fail = (text: string): Check => ({ status: 'fail', text });
const warn = (text: string): Check => ({ status: 'warn', text });

function checkNode(version: string): Check {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR
    ? ok(`Node ${version}`)
    : fail(`Node ${version}; Node ${MIN_NODE_MAJOR} or newer is required`);
}

/** Verdict on one branch's protection; `main` and the base branch share the rule. */
function protectionCheck(branch: string, protection: BranchProtection, isMain: boolean, projectName: string): Check {
  const label = `${projectName}: branch ${branch}`;
  switch (protection.state) {
    case 'missing':
      return isMain
        ? warn(`${label} was not found on GitHub; reported, not failed (the project may use another default branch)`)
        : fail(`${label} does not exist on GitHub`);
    case 'unknown':
      return fail(`${label}: protection cannot be read with this token; grant it Administration read (ADR 0029) to verify`);
    case 'known': {
      const missing = [
        ...(protection.prRequired ? [] : ['pull request is not required']),
        ...(protection.forcePushBlocked ? [] : ['force push is not blocked']),
      ];
      return missing.length === 0 ? ok(`${label} is protected`) : fail(`${label} is not protected: ${missing.join(', ')}`);
    }
  }
}

async function projectChecks(forge: ForgePort, loaded: LoadedProject, tokenPresent: boolean): Promise<Check[]> {
  const { name, ownerRepo } = loaded.project;
  const base = loaded.registration.baseBranch;
  const checks: Check[] = [];
  if (!tokenPresent) return [fail(`${name}: not checked, the GitHub token is missing`)];
  try {
    checks.push((await forge.canRead(ownerRepo)) ? ok(`${name}: GitHub repository ${ownerRepo} is readable`) : fail(`${name}: GitHub repository ${ownerRepo} cannot be read with the token`));
    checks.push(protectionCheck(base, await forge.branchProtection(ownerRepo, base), false, name));
    if (base !== 'main') checks.push(protectionCheck('main', await forge.branchProtection(ownerRepo, 'main'), true, name));
  } catch (error) {
    checks.push(fail(`${name}: GitHub check failed (${describeError(error)})`));
  }
  return checks;
}

export async function collectChecks(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [checkNode(deps.nodeVersion)];

  try {
    const availability = await deps.sandbox.available();
    checks.push(availability.available ? ok('Docker is reachable') : fail(`Docker is not reachable: ${availability.reason}`));
  } catch (error) {
    checks.push(fail(`Docker check failed (${describeError(error)})`));
  }

  const claude = await deps.secrets.has('claude-oauth-token');
  checks.push(claude ? ok('Claude token is stored') : fail('Claude token is missing; run roster auth set claude'));
  const github = await deps.secrets.has('github-token');
  checks.push(github ? ok('GitHub token is stored') : fail('GitHub token is missing; run roster auth set github'));

  try {
    await deps.vcs.fetch(deps.rosterRepoPath);
    const registry = await readProjects(deps);
    checks.push(ok(`Registry read at ${registry.commit}: ${registry.projects.length} project(s)`));
    for (const issue of registry.issues) checks.push(fail(`${issue.file}: ${issue.field} ${issue.message}`));
    if (registry.projects.length === 0) checks.push(warn('No project is registered'));
    for (const loaded of registry.projects) checks.push(...(await projectChecks(deps.forge, loaded, github)));
  } catch (error) {
    checks.push(fail(`The project registry cannot be read (${describeError(error)})`));
  }
  return checks;
}

const TAGS: Readonly<Record<CheckStatus, string>> = { ok: '[ ok ]', fail: '[FAIL]', warn: '[warn]' };

/** Prints every check and returns 0 when none failed, 1 otherwise. */
export async function runDoctor(args: readonly string[], deps: DoctorDeps): Promise<number> {
  if (args.length > 0) {
    deps.console.printError(DOCTOR_USAGE);
    return 1;
  }
  const checks = await collectChecks(deps);
  for (const check of checks) deps.console.print(`${TAGS[check.status]} ${check.text}`);
  const failed = checks.filter((check) => check.status === 'fail').length;
  deps.console.print(failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`);
  deps.console.print('Not checked yet: pinned install, images, Task Scheduler, free disk space.');
  return failed === 0 ? 0 : 1;
}
