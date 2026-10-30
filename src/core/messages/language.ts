// Human language of Roster's console text and stop reasons (constitution `human_language`, plan 002
// section 4.2). Only the languages with a full template catalog are supported; anything else,
// including a missing setting, falls back to English.

export const LANGUAGES = ['es', 'en'] as const;

export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** Maps a language code to a supported language; unknown, empty or missing codes give `en`. */
export function resolveLanguage(code: string | null | undefined): Language {
  if (code === null || code === undefined) return DEFAULT_LANGUAGE;
  const normalized = code.trim().toLowerCase();
  return isLanguage(normalized) ? normalized : DEFAULT_LANGUAGE;
}

// Matches the settings line of `specs/constitution.md`, for example:
//   - `human_language`: `es` (Spanish). Agents talk to the human in this language.
// The key must start the line (after an optional list marker), so prose that mentions
// `human_language` later in the file is not read as the setting.
const HUMAN_LANGUAGE_LINE =
  /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?`?human_language`?(?:\*\*)?[ \t]*:[ \t]*`?([A-Za-z][A-Za-z0-9-]*)`?/m;

/**
 * Reads `human_language` from the text of `specs/constitution.md`. The first settings line wins.
 * A missing line or an unsupported code gives `en`.
 */
export function parseHumanLanguage(constitutionText: string): Language {
  const match = HUMAN_LANGUAGE_LINE.exec(constitutionText);
  return resolveLanguage(match?.[1]);
}
