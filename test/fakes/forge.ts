// Fake ForgePort: PRs get numbers 1, 2, 3...; an open PR of the same repo, branch and base is reused.

import type { BranchProtection, ForgePort, PrState, PullRequestRef, PullRequestRequest } from '../../src/ports/forge.ts';
import { CallLog, Responses } from './recorder.ts';

export class FakeForge implements ForgePort {
  readonly log: CallLog;
  readonly responses = new Responses<ForgePort>();
  /** PRs created by `ensurePr`, keyed by `<repo>#<branch>-><base>`. */
  readonly prs = new Map<string, PullRequestRef>();
  #nextNumber = 1;

  constructor(log: CallLog = new CallLog()) {
    this.log = log;
  }

  async ensurePr(request: PullRequestRequest): Promise<PullRequestRef> {
    this.log.record('forge', 'ensurePr', [request]);
    return this.responses.answer('ensurePr', [request], () => {
      const key = `${request.repo}#${request.branch}->${request.base}`;
      const existing = this.prs.get(key);
      if (existing !== undefined) return existing;
      const number = this.#nextNumber++;
      const pr = { number, url: `https://github.com/${request.repo}/pull/${number}` };
      this.prs.set(key, pr);
      return pr;
    });
  }

  async prState(repo: string, number: number): Promise<PrState> {
    this.log.record('forge', 'prState', [repo, number]);
    return this.responses.answer('prState', [repo, number], (): PrState => ({ state: 'open' }));
  }

  async branchProtection(repo: string, branch: string): Promise<BranchProtection> {
    this.log.record('forge', 'branchProtection', [repo, branch]);
    return this.responses.answer('branchProtection', [repo, branch], (): BranchProtection => ({
      state: 'known',
      prRequired: true,
      forcePushBlocked: true,
    }));
  }

  async canRead(repo: string): Promise<boolean> {
    this.log.record('forge', 'canRead', [repo]);
    return this.responses.answer('canRead', [repo], () => true);
  }
}
