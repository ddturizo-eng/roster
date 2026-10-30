// Identifier formats of plan 002 section 5 and ADR 0019.

/** Execution ids are time-ordered: `<yyyymmddhhmmss>-<6 hex>` (plan 002 section 5). */
export const EXECUTION_ID_PATTERN = /^\d{14}-[0-9a-f]{6}$/;

/** Feature number inside a project: three digits, for example `002`. */
export const FEATURE_NUMBER_PATTERN = /^\d{3}$/;

/** Task key inside a feature: `T` and two or three digits (ADR 0019). */
export const TASK_KEY_PATTERN = /^T\d{2,3}$/;

/** Agent and project slugs (ADR 0021): lowercase letters, digits and hyphens. */
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

export function isExecutionId(value: string): boolean {
  return EXECUTION_ID_PATTERN.test(value);
}

/** Feature id `<project>:<NNN>`, for example `roster:002`. */
export function featureId(project: string, number: string): string {
  return `${project}:${number}`;
}

/** Task id `<project>:<NNN>-<Tnn>`, for example `roster:002-T02`. */
export function taskId(project: string, number: string, key: string): string {
  return `${project}:${number}-${key}`;
}
