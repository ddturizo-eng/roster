// Typed error for a rejected `tasks.md` import (ADR 0019). Code branches on `instanceof` or `name`.

import { RosterError } from '../domain/errors.ts';
import { formatTasksMdIssue } from './issue.ts';
import type { TasksMdIssue } from './issue.ts';

/** The whole import is rejected: nothing is written (ADR 0019, import rule 2). */
export class TasksMdError extends RosterError {
  override readonly name = 'TasksMdError';
  readonly issues: readonly TasksMdIssue[];

  constructor(issues: readonly TasksMdIssue[]) {
    const shown = issues.slice(0, 5).map(formatTasksMdIssue).join('; ');
    const more = issues.length > 5 ? `; and ${issues.length - 5} more` : '';
    super(`Invalid tasks.md: ${shown}${more}`);
    this.issues = issues;
  }
}
