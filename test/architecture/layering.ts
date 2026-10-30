// Import scanner and layering rules for test/architecture.test.ts (plan 002 section 4.1, ADR 0017).
//
// The scanner is a small hand-written lexer instead of the TypeScript compiler API, so the rules do
// not depend on the compiler version. It skips comments, template text and regular expression
// literals, and reports every module specifier with its line number:
//   import x from 'm'; import type { T } from 'm'; import 'm'; import x = require('m');
//   export * from 'm'; export * as ns from 'm'; export { a } from 'm'; export type { T } from 'm';
//   import('m') in values and in types. A dynamic import whose argument is not a single string
//   literal is reported with a null specifier, because its target cannot be checked.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

export type ImportKind = 'static' | 'side-effect' | 're-export' | 'dynamic' | 'require';

export interface ImportRef {
  readonly specifier: string | null;
  readonly line: number;
  readonly kind: ImportKind;
}

/** A source file with its path relative to the scanned `src` root, using `/` separators. */
export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

export type RuleId =
  | 'file-outside-layers'
  | 'core-imports-outside-core-and-ports'
  | 'ports-imports-outside-core-domain'
  | 'adapter-imports-another-adapter'
  | 'adapter-imports-cli'
  | 'non-literal-dynamic-import';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string | null;
  readonly rule: RuleId;
}

export type Layer = 'core' | 'ports' | 'adapters' | 'cli';

const LAYERS: readonly Layer[] = ['core', 'ports', 'adapters', 'cli'];

const SOURCE_EXTENSION = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

// ---------------------------------------------------------------------------------------------
// Lexer

type TokenType = 'word' | 'string' | 'punct' | 'value';

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly line: number;
}

// After these keywords a `/` starts a regular expression literal, not a division.
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);

function isWordStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}

function isWordPart(ch: string): boolean {
  return /[\w$]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}

function slashStartsRegex(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.type === 'punct') return previous.value !== ')' && previous.value !== ']' && previous.value !== '}';
  if (previous.type === 'word') return KEYWORDS_BEFORE_EXPRESSION.has(previous.value);
  return false;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let i = 0;
  let line = 1;
  // Brace depth inside the current code region, and the saved depths of enclosing template
  // literals: a `}` at depth 0 with a saved template resumes that template's text.
  let braceDepth = 0;
  const templateStack: number[] = [];

  // Reads template text from `start` up to the closing backtick or the next `${`.
  const readTemplateText = (start: number): number => {
    let j = start;
    while (j < length) {
      const c = source[j];
      if (c === '\\') {
        if (source[j + 1] === '\n') line++;
        j += 2;
        continue;
      }
      if (c === '\n') line++;
      if (c === '`') return j + 1;
      if (c === '$' && source[j + 1] === '{') {
        templateStack.push(braceDepth);
        braceDepth = 0;
        return j + 2;
      }
      j++;
    }
    return length;
  };

  while (i < length) {
    const ch = source[i] ?? '';
    const next = source[i + 1];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch) || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? length : end + 2;
      for (let j = i; j < stop; j++) if (source[j] === '\n') line++;
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      let value = '';
      let j = i + 1;
      while (j < length && source[j] !== ch && source[j] !== '\n') {
        if (source[j] === '\\') {
          const escaped = source[j + 1] ?? '';
          if (escaped === '\n') line++;
          else if (escaped === '\r' && source[j + 2] === '\n') {
            line++;
            j++;
          } else value += escaped;
          j += 2;
          continue;
        }
        value += source[j];
        j++;
      }
      tokens.push({ type: 'string', value, line: startLine });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      tokens.push({ type: 'value', value: 'template', line });
      i = readTemplateText(i + 1);
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      tokens.push({ type: 'punct', value: ch, line });
      i++;
      continue;
    }
    if (ch === '}') {
      const savedDepth = braceDepth === 0 ? templateStack.pop() : undefined;
      if (savedDepth !== undefined) {
        braceDepth = savedDepth;
        tokens.push({ type: 'value', value: 'template', line });
        i = readTemplateText(i + 1);
        continue;
      }
      braceDepth--;
      tokens.push({ type: 'punct', value: ch, line });
      i++;
      continue;
    }
    if (ch === '/' && slashStartsRegex(tokens[tokens.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < length && source[j] !== '\n') {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          j++;
          break;
        }
        j++;
      }
      while (j < length && /[a-z]/i.test(source[j] ?? '')) j++;
      tokens.push({ type: 'value', value: 'regex', line });
      i = j;
      continue;
    }
    if (isWordStart(ch) || /[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < length && isWordPart(source[j] ?? '')) j++;
      tokens.push({ type: 'word', value: source.slice(i, j), line });
      i = j;
      continue;
    }
    tokens.push({ type: 'punct', value: ch, line });
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Import extraction

function isWord(token: Token | undefined, value: string): boolean {
  return token?.type === 'word' && token.value === value;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.type === 'punct' && token.value === value;
}

// Finds `from '<specifier>'` after an import clause, stopping at the end of the statement.
function findFromClause(tokens: readonly Token[], start: number): Token | undefined {
  for (let j = start; j < tokens.length; j++) {
    const token = tokens[j];
    if (isPunct(token, ';') || isWord(token, 'import') || isWord(token, 'export')) return undefined;
    const following = tokens[j + 1];
    if (isWord(token, 'from') && following?.type === 'string') return following;
  }
  return undefined;
}

