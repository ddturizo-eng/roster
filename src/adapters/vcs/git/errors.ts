// Typed error of the git adapter for inputs it refuses before running git. It names the field, never
// a secret: the GitHub token is checked for shape only and is never part of a message.

import { RosterError } from '../../../core/domain/errors.ts';

/** An argument would be unsafe or invalid to hand to git (ref, path, id, author, workspace state). */
export class GitInputError extends RosterError {
  override readonly name = 'GitInputError';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.field = field;
  }
}
