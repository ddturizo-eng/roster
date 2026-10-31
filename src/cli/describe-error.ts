// One safe line for an error shown on the console: class name and a cleaned, length-limited message
// with token-shaped text redacted. Adapters never put secret values in a message; this is the second
// line of defense.

import { inlineText } from '../core/messages/safe-text.ts';

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  const message = inlineText(error.message);
  return message === '' ? error.name : `${error.name}: ${message}`;
}
