// Typed error of the GitHub adapter for inputs it refuses before running gh. It names the field, never
// a secret: the GitHub token is checked for shape only and is never part of a message.

import { RosterError } from '../../../core/domain/errors.ts';

/** An argument would be unsafe or invalid to hand to gh (repo, branch, PR number, title, body, token). */
export class GitHubInputError extends RosterError {
  override readonly name = 'GitHubInputError';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.field = field;
  }
}
