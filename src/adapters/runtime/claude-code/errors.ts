// Typed error of the Claude Code runtime adapter for jobs it refuses to describe. It names the field
// and the rule, never the value: prompts and agent bodies are untrusted text.

import { RosterError } from '../../../core/domain/errors.ts';

/** A job or an adapter option would produce an unsafe or invalid invocation. */
export class RuntimeInputError extends RosterError {
  override readonly name = 'RuntimeInputError';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.field = field;
  }
}
