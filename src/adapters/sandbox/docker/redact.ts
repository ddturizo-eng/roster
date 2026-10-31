// Redaction of known secret values in job logs (ADR 0031, plan 002 section 12). Same behavior and
// marker as `redactSecrets` of the DPAPI adapter; the layering rule forbids one adapter importing
// another (test/architecture.test.ts), so the sandbox keeps its own copy.

export const REDACTED = '[redacted]';

/**
 * Returns a function that replaces every occurrence of each non-empty value with `[redacted]`, in one
 * pass with alternation (longest value first), so a replacement is never searched again.
 */
export function secretRedactor(secrets: Iterable<string>): (text: string) => string {
  const values = [...new Set(secrets)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  if (values.length === 0) return (text) => text;
  const pattern = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (text) => text.replace(pattern, REDACTED);
}

/** Length of the longest non-empty secret, 0 when there is none. */
export function longestSecret(secrets: Iterable<string>): number {
  let longest = 0;
  for (const value of secrets) longest = Math.max(longest, value.length);
  return longest;
}
