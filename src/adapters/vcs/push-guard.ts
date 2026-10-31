// Push guard (ADR 0024, ADR 0025, ADR 0029, plan 002 sections 8, 11 and 12). Protected path: only the
// human pushes changes to this file. It is written once, in T10, and covers every push Roster makes:
// task branches `agent/<NNN>-<Tnn>`, WIP pushes (ADR 0028), hire branches `agent/hire-<slug>`
// (ADR 0027), spec branches `agent/<NNN>-spec` and registration branches `agent/project-<name>`.
//
// Rules:
// - the only destination is `refs/heads/agent/<name>`, pushed to the remote `origin`, with the same
//   ref as source; never `main`, never a delete, never a `+` (forced) refspec, never more than one;
// - no option except the four fixed ones below, so `--force`, `-f`, `--force-with-lease`,
//   `--force-if-includes`, `--mirror`, `--all`, `--tags`, `--delete` and `--prune` are all refused;
// - the GitHub token is never an argument: `GH_TOKEN` reaches the push child through its environment
//   and `gh auth git-credential` is the credential helper for that one command only (`-c`, never
//   written to git config). The general helper list is reset first, so no other helper sees it.
//
// The git adapter (`vcs/git`) builds the command from `pushArguments` and calls `assertSafePush` on
// the complete argument list right before it runs it. The adapter receives this module from the
// composition root, because the layering rule forbids one adapter folder importing another file
// under `adapters/` (test/architecture.test.ts).

import { PushRejectedError } from '../../core/domain/errors.ts';

/** The only remote Roster pushes to; the workspace sets it to the project's GitHub remote. */
export const PUSH_REMOTE = 'origin';

/** Every pushed ref starts with this prefix. */
export const AGENT_REF_PREFIX = 'refs/heads/agent/';

/** Credential helper for the push command only (ADR 0029, H10). It reads `GH_TOKEN`. */
export const PUSH_CREDENTIAL_HELPER = '!gh auth git-credential';

/** The options `git push` may carry; nothing else starting with `-` is accepted. */
export const PUSH_OPTIONS = ['--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no'] as const;

const MAX_BRANCH_LENGTH = 200;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// `-c` values allowed before `push`, as `key=value` with the value checked by the predicate. These
// are the safe settings every git call passes (ADR 0023) plus the push credential helper.
const GLOBAL_CONFIG: Readonly<Record<string, (value: string) => boolean>> = {
  'core.hooksPath': (value) => value.length > 0,
  'core.fsmonitor': (value) => value === 'false',
  'core.autocrlf': (value) => value === 'false',
  'credential.helper': (value) => value === '' || value === PUSH_CREDENTIAL_HELPER,
};

const REQUIRED_CONFIG = ['core.hooksPath', 'core.fsmonitor', 'core.autocrlf'] as const;

function reject(ref: string, reason: string): never {
  throw new PushRejectedError(ref, reason);
}

function describe(value: string): string {
  return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);
}

/**
 * Checks a short branch name such as `agent/002-T10` and returns its full ref. Throws
 * PushRejectedError for `main`, any name outside `agent/`, and names git would treat specially.
 */
export function agentRef(branch: string): string {
  if (typeof branch !== 'string' || branch.length === 0) reject(String(branch), 'the branch name is empty');
  const shown = describe(branch);
  if (branch === 'main' || branch === 'refs/heads/main') reject(shown, 'main is never pushed');
  if (branch.length > MAX_BRANCH_LENGTH) reject(shown, `the branch name is longer than ${MAX_BRANCH_LENGTH} characters`);
  if (branch.startsWith('+')) reject(shown, 'forced (+) refspecs are never pushed');
  if (branch.startsWith('-')) reject(shown, 'the branch name looks like an option');
  if (branch.includes(':')) reject(shown, 'the branch name must not contain a refspec');
  if (!branch.startsWith('agent/')) reject(shown, 'only branches under agent/ may be pushed');
  const segments = branch.slice('agent/'.length).split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment.endsWith('.') || segment.endsWith('.lock') || segment.includes('..')) {
      reject(shown, 'the branch name has an invalid segment');
    }
  }
  return `refs/heads/${branch}`;
}

/**
 * The arguments that follow the safe global options for a push of `branch`: the credential helper
 * for this command, then `push` with the fixed options, the remote and one `ref:ref` refspec.
 */
