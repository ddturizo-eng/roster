// ForgePort (plan 002 section 4.3, ADR 0029, ADR 0032 sections 4 and 5): GitHub through `gh`. The token
// reaches only the `gh` child process; it is never an argument or part of an error message. Roster
// never merges.

export interface PullRequestRequest {
  /** `<owner>/<repo>` */
  readonly repo: string;
  /** An agent branch: `agent/<one segment>` or `<prefix>/agent-<rest>` (ADR 0032 section 2). */
  readonly branch: string;
  /** The project's base branch (`baseBranch` of the registration, ADR 0032 section 4). */
  readonly base: string;
  readonly title: string;
  /** Passed to `gh` through a file or stdin, never as an argument. */
  readonly body: string;
}

export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

export type PrState =
  | { readonly state: 'open' }
  | { readonly state: 'merged'; readonly mergedAt: string }
  | { readonly state: 'closed' };

/**
 * Protection of one branch (ADR 0032 section 5): `missing` when the branch does not exist, `unknown`
 * when the token cannot read enough of it (no Administration read), otherwise the two flags.
 */
export type BranchProtection =
  | { readonly state: 'missing' }
  | { readonly state: 'unknown' }
  | { readonly state: 'known'; readonly prRequired: boolean; readonly forcePushBlocked: boolean };

export interface ForgePort {
  /** Reuses the open PR from `branch` into `base` or creates one. */
  ensurePr(request: PullRequestRequest): Promise<PullRequestRef>;
  prState(repo: string, number: number): Promise<PrState>;
  branchProtection(repo: string, branch: string): Promise<BranchProtection>;
  /** True when the token can read `repo` (`roster project add`, `doctor`). */
  canRead(repo: string): Promise<boolean>;
}
