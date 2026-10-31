// Agent branch names and branch rules (ADR 0032 sections 1 and 2). Pure: this is the only place that
// formats an agent branch name. Messages describe the rule that failed and never echo the value.

import { FEATURE_NUMBER_PATTERN, SLUG_PATTERN, TASK_KEY_PATTERN } from './ids.ts';
import { RosterError } from './errors.ts';

/** Per-project branch rules, from the registration (ADR 0032 section 1). */
export interface BranchRules {
  readonly baseBranch: string;
  readonly branchPrefix: string;
}

export const DEFAULT_BASE_BRANCH = 'main';
export const DEFAULT_BRANCH_PREFIX = 'agent';

/** The Roster repo is fixed to `main` and `agent`; hire and registration branches always use them. */
export const ROSTER_REPO_BRANCH_RULES: BranchRules = Object.freeze({
  baseBranch: 'main',
  branchPrefix: 'agent',
});

/** An input to a branch-name builder is malformed. */
export class BranchNameError extends RosterError {
  override readonly name = 'BranchNameError';
  readonly input: string;

  /** `input` names the parameter (`NNN`, `Tnn`, `slug`, `branchPrefix`), never its value. */
  constructor(input: string, reason: string) {
    super(`Invalid ${input}: ${reason}`);
    this.input = input;
  }
}

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PREFIX_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_PREFIXES: readonly string[] = ['main', 'master', 'develop', 'head', 'refs', 'origin'];
const MAX_BASE_LENGTH = 100;

/** Returns the rule that `value` breaks, or `undefined` when it is a valid `branchPrefix`. */
export function branchPrefixProblem(value: string): string | undefined {
  if (!PREFIX_PATTERN.test(value)) {
    return `must match ${String(PREFIX_PATTERN)} (one lowercase segment)`;
  }
  if (RESERVED_PREFIXES.includes(value)) {
    return `must not be one of: ${RESERVED_PREFIXES.join(', ')}`;
  }
  return undefined;
}

/**
 * Returns the rule that `value` breaks, or `undefined` when it is a valid `baseBranch`.
 * `branchPrefix` is the registration's prefix, to refuse a base equal to it.
 */
export function baseBranchProblem(value: string, branchPrefix: string): string | undefined {
  if (value.length < 1 || value.length > MAX_BASE_LENGTH) {
    return `must be 1 to ${MAX_BASE_LENGTH} characters`;
  }
  const segments = value.split('/');
  if (value.includes('..') || !segments.every((s) => SEGMENT_PATTERN.test(s) && !s.endsWith('.') && !s.endsWith('.lock'))) {
    return 'must be a plain branch name: "/"-separated segments of letters, digits, ".", "_" and "-"';
  }
  if (value.startsWith('agent/')) return 'must not be under the agent/ namespace';
  if (segments.some((s) => s.startsWith('agent-'))) return 'must not have a segment starting with "agent-"';
  if (value === branchPrefix) return 'must differ from branchPrefix';
  return undefined;
}

/** Validates rules; throws `BranchNameError` when invalid. */
export function assertBranchRules(rules: BranchRules): void {
  const prefix = branchPrefixProblem(rules.branchPrefix);
  if (prefix !== undefined) throw new BranchNameError('branchPrefix', prefix);
  const base = baseBranchProblem(rules.baseBranch, rules.branchPrefix);
  if (base !== undefined) throw new BranchNameError('baseBranch', base);
}

/** `agent/` for prefix `agent`, `<prefix>/agent-` otherwise. */
function namespace(rules: BranchRules): string {
  const prefix = rules.branchPrefix;
  if (branchPrefixProblem(prefix) !== undefined) {
    throw new BranchNameError('branchPrefix', 'is not a valid branch prefix');
  }
  return prefix === DEFAULT_BRANCH_PREFIX ? 'agent/' : `${prefix}/agent-`;
}

function featureNumber(value: string): string {
  if (!FEATURE_NUMBER_PATTERN.test(value)) throw new BranchNameError('NNN', 'must be three digits');
  return value;
}

function slugOf(value: string, input: string): string {
  if (!SLUG_PATTERN.test(value) || value.length > 100) {
    throw new BranchNameError(input, 'must be a lowercase slug of at most 100 characters');
  }
  return value;
}

/** `agent/002-T01` or `feature/agent-002-T01`. */
export function taskBranch(rules: BranchRules, nnn: string, tnn: string): string {
  const ns = namespace(rules);
  featureNumber(nnn);
  if (!TASK_KEY_PATTERN.test(tnn)) throw new BranchNameError('Tnn', 'must be T and two or three digits');
  return `${ns}${nnn}-${tnn}`;
}

/** `agent/014-spec` or `feature/agent-014-spec`. */
export function specBranch(rules: BranchRules, nnn: string): string {
  const ns = namespace(rules);
  return `${ns}${featureNumber(nnn)}-spec`;
}

/** `agent/014-plan` or `feature/agent-014-plan`. */
export function planBranch(rules: BranchRules, nnn: string): string {
  const ns = namespace(rules);
  return `${ns}${featureNumber(nnn)}-plan`;
}

/** `agent/hire-<slug>`; Roster repo only, whatever the target project's prefix. */
export function hireBranch(slug: string): string {
  return `${namespace(ROSTER_REPO_BRANCH_RULES)}hire-${slugOf(slug, 'slug')}`;
}

/** `agent/project-<name>`; Roster repo only. */
export function registrationBranch(name: string): string {
  return `${namespace(ROSTER_REPO_BRANCH_RULES)}project-${slugOf(name, 'name')}`;
}

/** True exactly for names in the project's agent namespace with one non-empty segment after it. */
export function isAgentBranch(rules: BranchRules, name: string): boolean {
  let ns: string;
  try {
    ns = namespace(rules);
  } catch {
    return false;
  }
  if (!name.startsWith(ns)) return false;
  const rest = name.slice(ns.length);
  return rest.length > 0 && !rest.includes('/');
}
