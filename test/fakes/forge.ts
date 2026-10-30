// Fake ForgePort: PRs get numbers 1, 2, 3...; an open PR of the same repo and branch is reused.

import type { ForgePort, MainProtection, PrState, PullRequestRef, PullRequestRequest } from '../../src/ports/forge.ts';
import { CallLog, Responses } from './recorder.ts';

export class FakeForge implements ForgePort {
  readonly log: CallLog;
  readonly responses = new Responses<ForgePort>();
  /** PRs created by `ensurePr`, keyed by `<repo>#<branch>`. */
  readonly prs = new Map<string, PullRequestRef>();
  #nextNumber = 1;

  constructor(log: CallLog = new CallLog()) {
    this.log = log;
  }

  async ensurePr(request: PullRequestRequest): Promise<PullRequestRef> {
    this.log.record('forge', 'ensurePr', [request]);
    return this.responses.answer('ensurePr', [request], () => {
      const key = `${request.repo}#${request.branch}`;
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

  async mainProtection(repo: string): Promise<MainProtection> {
    this.log.record('forge', 'mainProtection', [repo]);
    return this.responses.answer('mainProtection', [repo], (): MainProtection => ({
      known: true,
      prRequired: true,
      forcePushBlocked: true,
    }));
  }

  async canRead(repo: string): Promise<boolean> {
    this.log.record('forge', 'canRead', [repo]);
    return this.responses.answer('canRead', [repo], () => true);
  }
}
