// ForgePort (plan 002 section 4.3, ADR 0029): GitHub through `gh`. The token reaches only the `gh`
// child process; it is never an argument or part of an error message. Roster never merges.

export interface PullRequestRequest {
  /** `<owner>/<repo>` */
  readonly repo: string;
  readonly branch: string;
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

/** `unknown` when the token lacks Administration read. */
export type MainProtection =
  | { readonly known: true; readonly prRequired: boolean; readonly forcePushBlocked: boolean }
  | { readonly known: false };

export interface ForgePort {
  /** Reuses the open PR of `branch` or creates one against `main`. */
  ensurePr(request: PullRequestRequest): Promise<PullRequestRef>;
  prState(repo: string, number: number): Promise<PrState>;
  mainProtection(repo: string): Promise<MainProtection>;
  /** True when the token can read `repo` (`roster project add`, `doctor`). */
  canRead(repo: string): Promise<boolean>;
}
