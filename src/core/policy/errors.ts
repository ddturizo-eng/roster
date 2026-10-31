// Typed error for an invalid policy file or an unsafe policy input (ADR 0024, ADR 0025).

import { RosterError } from '../domain/errors.ts';

/** A policy file is malformed, or a project policy tries to weaken the defaults. */
export class PolicyError extends RosterError {
  override readonly name = 'PolicyError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const shown = problems.slice(0, 5).join('; ');
    const more = problems.length > 5 ? `; and ${problems.length - 5} more` : '';
    super(`Invalid policy: ${shown}${more}`);
    this.problems = problems;
  }
}
