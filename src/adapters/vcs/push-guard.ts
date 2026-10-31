// Push guard (ADR 0024, ADR 0025, ADR 0029, ADR 0032, plan 002 sections 8, 11 and 12). Protected
// path: only the human pushes changes to this file. It was written in T10 and bound to per-project
// branch rules in T43. It covers every push Roster makes: task branches and their WIP pushes
// (ADR 0028), spec and plan branches, hire branches `agent/hire-<slug>` (ADR 0027) and registration
// branches `agent/project-<name>`.
//
// The guard is created per workspace with the project's `{ baseBranch, branchPrefix }`
// (`createPushGuard`). It validates those rules itself, with the patterns and reserved names of
// ADR 0032 section 1, and re-implements its checks instead of calling the branch-name builders or the
// registration validator in `core`, so a change to those unprotected files cannot weaken it. The only
// thing it imports from `core` is the error type.
//
// Rules:
// - the only destination is `refs/heads/<branchPrefix>/<one segment>`, where the segment starts with
//   `agent-` (and has at least one more character) unless the prefix is `agent`. So the agent
//   namespace is `agent/` for the prefix `agent` and `<branchPrefix>/agent-` for any other prefix;
// - `main`, `master`, `develop` and the base branch are never pushed, whatever the rules (the shape
//   above already excludes them; the explicit check is defense in depth);
// - the destination is pushed to the remote `origin`, with the same ref as source; never a delete,
//   never a `+` (forced) refspec, never more than one refspec;
// - no option except the four fixed ones below, so `--force`, `-f`, `--force-with-lease`,
//   `--force-if-includes`, `--mirror`, `--all`, `--tags`, `--delete` and `--prune` are all refused;
// - the GitHub token is never an argument: `GH_TOKEN` reaches the push child through its environment
//   and `gh auth git-credential` is the credential helper for that one command only (`-c`, never
//   written to git config). The general helper list is reset first, so no other helper sees it.
//
// The git adapter (`vcs/git`) receives `createPushGuard` from the composition root, because the
// layering rule forbids one adapter folder importing another file under `adapters/`
// (test/architecture.test.ts). It calls the factory once per workspace, builds the command from
// `pushArguments` and calls `assertSafePush` on the complete argument list right before it runs it.

import { PushRejectedError } from '../../core/domain/errors.ts';

/** The only remote Roster pushes to; the workspace sets it to the project's GitHub remote. */
export const PUSH_REMOTE = 'origin';

/** Credential helper for the push command only (ADR 0029, H10). It reads `GH_TOKEN`. */
export const PUSH_CREDENTIAL_HELPER = '!gh auth git-credential';

/** The options `git push` may carry; nothing else starting with `-` is accepted. */
export const PUSH_OPTIONS = ['--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no'] as const;

/** Branches never pushed, whatever the rules; the bound base branch is added to them. */
export const NEVER_PUSHED = ['main', 'master', 'develop'] as const;

/** The prefix whose whole namespace belongs to Roster (`agent/<name>`). */
export const ROSTER_PREFIX = 'agent';

/** Marker that starts the segment after any other prefix (`<prefix>/agent-<name>`). */
export const AGENT_MARKER = 'agent-';

/** The project's branch rules (ADR 0032 section 1), as the guard is created with them. */
export interface PushGuardRules {
  readonly baseBranch: string;
  readonly branchPrefix: string;
}

/** A guard bound to one project's rules. Both functions throw PushRejectedError. */
export interface PushGuard {
  /**
   * The arguments that follow the safe global options for a push of `branch`: the credential helper
   * for this command, then `push` with the fixed options, the remote and one `ref:ref` refspec.
   */
  pushArguments(branch: string): readonly string[];
  /** Checks the complete argument list of a `git push` before it runs. The list never has a secret. */
  assertSafePush(argv: readonly string[]): void;
}

const MAX_BRANCH_LENGTH = 200;
const MAX_BASE_LENGTH = 100;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PREFIX = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_PREFIXES: readonly string[] = ['main', 'master', 'develop', 'head', 'refs', 'origin'];
const HEADS = 'refs/heads/';

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

function plainSegment(segment: string): boolean {
  return SEGMENT.test(segment) && !segment.endsWith('.') && !segment.endsWith('.lock') && !segment.includes('..');
}

