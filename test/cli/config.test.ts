import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_DEFAULTS,
  defaultConfigPath,
  defaultInstallRoot,
  loadConfig,
  loadHumanLanguage,
  parseConfig,
  parseNightWindow,
  validateConfig,
} from '../../src/cli/config.ts';
import type { RosterConfig } from '../../src/cli/config.ts';
import { ConfigError } from '../../src/core/domain/errors.ts';

const MINIMAL = {
  rosterRepo: 'C:\\Users\\me\\src\\roster',
  workspaceRoot: 'C:\\Users\\me\\AppData\\Local\\Roster\\workspaces',
  commitAuthor: { name: 'Roster', email: 'roster@example.invalid' },
};

/** The problems of a config value, or [] when it is valid. */
function problemsOf(value: unknown): readonly string[] {
  try {
    validateConfig(value);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

describe('validateConfig', () => {
  it('applies every default to a minimal config', () => {
    const expected: RosterConfig = {
      rosterRepo: MINIMAL.rosterRepo,
      workspaceRoot: MINIMAL.workspaceRoot,
      maxRunsPerNight: 5,
      quotaCooldownMinutes: 300,
      workspaceRetentionDays: 14,
      commitAuthor: { name: 'Roster', email: 'roster@example.invalid' },
      enabledRuntimes: ['claude-code'],
      nightWindow: { start: { hour: 22, minute: 0 }, end: { hour: 6, minute: 0 } },
    };
    expect(validateConfig(MINIMAL)).toEqual(expected);
  });

  it('documents the defaults', () => {
    expect(CONFIG_DEFAULTS).toEqual({
      maxRunsPerNight: 5,
      quotaCooldownMinutes: 300,
      workspaceRetentionDays: 14,
      enabledRuntimes: ['claude-code'],
      nightWindow: '22:00-06:00',
    });
  });

  it('treats null optional values as absent', () => {
    expect(validateConfig({ ...MINIMAL, maxRunsPerNight: null, nightWindow: null }).maxRunsPerNight).toBe(5);
  });

  it('reads explicit values', () => {
    const config = validateConfig({
      rosterRepo: '/home/me/roster',
      workspaceRoot: '\\\\server\\share\\workspaces',
      maxRunsPerNight: 3,
      quotaCooldownMinutes: 60,
      workspaceRetentionDays: 7,
      commitAuthor: { name: 'Roster Bot', email: 'bot@example.invalid' },
      enabledRuntimes: ['claude-code', 'other-runtime'],
      nightWindow: '21:30-05:45',
    });
    expect(config).toEqual({
      rosterRepo: '/home/me/roster',
      workspaceRoot: '\\\\server\\share\\workspaces',
      maxRunsPerNight: 3,
      quotaCooldownMinutes: 60,
      workspaceRetentionDays: 7,
      commitAuthor: { name: 'Roster Bot', email: 'bot@example.invalid' },
      enabledRuntimes: ['claude-code', 'other-runtime'],
      nightWindow: { start: { hour: 21, minute: 30 }, end: { hour: 5, minute: 45 } },
    });
  });

  it.each([
    ['rosterRepo missing', { rosterRepo: undefined }, ['rosterRepo is required']],
    ['rosterRepo empty', { rosterRepo: '  ' }, ['rosterRepo must not be empty']],
    ['rosterRepo relative', { rosterRepo: 'src\\roster' }, ['rosterRepo must be an absolute path']],
    ['rosterRepo not a string', { rosterRepo: 42 }, ['rosterRepo must be a string']],
    ['workspaceRoot missing', { workspaceRoot: undefined }, ['workspaceRoot is required']],
    ['workspaceRoot drive-relative', { workspaceRoot: 'C:workspaces' }, ['workspaceRoot must be an absolute path']],
    ['maxRunsPerNight zero', { maxRunsPerNight: 0 }, ['maxRunsPerNight must be at least 1']],
    ['maxRunsPerNight fraction', { maxRunsPerNight: 2.5 }, ['maxRunsPerNight must be an integer']],
    ['maxRunsPerNight string', { maxRunsPerNight: '5' }, ['maxRunsPerNight must be an integer']],
    ['quotaCooldownMinutes negative', { quotaCooldownMinutes: -1 }, ['quotaCooldownMinutes must be at least 1']],
    ['workspaceRetentionDays zero', { workspaceRetentionDays: 0 }, ['workspaceRetentionDays must be at least 1']],
    ['commitAuthor missing', { commitAuthor: undefined }, ['commitAuthor is required']],
    ['commitAuthor not an object', { commitAuthor: 'Roster <r@x.y>' }, ['commitAuthor must be an object']],
    ['commitAuthor empty', { commitAuthor: {} }, ['commitAuthor.name is required', 'commitAuthor.email is required']],
    [
      'commitAuthor bad values',
      { commitAuthor: { name: 'A <b>', email: 'not-an-email' } },
      ['commitAuthor.name must match /^[^<>\\r\\n]+$/', 'commitAuthor.email must match /^[^\\s<>@]+@[^\\s<>@]+$/'],
    ],
    [
      'commitAuthor unknown key',
      { commitAuthor: { name: 'R', email: 'r@x.y', signingKey: 'k' } },
      ['commitAuthor.signingKey is not a known key'],
    ],
    ['enabledRuntimes not an array', { enabledRuntimes: 'claude-code' }, ['enabledRuntimes must be an array']],
    ['enabledRuntimes empty', { enabledRuntimes: [] }, ['enabledRuntimes must list at least one runtime']],
    [
      'enabledRuntimes bad items',
      { enabledRuntimes: ['Claude Code', 7, 'claude-code', 'claude-code'] },
      [
        'enabledRuntimes[0] must match /^[a-z0-9-]+$/',
        'enabledRuntimes[1] must be a string',
        'enabledRuntimes[3] repeats an earlier runtime',
      ],
    ],
    ['nightWindow not a string', { nightWindow: { start: '22:00' } }, ['nightWindow must be a string']],
    ['nightWindow bad format', { nightWindow: '22-06' }, ['nightWindow must be HH:MM-HH:MM with different start and end']],
    ['nightWindow hour 24', { nightWindow: '24:00-06:00' }, ['nightWindow must be HH:MM-HH:MM with different start and end']],
    ['nightWindow empty span', { nightWindow: '22:00-22:00' }, ['nightWindow must be HH:MM-HH:MM with different start and end']],
    ['unknown key', { maxRunPerNight: 4 }, ['maxRunPerNight is not a known key']],
  ])('%s', (_name, change, expected) => {
    const value: Record<string, unknown> = { ...MINIMAL, ...change };
    for (const [key, v] of Object.entries(value)) if (v === undefined) delete value[key];
    expect(problemsOf(value)).toEqual(expected);
  });

  it('lists every invalid or missing key at once', () => {
    const problems = problemsOf({
      rosterRepo: 'relative',
      maxRunsPerNight: 0,
      quotaCooldownMinutes: 'soon',
      workspaceRetentionDays: 1.5,
      commitAuthor: { name: 'R' },
      enabledRuntimes: [],
      nightWindow: '10pm-6am',
      extra: true,
    });
    expect(problems).toEqual([
      'rosterRepo must be an absolute path',
      'workspaceRoot is required',
      'maxRunsPerNight must be at least 1',
      'quotaCooldownMinutes must be an integer',
      'workspaceRetentionDays must be an integer',
      'commitAuthor.email is required',
      'enabledRuntimes must list at least one runtime',
      'nightWindow must be HH:MM-HH:MM with different start and end',
      'extra is not a known key',
    ]);
  });

  it('the error message names every problem', () => {
    expect(() => validateConfig({})).toThrow(
      'Invalid config: rosterRepo is required; workspaceRoot is required; commitAuthor is required',
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'config'],
  ])('rejects %s as the whole config', (_name, value) => {
    expect(problemsOf(value)).toEqual(['config must be a JSON object']);
  });

  it('never echoes a value in a problem', () => {
    const fake = 'sk-ant-oat01-FAKE-test-token-0000000000';
    const problems = problemsOf({ ...MINIMAL, rosterRepo: fake, maxRunsPerNight: fake, [fake]: 1 });
    expect(problems.filter((problem) => problem.includes(fake))).toEqual([]);
    expect(problems).toContain('[redacted] is not a known key');
  });
});

describe('parseNightWindow', () => {
  it.each([
    ['22:00-06:00', { start: { hour: 22, minute: 0 }, end: { hour: 6, minute: 0 } }],
    ['00:00-23:59', { start: { hour: 0, minute: 0 }, end: { hour: 23, minute: 59 } }],
    ['9:00-10:00', undefined],
    ['22:60-06:00', undefined],
    ['22:00 - 06:00', undefined],
    ['06:00-06:00', undefined],
    ['', undefined],
  ])('%s', (text, expected) => {
    expect(parseNightWindow(text)).toEqual(expected);
  });
});

describe('parseConfig', () => {
  it('ignores a leading byte order mark', () => {
    expect(parseConfig(`\uFEFF${JSON.stringify(MINIMAL)}`).rosterRepo).toBe(MINIMAL.rosterRepo);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseConfig('{ rosterRepo: ')).toThrow(new ConfigError(['config is not valid JSON']));
  });
});

describe('files', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'roster-config-test-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadConfig reads and validates a file', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ ...MINIMAL, maxRunsPerNight: 2 }), 'utf8');
    expect(loadConfig(path).maxRunsPerNight).toBe(2);
  });

  it('loadConfig reports invalid content', () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ rosterRepo: 'x' }), 'utf8');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('loadConfig reports a missing file with its path', () => {
    const path = join(dir, 'missing.json');
    try {
      loadConfig(path);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([`config file not found: ${path}`]);
    }
  });

  it('loadConfig reports a directory as unreadable', () => {
    expect(() => loadConfig(dir)).toThrow(/config file cannot be read \(E[A-Z]+\)/);
  });

  it.each([
    ['es', '# Project constitution\n\n## Settings\n\n- `human_language`: `es` (Spanish).\n'],
    ['en', '- `human_language`: `de` (German).\n'],
    ['en', '# No settings\n'],
  ])('loadHumanLanguage gives %s', (expected, text) => {
    const root = mkdtempSync(join(dir, 'install-'));
    mkdirSync(join(root, 'specs'));
    writeFileSync(join(root, 'specs', 'constitution.md'), text, 'utf8');
    expect(loadHumanLanguage(root)).toBe(expected);
  });

  it('loadHumanLanguage falls back to en without a constitution', () => {
    expect(loadHumanLanguage(join(dir, 'no-install'))).toBe('en');
  });

  it('the install root is the repo root, whose constitution says es', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    expect(defaultInstallRoot()).toBe(repoRoot);
    expect(loadHumanLanguage()).toBe('es');
  });
});

describe('defaultConfigPath', () => {
  it('is under LOCALAPPDATA\\Roster', () => {
    expect(defaultConfigPath({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toBe(
      'C:\\Users\\me\\AppData\\Local\\Roster\\config.json',
    );
  });

  it.each([[{}], [{ LOCALAPPDATA: '' }]])('fails without LOCALAPPDATA', (env) => {
    expect(() => defaultConfigPath(env)).toThrow(ConfigError);
  });
});
