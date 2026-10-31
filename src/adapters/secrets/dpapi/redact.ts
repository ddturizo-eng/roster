// Redaction of known secret values (ADR 0029). Replaces every occurrence of each given value with
// `[redacted]`. Token-shaped text that is not a known value is handled by `core/messages/safe-text`.

export const REDACTED = '[redacted]';

/** `text` with every non-empty value of `secrets` replaced by `[redacted]`; longest values first. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  const values = [...new Set(secrets)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  if (values.length === 0) return text;
  // One pass with alternation (longest first), so a replacement is never searched again.
  const pattern = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text.replace(pattern, REDACTED);
}
