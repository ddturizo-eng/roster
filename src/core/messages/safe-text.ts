// Makes untrusted values safe to place inside a message (ADR 0026, ADR 0031). Values can come from
// agent results, PR data, git output or log tails, so every interpolated string is:
// - redacted: token-shaped substrings (Anthropic and GitHub credential formats) become `[redacted]`,
//   so a secret that slipped into a value never reaches the console or the store;
// - cleaned: control characters (C0, DEL, C1, including ESC) and bidirectional overrides are
//   replaced, so a value cannot move the cursor, recolor the terminal or reorder the text;
// - length-limited: one-line values are cut, lists keep their first items, tails keep their end.

export const REDACTED = '[redacted]';

/** Longest one-line value placed in a message, in characters. */
export const MAX_INLINE_LENGTH = 200;

/** Longest multi-line tail (for example the end of a verify log), in characters and lines. */
export const MAX_TAIL_LENGTH = 2000;
export const MAX_TAIL_LINES = 20;

/** Most list items shown; the rest are summarized as `+N`. */
export const MAX_LIST_ITEMS = 20;

const ELLIPSIS = '…';
const REPLACEMENT = '�';

// Credential formats: Anthropic keys and OAuth tokens (`sk-ant-...`), GitHub classic tokens
// (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and fine-grained PATs (`github_pat_`).
const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/g;

// C0 except tab, line feed and carriage return; DEL; C1; bidirectional embeddings, overrides and
// isolates (U+202A-U+202E, U+2066-U+2069).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

export function redactTokens(value: string): string {
  return value.replace(TOKEN_PATTERN, REDACTED);
}

function clipEnd(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}${ELLIPSIS}`;
}

function clipStart(value: string, max: number): string {
  return value.length <= max ? value : `${ELLIPSIS}${value.slice(value.length - (max - 1))}`;
}

/** A single line: line breaks and tabs become spaces, other control characters are replaced. */
export function inlineText(value: string, max: number = MAX_INLINE_LENGTH): string {
  const cleaned = redactTokens(value)
    .replace(CONTROL, REPLACEMENT)
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
  return clipEnd(cleaned, max);
}

/** The last lines of a multi-line text, for log tails; keeps line feeds only. */
export function tailText(value: string): string {
  const lines = redactTokens(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, REPLACEMENT)
    .replace(/\n+$/, '')
    .split('\n');
  return clipStart(lines.slice(-MAX_TAIL_LINES).join('\n'), MAX_TAIL_LENGTH);
}

/** Every item as one line, at most `MAX_LIST_ITEMS` items plus a `+N` item for the rest. */
export function listText(values: readonly string[]): readonly string[] {
  const shown = values.slice(0, MAX_LIST_ITEMS).map((item) => inlineText(item));
  const hidden = values.length - shown.length;
  return hidden > 0 ? [...shown, `+${hidden}`] : shown;
}

/** Message parameter values accepted by templates. */
export type ParamValue = string | number | null | readonly string[];

/** Parameter names whose value is a multi-line tail; every other string is one line. */
const TAIL_PARAMS: ReadonlySet<string> = new Set(['tail']);

/** Applies the rules above to every value of a parameter object. */
export function safeParams<P extends object>(params: P): P {
  const safe: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params) as [string, unknown][]) {
    if (typeof value === 'string') {
      safe[name] = TAIL_PARAMS.has(name) ? tailText(value) : inlineText(value);
    } else if (Array.isArray(value)) {
      safe[name] = listText(value.map((item) => String(item)));
    } else if (typeof value === 'number') {
      safe[name] = Number.isFinite(value) ? value : null;
    } else {
      // `null`, and anything that is not a ParamValue, is shown as absent.
      safe[name] = null;
    }
  }
  return safe as P;
}
