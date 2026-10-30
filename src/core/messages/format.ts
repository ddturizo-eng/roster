// Renders human-facing text in `human_language` (plan 002 section 4.2). Pure.

import type { Catalog, MessageKey, MessageParams } from './catalog.ts';
import { EN } from './en.ts';
import { ES } from './es.ts';
import type { Language } from './language.ts';
import { safeParams } from './safe-text.ts';

export const CATALOGS: { readonly [L in Language]: Catalog } = { en: EN, es: ES };

/** Every message key, in catalog order. */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(EN) as MessageKey[];

/**
 * The text of `key` in `language`, with every parameter made safe first (redacted, one line,
 * length-limited). A language without a catalog falls back to English.
 */
export function formatMessage<K extends MessageKey>(
  language: Language,
  key: K,
  params: MessageParams[K],
): string {
  const catalog: Catalog = CATALOGS[language] ?? CATALOGS.en;
  const template = catalog[key] as (safe: MessageParams[K]) => string;
  return template(safeParams(params));
}

/** A formatter bound to one language, for callers that render many messages. */
export type Messages = <K extends MessageKey>(key: K, params: MessageParams[K]) => string;

export function messagesFor(language: Language): Messages {
  return (key, params) => formatMessage(language, key, params);
}
