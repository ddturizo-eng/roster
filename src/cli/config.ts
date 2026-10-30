// Machine config (ADR 0018): `%LOCALAPPDATA%\Roster\config.json`, plus the human language of the
// pinned install (`specs/constitution.md`, ADR 0025). Every problem in the file is reported at once:
// a missing required key, a value of the wrong type or range, and an unknown key (most likely a typo).

import { readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../core/domain/errors.ts';
import { SLUG_PATTERN } from '../core/domain/ids.ts';
import { IssueCollector, childPath, indexPath, isRecord } from '../core/domain/validation.ts';
import type { StringRule, ValidationIssue } from '../core/domain/validation.ts';
import { DEFAULT_LANGUAGE, parseHumanLanguage } from '../core/messages/language.ts';
import type { Language } from '../core/messages/language.ts';
import { inlineText } from '../core/messages/safe-text.ts';
import type { CommitAuthor } from '../ports/vcs.ts';

export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

/** Local-time window of the night runs; `end` is on the next day when it is not after `start`. */
export interface NightWindow {
  readonly start: TimeOfDay;
  readonly end: TimeOfDay;
}

export interface RosterConfig {
  /** Absolute path of the local clone of the Roster repo. */
  readonly rosterRepo: string;
  /** Absolute path of the directory that holds per-execution workspaces. */
  readonly workspaceRoot: string;
  readonly maxRunsPerNight: number;
  /** Fallback cooldown after quota exhaustion when no usable reset time is reported (ADR 0030). */
  readonly quotaCooldownMinutes: number;
  readonly workspaceRetentionDays: number;
  /** Identity of the commits Roster makes (plan 002 section 8, step 6). */
  readonly commitAuthor: CommitAuthor;
  readonly enabledRuntimes: readonly string[];
  readonly nightWindow: NightWindow;
}

/** Defaults of the optional keys, as written in `config.json`. */
export const CONFIG_DEFAULTS = {
  maxRunsPerNight: 5,
  quotaCooldownMinutes: 300,
  workspaceRetentionDays: 14,
  enabledRuntimes: ['claude-code'],
  nightWindow: '22:00-06:00',
} as const;

export const CONFIG_KEYS = [
  'rosterRepo',
  'workspaceRoot',
  'maxRunsPerNight',
  'quotaCooldownMinutes',
  'workspaceRetentionDays',
  'commitAuthor',
  'enabledRuntimes',
  'nightWindow',
] as const;

const PATH_RULE: StringRule = { maxLength: 1024, nonEmpty: true };
// Git rejects `<`, `>` and line breaks in an identity.
const AUTHOR_NAME_RULE: StringRule = { maxLength: 100, nonEmpty: true, pattern: /^[^<>\r\n]+$/ };
const AUTHOR_EMAIL_RULE: StringRule = { maxLength: 254, nonEmpty: true, pattern: /^[^\s<>@]+@[^\s<>@]+$/ };
const RUNTIME_RULE: StringRule = { maxLength: 64, nonEmpty: true, pattern: SLUG_PATTERN };
const MAX_RUNTIMES = 16;

const NIGHT_WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** An unknown key is named in the problem, cleaned and cut, with any token-shaped text redacted. */
function safeKey(key: string): string {
  return inlineText(key, 64);
}

/** `$.commitAuthor.email` with message `is required` becomes `commitAuthor.email is required`. */
function describeIssue(issue: ValidationIssue): string {
  return `${issue.path.replace(/^\$\.?/, '')} ${issue.message}`;
}

/**
 * Accepts an absolute Windows path (`C:\x`, `\\server\share`) or a rooted path (`/x`). Uses the
 * win32 rules on every platform so the result does not depend on the machine running the tests.
 */
function requiredAbsolutePath(
  issues: IssueCollector,
  object: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = issues.requiredString(object, key, '$', PATH_RULE);
  if (value === undefined) return undefined;
  if (!win32.isAbsolute(value)) {
    issues.add(childPath('$', key), 'pattern', 'must be an absolute path');
    return undefined;
  }
  return value;
}

function readCommitAuthor(issues: IssueCollector, object: Readonly<Record<string, unknown>>): CommitAuthor | undefined {
  const path = childPath('$', 'commitAuthor');
  if (!issues.has(object, 'commitAuthor')) {
    issues.add(path, 'required', 'is required');
    return undefined;
  }
  const author = issues.object(object['commitAuthor'], path);
  if (author === undefined) return undefined;
  const name = issues.requiredString(author, 'name', path, AUTHOR_NAME_RULE);
  const email = issues.requiredString(author, 'email', path, AUTHOR_EMAIL_RULE);
  for (const key of Object.keys(author)) {
    if (key !== 'name' && key !== 'email') issues.add(childPath(path, safeKey(key)), 'enum', 'is not a known key');
  }
  return name === undefined || email === undefined ? undefined : { name, email };
}

function readEnabledRuntimes(
  issues: IssueCollector,
  object: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  const items = issues.array(object, 'enabledRuntimes', '$', { required: false, maxItems: MAX_RUNTIMES });
  if (items === undefined) {
    return issues.has(object, 'enabledRuntimes') ? undefined : CONFIG_DEFAULTS.enabledRuntimes;
  }
  const path = childPath('$', 'enabledRuntimes');
  if (items.length === 0) {
    issues.add(path, 'empty', 'must list at least one runtime');
    return undefined;
  }
  const runtimes: string[] = [];
  let valid = true;
  items.forEach((item, index) => {
    const runtime = issues.checkString(item, indexPath(path, index), RUNTIME_RULE);
    if (runtime === undefined) {
      valid = false;
    } else if (runtimes.includes(runtime)) {
      issues.add(indexPath(path, index), 'duplicate', 'repeats an earlier runtime');
      valid = false;
    } else {
      runtimes.push(runtime);
    }
  });
  return valid ? runtimes : undefined;
}

/** Parses `HH:MM-HH:MM` (24-hour local time); start and end must differ. */
export function parseNightWindow(text: string): NightWindow | undefined {
  const match = NIGHT_WINDOW_PATTERN.exec(text);
  if (match === null) return undefined;
  const [, startHour, startMinute, endHour, endMinute] = match.map(Number) as [number, number, number, number, number];
  if (startHour === endHour && startMinute === endMinute) return undefined;
  return { start: { hour: startHour, minute: startMinute }, end: { hour: endHour, minute: endMinute } };
}

function readNightWindow(issues: IssueCollector, object: Readonly<Record<string, unknown>>): NightWindow | undefined {
  const text = issues.optionalString(object, 'nightWindow', '$', { maxLength: 11, nonEmpty: true });
  if (text === undefined) {
    return issues.has(object, 'nightWindow') ? undefined : parseNightWindow(CONFIG_DEFAULTS.nightWindow);
  }
  const window = parseNightWindow(text);
  if (window === undefined) {
    issues.add(childPath('$', 'nightWindow'), 'pattern', 'must be HH:MM-HH:MM with different start and end');
  }
  return window;
}

function readPositiveInteger(
  issues: IssueCollector,
  object: Readonly<Record<string, unknown>>,
  key: 'maxRunsPerNight' | 'quotaCooldownMinutes' | 'workspaceRetentionDays',
): number | undefined {
  const value = issues.optionalPositiveInteger(object, key, '$');
  if (value !== undefined) return value;
  return issues.has(object, key) ? undefined : CONFIG_DEFAULTS[key];
}

/** Validates a parsed `config.json` value; throws ConfigError listing every problem. */
export function validateConfig(value: unknown): RosterConfig {
  if (!isRecord(value)) throw new ConfigError(['config must be a JSON object']);
  const issues = new IssueCollector();

  const rosterRepo = requiredAbsolutePath(issues, value, 'rosterRepo');
  const workspaceRoot = requiredAbsolutePath(issues, value, 'workspaceRoot');
  const maxRunsPerNight = readPositiveInteger(issues, value, 'maxRunsPerNight');
  const quotaCooldownMinutes = readPositiveInteger(issues, value, 'quotaCooldownMinutes');
  const workspaceRetentionDays = readPositiveInteger(issues, value, 'workspaceRetentionDays');
  const commitAuthor = readCommitAuthor(issues, value);
  const enabledRuntimes = readEnabledRuntimes(issues, value);
  const nightWindow = readNightWindow(issues, value);

  for (const key of Object.keys(value)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      issues.add(childPath('$', safeKey(key)), 'enum', 'is not a known key');
    }
  }

  const result = issues.result(() => ({
    rosterRepo: rosterRepo!,
    workspaceRoot: workspaceRoot!,
    maxRunsPerNight: maxRunsPerNight!,
    quotaCooldownMinutes: quotaCooldownMinutes!,
    workspaceRetentionDays: workspaceRetentionDays!,
    commitAuthor: commitAuthor!,
    enabledRuntimes: enabledRuntimes!,
    nightWindow: nightWindow!,
  }));
  if (!result.ok) throw new ConfigError(result.errors.map(describeIssue));
  return result.value;
}

