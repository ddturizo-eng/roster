// Typed error of the Docker sandbox adapter for requests it refuses before running docker. It names
// the field, never a value of the environment: secret values are checked for shape only.

import { RosterError } from '../../../core/domain/errors.ts';

/** A request would be unsafe or invalid to hand to docker (ids, names, paths, image, limits, env). */
export class SandboxInputError extends RosterError {
  override readonly name = 'SandboxInputError';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.field = field;
  }
}