/** Lists every module specifier imported or re-exported by a TypeScript or JavaScript source. */
export function scanImports(source: string): ImportRef[] {
  const tokens = tokenize(source);
  const refs: ImportRef[] = [];

  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token?.type !== 'word') continue;
    // `foo.import(...)` and `foo?.export` are property accesses.
    if (isPunct(tokens[k - 1], '.')) continue;
    const next = tokens[k + 1];

    if (token.value === 'import') {
      if (next?.type === 'string') {
        refs.push({ specifier: next.value, line: next.line, kind: 'side-effect' });
        continue;
      }
      if (isPunct(next, '(')) {
        const argument = tokens[k + 2];
        const after = tokens[k + 3];
        const literal = argument?.type === 'string' && (isPunct(after, ')') || isPunct(after, ','));
        refs.push({
          specifier: literal ? argument.value : null,
          line: argument?.line ?? token.line,
          kind: 'dynamic',
        });
        continue;
      }
      if (next?.type === 'word' && isPunct(tokens[k + 2], '=')) {
        const call = tokens[k + 5];
        if (isWord(tokens[k + 3], 'require') && isPunct(tokens[k + 4], '(') && call?.type === 'string') {
          refs.push({ specifier: call.value, line: call.line, kind: 'require' });
        }
        continue;
      }
      if (next?.type === 'word' || isPunct(next, '{') || isPunct(next, '*')) {
        const from = findFromClause(tokens, k + 1);
        if (from !== undefined) refs.push({ specifier: from.value, line: from.line, kind: 'static' });
      }
      continue;
    }

    if (token.value === 'export') {
      let j = k + 1;
      if (isWord(tokens[j], 'type')) j++;
      if (isPunct(tokens[j], '*')) {
        // export * from 'm' | export * as ns from 'm'
        let fromIndex = j + 1;
        if (isWord(tokens[fromIndex], 'as')) fromIndex += 2;
        const specifier = tokens[fromIndex + 1];
        if (isWord(tokens[fromIndex], 'from') && specifier?.type === 'string') {
          refs.push({ specifier: specifier.value, line: specifier.line, kind: 're-export' });
        }
        continue;
      }
      if (isPunct(tokens[j], '{')) {
        let depth = 0;
        let close = j;
        for (; close < tokens.length; close++) {
          if (isPunct(tokens[close], '{')) depth++;
          else if (isPunct(tokens[close], '}') && --depth === 0) break;
        }
        const specifier = tokens[close + 2];
        if (isWord(tokens[close + 1], 'from') && specifier?.type === 'string') {
          refs.push({ specifier: specifier.value, line: specifier.line, kind: 're-export' });
        }
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// Layering rules

/** Returns the layer of a path relative to `src`, or undefined when it is in no layer. */
export function layerOf(path: string): Layer | undefined {
  const first = path.split('/')[0];
  return LAYERS.find((layer) => layer === first && path.length > layer.length);
}

/** An adapter is `adapters/<kind>/<name>`, for example `adapters/runtime/claude-code`. */
function adapterOf(path: string): string {
  return path.split('/').slice(0, 3).join('/');
}

type Target = { readonly kind: 'src'; readonly path: string } | { readonly kind: 'outside' };

function resolveTarget(fromFile: string, specifier: string): Target {
  const relative = specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
  if (!relative) return { kind: 'outside' };
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (resolved === '..' || resolved.startsWith('../')) return { kind: 'outside' };
  return { kind: 'src', path: resolved.replace(/\/$/, '') };
}

function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function ruleBroken(fromFile: string, layer: Layer, target: Target): RuleId | undefined {
  switch (layer) {
    case 'core':
      return target.kind === 'src' && (isUnder(target.path, 'core') || isUnder(target.path, 'ports'))
        ? undefined
        : 'core-imports-outside-core-and-ports';
    case 'ports':
      return target.kind === 'src' && isUnder(target.path, 'core/domain')
        ? undefined
        : 'ports-imports-outside-core-domain';
    case 'adapters':
      if (target.kind !== 'src') return undefined;
      if (isUnder(target.path, 'cli')) return 'adapter-imports-cli';
      if (isUnder(target.path, 'adapters') && adapterOf(target.path) !== adapterOf(fromFile)) {
        return 'adapter-imports-another-adapter';
      }
      return undefined;
    case 'cli':
      return undefined;
  }
}

/**
 * Checks the dependency rule of plan 002 section 4.1 on files whose paths are relative to `src`:
 * - every source file belongs to one of the layers `core`, `ports`, `adapters`, `cli`;
 * - `core` imports only `core` and `ports` (no Node built-ins, no packages);
 * - `ports` imports only `core/domain`;
 * - an adapter (`adapters/<kind>/<name>`) never imports another adapter or `cli`;
 * - `core`, `ports` and adapters never use a dynamic import whose target cannot be read.
 */
export function checkLayering(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const layer = layerOf(file.path);
    if (layer === undefined) {
      violations.push({ file: file.path, line: 1, specifier: null, rule: 'file-outside-layers' });
      continue;
    }
    for (const ref of scanImports(file.source)) {
      if (ref.specifier === null) {
        if (layer !== 'cli') {
          violations.push({ file: file.path, line: ref.line, specifier: null, rule: 'non-literal-dynamic-import' });
        }
        continue;
      }
      const rule = ruleBroken(file.path, layer, resolveTarget(file.path, ref.specifier));
      if (rule !== undefined) {
        violations.push({ file: file.path, line: ref.line, specifier: ref.specifier, rule });
      }
    }
  }
  return violations;
}

/** Reads every source file under `root`, sorted by path, with `/`-separated relative paths. */
export function readSourceTree(root: string): SourceFile[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => SOURCE_EXTENSION.test(entry) && statSync(join(root, entry)).isFile())
    .map((entry) => ({ path: entry.split(sep).join('/'), source: readFileSync(join(root, entry), 'utf8') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