export function pushArguments(branch: string): readonly string[] {
  const ref = agentRef(branch);
  return ['-c', `credential.helper=${PUSH_CREDENTIAL_HELPER}`, 'push', ...PUSH_OPTIONS, PUSH_REMOTE, `${ref}:${ref}`];
}

function checkRefspec(refspec: string): void {
  const shown = describe(refspec);
  if (refspec.startsWith('+')) reject(shown, 'forced (+) refspecs are never pushed');
  const parts = refspec.split(':');
  if (parts.length !== 2) reject(shown, 'the refspec must be <ref>:<ref>');
  const [source = '', destination = ''] = parts;
  if (source.length === 0) reject(shown, 'deleting a remote branch is never allowed');
  if (destination === 'main' || destination === 'refs/heads/main') reject(shown, 'main is never pushed');
  if (!destination.startsWith(AGENT_REF_PREFIX)) reject(shown, `the destination must be under ${AGENT_REF_PREFIX}`);
  if (source !== destination) reject(shown, 'the source and destination refs must be the same');
  agentRef(destination.slice('refs/heads/'.length));
}

function checkGlobalOptions(options: readonly string[]): void {
  const seen = new Set<string>();
  let helperReset = false;
  let helperSet = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i] ?? '';
    if (option.startsWith('--git-dir=') || option.startsWith('--work-tree=')) {
      if (option.endsWith('=')) reject('push', `${option} has no value`);
      continue;
    }
    if (option !== '-c') reject('push', `global option ${describe(option)} is not allowed`);
    const setting = options[++i];
    if (setting === undefined) reject('push', '-c has no value');
    const equals = setting.indexOf('=');
    const key = equals === -1 ? setting : setting.slice(0, equals);
    const value = equals === -1 ? '' : setting.slice(equals + 1);
    const allowed = GLOBAL_CONFIG[key];
    if (equals === -1 || allowed === undefined || !allowed(value)) {
      reject('push', `setting ${describe(key)} is not allowed for a push`);
    }
    if (key === 'credential.helper') {
      if (value === '') {
        if (helperSet) reject('push', 'the credential helper list is reset after the push helper');
        helperReset = true;
      } else {
        if (!helperReset) reject('push', 'the credential helper list must be reset before the push helper');
        helperSet = true;
      }
    }
    seen.add(key);
  }
  if (!options.some((option) => option.startsWith('--git-dir='))) reject('push', '--git-dir is missing');
  if (!options.some((option) => option.startsWith('--work-tree='))) reject('push', '--work-tree is missing');
  for (const key of REQUIRED_CONFIG) {
    if (!seen.has(key)) reject('push', `setting ${key} is missing`);
  }
  if (!helperReset || !helperSet) reject('push', `the credential helper must be exactly ${PUSH_CREDENTIAL_HELPER}`);
}

/**
 * Checks the complete argument list of a `git push` before it runs. Throws PushRejectedError, naming
 * the ref or option, for anything outside the rules above. The list never contains a secret.
 */
export function assertSafePush(argv: readonly string[]): void {
  const pushAt = argv.indexOf('push');
  if (pushAt === -1) reject('push', 'not a git push command');
  checkGlobalOptions(argv.slice(0, pushAt));

  const positionals: string[] = [];
  for (const arg of argv.slice(pushAt + 1)) {
    if (arg.startsWith('-')) {
      if (/^(?:-f|--force(?:-with-lease|-if-includes)?(?:=.*)?|-[A-Za-z]*f[A-Za-z]*)$/.test(arg)) {
        reject('push', `${describe(arg)}: force pushes are never allowed`);
      }
      if (!(PUSH_OPTIONS as readonly string[]).includes(arg)) reject('push', `option ${describe(arg)} is not allowed`);
      continue;
    }
    positionals.push(arg);
  }
  const [remote, refspec, ...extra] = positionals;
  if (remote !== PUSH_REMOTE) reject('push', `the remote must be ${PUSH_REMOTE}`);
  if (refspec === undefined) reject('push', 'a refspec is required');
  if (extra.length > 0) reject('push', 'exactly one refspec may be pushed');
  checkRefspec(refspec);
}

/** What the composition root hands to the git adapter. */
export const pushGuard = { pushArguments, assertSafePush } as const;