/** Validates the rules (ADR 0032 section 1). Messages name the field, never its value. */
function validateRules(branchPrefix: unknown, baseBranch: unknown): void {
  const rules = 'any branch';
  if (typeof branchPrefix !== 'string' || !PREFIX.test(branchPrefix)) {
    reject(rules, `the branchPrefix must match ${String(PREFIX)} (one lowercase segment)`);
  }
  if (RESERVED_PREFIXES.includes(branchPrefix)) {
    reject(rules, `the branchPrefix must not be one of: ${RESERVED_PREFIXES.join(', ')}`);
  }
  if (typeof baseBranch !== 'string' || baseBranch.length < 1 || baseBranch.length > MAX_BASE_LENGTH) {
    reject(rules, `the baseBranch must be 1 to ${MAX_BASE_LENGTH} characters`);
  }
  const segments = baseBranch.split('/');
  if (baseBranch.includes('..') || !segments.every(plainSegment)) {
    reject(rules, 'the baseBranch must be a plain branch name');
  }
  if (baseBranch.startsWith(`${ROSTER_PREFIX}/`)) reject(rules, 'the baseBranch must not be under agent/');
  if (segments.some((segment) => segment.startsWith(AGENT_MARKER))) {
    reject(rules, 'the baseBranch must not have a segment starting with "agent-"');
  }
  if (baseBranch === branchPrefix) reject(rules, 'the baseBranch must differ from the branchPrefix');
}

/**
 * Creates the push guard of one workspace, bound to the project's `{ baseBranch, branchPrefix }`.
 * The rules are validated and copied here; the returned object is frozen, so they cannot change
 * afterwards. Invalid rules throw PushRejectedError.
 */
export function createPushGuard(rules: PushGuardRules): PushGuard {
  if (typeof rules !== 'object' || rules === null) reject('any branch', 'the branch rules are missing');
  // Read each field once, so a getter or a later change of the caller's object cannot alter them.
  const branchPrefix: unknown = rules.branchPrefix;
  const baseBranch: unknown = rules.baseBranch;
  validateRules(branchPrefix, baseBranch);
  const prefix = branchPrefix as string;
  const base = baseBranch as string;
  const neverPushed: readonly string[] = Object.freeze([...new Set<string>([...NEVER_PUSHED, base])]);
  const namespace = prefix === ROSTER_PREFIX ? `${ROSTER_PREFIX}/` : `${prefix}/${AGENT_MARKER}`;

  function neverPushedName(name: string): string | undefined {
    const short = name.startsWith(HEADS) ? name.slice(HEADS.length) : name;
    return neverPushed.includes(short) ? short : undefined;
  }

  /** Checks a short branch name such as `agent/002-T10` and returns its full ref. */
  function branchRef(branch: string): string {
    if (typeof branch !== 'string' || branch.length === 0) reject(String(branch), 'the branch name is empty');
    const shown = describe(branch);
    const reserved = neverPushedName(branch);
    if (reserved !== undefined) reject(shown, `${reserved} is never pushed`);
    if (branch.length > MAX_BRANCH_LENGTH) reject(shown, `the branch name is longer than ${MAX_BRANCH_LENGTH} characters`);
    if (branch.startsWith('+')) reject(shown, 'forced (+) refspecs are never pushed');
    if (branch.startsWith('-')) reject(shown, 'the branch name looks like an option');
    if (branch.includes(':')) reject(shown, 'the branch name must not contain a refspec');
    if (!branch.startsWith(`${prefix}/`)) reject(shown, `only branches under ${namespace} may be pushed`);
    const rest = branch.slice(prefix.length + 1);
    if (rest.includes('/')) reject(shown, `exactly one segment may follow ${prefix}/`);
    if (!plainSegment(rest)) reject(shown, 'the branch name has an invalid segment');
    if (prefix !== ROSTER_PREFIX && (!rest.startsWith(AGENT_MARKER) || rest.length === AGENT_MARKER.length)) {
      reject(shown, `only branches under ${namespace} may be pushed`);
    }
    return `${HEADS}${branch}`;
  }

  function pushArguments(branch: string): readonly string[] {
    const ref = branchRef(branch);
    return ['-c', `credential.helper=${PUSH_CREDENTIAL_HELPER}`, 'push', ...PUSH_OPTIONS, PUSH_REMOTE, `${ref}:${ref}`];
  }

  function checkRefspec(refspec: string): void {
    const shown = describe(refspec);
    if (refspec.startsWith('+')) reject(shown, 'forced (+) refspecs are never pushed');
    const parts = refspec.split(':');
    if (parts.length !== 2) reject(shown, 'the refspec must be <ref>:<ref>');
    const [source = '', destination = ''] = parts;
    if (source.length === 0) reject(shown, 'deleting a remote branch is never allowed');
    const reserved = neverPushedName(destination);
    if (reserved !== undefined) reject(shown, `${reserved} is never pushed`);
    if (!destination.startsWith(`${HEADS}${namespace}`)) reject(shown, `the destination must be under ${HEADS}${namespace}`);
    if (source !== destination) reject(shown, 'the source and destination refs must be the same');
    branchRef(destination.slice(HEADS.length));
  }

  function assertSafePush(argv: readonly string[]): void {
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

  return Object.freeze({ pushArguments, assertSafePush });
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
