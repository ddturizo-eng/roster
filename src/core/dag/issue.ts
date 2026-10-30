// Problems found while reading `tasks.md` (ADR 0019). Errors reject the import; warnings do not.

export type TasksMdErrorCode =
  | 'invalid_heading'
  | 'duplicate_id'
  | 'duplicate_field'
  | 'missing_field'
  | 'invalid_value'
  | 'empty_acceptance_criteria'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'dependency_cycle';

export type TasksMdWarningCode = 'unknown_key' | 'unrecognized_line' | 'duplicate_dependency';

export interface TasksMdIssue {
  /** 1-based line number in the parsed text. */
  readonly line: number;
  /** Task key (`T03`) the problem belongs to; null when it belongs to no task. */
  readonly taskId: string | null;
  readonly code: TasksMdErrorCode | TasksMdWarningCode;
  /** English description of the rule that failed. It never repeats long text from the file. */
  readonly message: string;
}

/** One line for logs and `import_failed` reasons, for example `line 12, T03: ...`. */
export function formatTasksMdIssue(issue: TasksMdIssue): string {
  const where = issue.taskId === null ? `line ${issue.line}` : `line ${issue.line}, ${issue.taskId}`;
  return `${where}: ${issue.message}`;
}