/** Parses the text of `config.json`. A leading byte order mark (Windows editors) is ignored. */
export function parseConfig(text: string): RosterConfig {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new ConfigError(['config is not valid JSON']);
  }
  return validateConfig(value);
}

/** Reads and validates the config file at `path`; throws ConfigError on any problem. */
export function loadConfig(path: string): RosterConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'unknown error';
    throw new ConfigError([
      code === 'ENOENT' ? `config file not found: ${path}` : `config file cannot be read (${code}): ${path}`,
    ]);
  }
  return parseConfig(text);
}

/** `%LOCALAPPDATA%\Roster\config.json`. */
export function defaultConfigPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const localAppData = env['LOCALAPPDATA'];
  if (localAppData === undefined || localAppData.trim() === '') {
    throw new ConfigError(['LOCALAPPDATA is not set, so the config path is unknown']);
  }
  return win32.join(localAppData, 'Roster', 'config.json');
}

/** Root of the running Roster install: in production the pinned install (ADR 0025). */
export function defaultInstallRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/**
 * `human_language` of `specs/constitution.md` under the install root. An unreadable file, a missing
 * setting or an unsupported language gives `en`.
 */
export function loadHumanLanguage(installRoot: string = defaultInstallRoot()): Language {
  let text: string;
  try {
    text = readFileSync(join(installRoot, 'specs', 'constitution.md'), 'utf8');
  } catch {
    return DEFAULT_LANGUAGE;
  }
  return parseHumanLanguage(text);
}
