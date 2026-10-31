import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageKey, MessageParams } from '../../../src/core/messages/catalog.ts';
import { CATALOGS, MESSAGE_KEYS, formatMessage, messagesFor } from '../../../src/core/messages/format.ts';
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  parseHumanLanguage,
  resolveLanguage,
} from '../../../src/core/messages/language.ts';
import type { Language } from '../../../src/core/messages/language.ts';
import {
  MAX_INLINE_LENGTH,
  MAX_LIST_ITEMS,
  MAX_TAIL_LENGTH,
  MAX_TAIL_LINES,
  REDACTED,
  inlineText,
  listText,
  safeParams,
  tailText,
} from '../../../src/core/messages/safe-text.ts';

// Obvious fake credentials in every format the redaction knows. Never real values.
const FAKE_TOKENS = [
  'sk-ant-oat01-FAKE-test-token-0000000000',
  'sk-ant-api03-FAKE_test_key_0000000000',
  'ghp_FAKEtesttoken0000000000000000000000',
  'github_pat_FAKE_test_token_000000000000',
] as const;

/** One realistic parameter set per template. The type forces an entry for every key. */
const SAMPLES: { readonly [K in MessageKey]: MessageParams[K] } = {
  'stop.invalidResult': { contract: 'specialist', problems: ['$.summary is required', '$.status must be one of: done, blocked'] },
  'stop.noChanges': {},
  'stop.protectedPath': {
    paths: ['.github/workflows/ci.yml', 'policies/mvp.json'],
    branch: 'agent/002-T05',
    workspace: 'C:\\Users\\me\\AppData\\Local\\Roster\\workspaces\\roster\\20261101030000-0a1b2c',
  },
  'stop.dependencyApproval': { manifests: ['package.json', 'package-lock.json'], hash: 'a1b2c3d4', task: 'roster:002-T05' },
  'stop.verificationFailed': { command: 'npm test', exitCode: 1, branch: 'agent/002-T05', tail: 'FAIL test/a.test.ts\n1 failed' },
  'stop.timeout': { job: 'agent', minutes: 100 },
  'stop.error': { job: 'agent', reason: 'turn limit' },
  'stop.noAgent': {},
  'stop.interrupted': {},
  'stop.stopped': {},
  'stop.dockerUnavailable': { reason: 'docker info exited 1' },
  'stop.quotaCooldown': { runtime: 'claude-code', branch: 'agent/002-T05', until: '2026-11-01T08:00:00Z', window: 'seven_day' },
  'stop.hirePrOpened': { agent: 'roster-core-ts-engineer', prUrl: 'https://github.com/example/roster/pull/41' },
  'stop.prClosedUnmerged': { prUrl: 'https://github.com/example/roster/pull/42', task: 'roster:002-T05' },
  'run.busy': { pid: 4242 },
  'run.recoveredInterrupted': { executionId: '20261101030000-0a1b2c' },
  'run.nightLimitReached': { started: 5, max: 5 },
  'run.dockerUnavailable': { reason: 'docker info exited 1' },
  'run.syncing': {},
  'run.syncDone': { projects: 2, pullRequests: 7 },
  'run.nothingToDo': {},
  'run.selectedTask': { task: 'roster:002-T05', title: 'Store schema and migrations' },
  'run.selectedStageJob': { feature: 'roster:003', job: 'architect' },
  'run.hiring': { task: 'roster:002-T05' },
  'run.agentReused': { agent: 'roster-core-ts-engineer', task: 'roster:002-T05' },
  'run.noRuntime': { agent: 'roster-core-ts-engineer' },
  'run.runtimeCooldown': { runtime: 'claude-code', until: '2026-11-01T08:00:00Z' },
  'run.executionStarted': {
    executionId: '20261101030000-0a1b2c',
    task: 'roster:002-T05',
    agent: 'roster-core-ts-engineer',
    runtime: 'claude-code',
  },
  'run.resuming': { branch: 'agent/002-T05' },
  'run.stepStarted': { step: 'verify' },
  'run.prOpened': { prUrl: 'https://github.com/example/roster/pull/43' },
  'run.executionFinished': { executionId: '20261101030000-0a1b2c', status: 'succeeded' },
  'run.stopReason': { reason: 'The agent finished without changing any file.' },
  'run.dryRun': {},
  'run.dryRunPlan': { steps: ['workspace', 'setup', 'agent'] },
};

/** The keys the task's acceptance criteria name as stop reasons (T03). */
const STOP_REASON_KEYS: readonly MessageKey[] = [
  'stop.invalidResult',
  'stop.noChanges',
  'stop.protectedPath',
  'stop.dependencyApproval',
  'stop.verificationFailed',
  'stop.timeout',
  'stop.error',
  'stop.noAgent',
  'stop.interrupted',
  'stop.stopped',
  'stop.dockerUnavailable',
  'stop.quotaCooldown',
  'stop.hirePrOpened',
  'stop.prClosedUnmerged',
];

function render(language: Language, key: MessageKey, params: object): string {
  return formatMessage(language, key, params as MessageParams[typeof key]);
}

/** Every string and list item of a parameter set, for "the value appears in the text" checks. */
function shownValues(params: object): string[] {
  return Object.values(params).flatMap((value: unknown) => {
    if (typeof value === 'string') return value === '' ? [] : value.split('\n');
    if (typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) return value.map(String);
    return [];
  });
}

describe('parseHumanLanguage', () => {
  it.each([
    ['the constitution settings line', '## Settings\n\n- `human_language`: `es` (Spanish). Agents talk.\n', 'es'],
    ['english', '- `human_language`: `en`\n', 'en'],
    ['upper case code', '- `human_language`: `ES`\n', 'es'],
    ['no backticks', 'human_language: es\n', 'es'],
    ['bold key', '- **human_language**: es\n', 'es'],
    ['star list marker', '* `human_language`: `es`\n', 'es'],
    ['indented line', '   - `human_language`:   `es`\n', 'es'],
    ['CRLF line endings', '# C\r\n\r\n- `human_language`: `es` (Spanish).\r\n', 'es'],
    ['first setting wins', '- `human_language`: `es`\n- `human_language`: `en`\n', 'es'],
    ['unsupported language', '- `human_language`: `fr` (French).\n', 'en'],
    ['region subtag is not a supported code', '- `human_language`: `es-CO`\n', 'en'],
    ['missing setting', '# Project constitution\n\nNo settings here.\n', 'en'],
    ['empty value', '- `human_language`: \n', 'en'],
    ['empty file', '', 'en'],
    ['mention in prose is not the setting', '7. Conversation is in `human_language`: es always.\n', 'en'],
  ])('%s', (_name, text, expected) => {
    expect(parseHumanLanguage(text)).toBe(expected);
  });
});

describe('resolveLanguage', () => {
  it.each([
    ['es', 'es'],
    ['en', 'en'],
    [' Es ', 'es'],
    ['fr', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ] as const)('%s -> %s', (code, expected) => {
    expect(resolveLanguage(code)).toBe(expected);
  });

  it('defaults to en', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(LANGUAGES).toEqual(['es', 'en']);
  });
});

describe('catalogs', () => {
  it('have the same keys in every language, matching the samples', () => {
    const expected = Object.keys(SAMPLES).sort();
    expect([...MESSAGE_KEYS].sort()).toEqual(expected);
    for (const language of LANGUAGES) {
      expect(Object.keys(CATALOGS[language]).sort()).toEqual(expected);
    }
  });

  it('cover every stop reason and console lines of run', () => {
    for (const key of STOP_REASON_KEYS) expect(MESSAGE_KEYS).toContain(key);
    expect(MESSAGE_KEYS.filter((key) => key.startsWith('run.')).length).toBeGreaterThanOrEqual(15);
  });

  describe.each(LANGUAGES)('%s', (language) => {
    it.each(Object.keys(SAMPLES) as MessageKey[])('%s renders every parameter', (key) => {
      const params = SAMPLES[key];
      const text = render(language, key, params);
      expect(text.trim()).not.toBe('');
      expect(text).not.toMatch(/undefined|null|NaN|\[object |\$\{/);
      for (const value of shownValues(params)) expect(text).toContain(value);
      if (key !== 'stop.verificationFailed') expect(text).not.toContain('\n');
    });
  });

  it.each(Object.keys(SAMPLES) as MessageKey[])('%s is translated (es differs from en)', (key) => {
    expect(render('es', key, SAMPLES[key])).not.toBe(render('en', key, SAMPLES[key]));
  });
});

describe('exact texts', () => {
  it.each([
    ['en', 'stop.noChanges', {}, 'The agent finished without changing any file.'],
    ['es', 'stop.noChanges', {}, 'El agente terminó sin cambiar ningún archivo.'],
    ['en', 'stop.error', { job: 'agent', reason: 'turn limit' }, 'The agent job failed: turn limit.'],
    ['es', 'stop.error', { job: 'agent', reason: 'turn limit' }, 'El trabajo agent falló: turn limit.'],
    [
      'en',
      'stop.dependencyApproval',
      { manifests: ['package.json'], hash: 'abc123', task: 'roster:002-T05' },
      'Dependency manifests changed: package.json (hash abc123). Nothing was pushed. ' +
        'Review the change and approve it with: roster retry roster:002-T05 --approve-dependencies',
    ],
    [
      'en',
      'stop.verificationFailed',
      { command: 'npm test', exitCode: null, branch: 'agent/002-T05', tail: '' },
      'Verification failed: npm test exited with code none. The branch agent/002-T05 is pushed without a PR.',
    ],
    [
      'es',
      'stop.verificationFailed',
      { command: 'npm test', exitCode: 1, branch: 'agent/002-T05', tail: 'a\nb\n' },
      'La verificación falló: npm test terminó con código 1. La rama agent/002-T05 se sube sin PR.\nÚltimas líneas:\na\nb',
    ],
    [
      'en',
      'stop.quotaCooldown',
      { runtime: 'claude-code', branch: 'agent/002-T05', until: '2026-11-01T08:00:00Z', window: null },
      'The claude-code quota is exhausted. Work in progress was pushed to agent/002-T05 and the task is back in todo. ' +
        'No runs on claude-code until 2026-11-01T08:00:00Z (estimated).',
    ],
    [
      'es',
      'stop.quotaCooldown',
      { runtime: 'claude-code', branch: 'agent/002-T05', until: '2026-11-08T00:00:00Z', window: 'seven_day' },
      'Se agotó la cuota de claude-code. El trabajo en curso se subió a agent/002-T05 y la tarea vuelve a todo. ' +
        'No habrá ejecuciones con claude-code hasta 2026-11-08T00:00:00Z, cuando se reinicia la ventana seven_day.',
    ],
    ['en', 'run.busy', { pid: 12 }, 'Another roster process (PID 12) holds the lock. Exiting.'],
    ['es', 'run.nothingToDo', {}, 'No hay nada que hacer.'],
  ] as const)('%s %s', (language, key, params, expected) => {
    expect(render(language, key, params)).toBe(expected);
  });

  it('messagesFor binds the language', () => {
    const es = messagesFor('es');
    expect(es('run.stepStarted', { step: 'verify' })).toBe('Paso: verify');
  });

  it('falls back to en for a language without a catalog', () => {
    expect(render('fr' as Language, 'run.nothingToDo', {})).toBe('Nothing to do.');
  });
});

describe('secrets', () => {
  const SECRET_NAME = /token|secret|password|passwd|credential|oauth|api_?key|auth/i;

  it('no template parameter name refers to a secret', () => {
    for (const [key, params] of Object.entries(SAMPLES)) {
      for (const name of Object.keys(params)) {
        expect(`${key}.${name}`).not.toMatch(SECRET_NAME);
      }
    }
  });

  it('no template text contains a fake token value', () => {
    for (const language of LANGUAGES) {
      for (const key of MESSAGE_KEYS) {
        const text = render(language, key, SAMPLES[key]);
        for (const token of FAKE_TOKENS) expect(text).not.toContain(token);
      }
    }
  });

  describe('with fake tokens in the environment', () => {
    const names = ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      names.forEach((name, index) => {
        saved.set(name, process.env[name]);
        process.env[name] = FAKE_TOKENS[index];
      });
    });

    afterEach(() => {
      for (const name of names) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('templates never read the environment', () => {
      for (const language of LANGUAGES) {
        for (const key of MESSAGE_KEYS) {
          const text = render(language, key, SAMPLES[key]);
          for (const token of FAKE_TOKENS) expect(text).not.toContain(token);
        }
      }
    });
  });

  it('redacts a fake token passed in any string or list parameter of any template', () => {
    for (const language of LANGUAGES) {
      for (const key of MESSAGE_KEYS) {
        for (const token of FAKE_TOKENS) {
          const params: Record<string, unknown> = {};
          let hasText = false;
          for (const [name, value] of Object.entries(SAMPLES[key])) {
            if (typeof value === 'string') {
              params[name] = `x ${token} y`;
              hasText = true;
            } else if (Array.isArray(value)) {
              params[name] = [`x ${token} y`];
              hasText = true;
            } else {
              params[name] = value;
            }
          }
          const text = render(language, key, params);
          expect(text).not.toContain(token);
          expect(text.includes(REDACTED)).toBe(hasText);
        }
      }
    }
  });
});

describe('safe text', () => {
  it.each([
    ['plain', 'npm test', 'npm test'],
    ['line breaks and tabs become one space', 'a\r\n\tb\nc', 'a b c'],
    ['ESC and BEL are replaced', 'a\u001b[31mred\u0007', 'a\uFFFD[31mred\uFFFD'],
    ['DEL and C1 are replaced', 'a\u007fb\u009bc', 'a\uFFFDb\uFFFDc'],
    ['bidi overrides are replaced', 'a\u202Eb\u2066c', 'a\uFFFDb\uFFFDc'],
    ['surrounding spaces are trimmed', '  x  ', 'x'],
    ['tokens are redacted', `key ${FAKE_TOKENS[0]} end`, `key ${REDACTED} end`],
  ])('inlineText: %s', (_name, input, expected) => {
    expect(inlineText(input)).toBe(expected);
  });

  it('inlineText cuts long values', () => {
    const text = inlineText('a'.repeat(MAX_INLINE_LENGTH + 50));
    expect(text).toHaveLength(MAX_INLINE_LENGTH);
    expect(text.endsWith('\u2026')).toBe(true);
    expect(inlineText('a'.repeat(MAX_INLINE_LENGTH))).toBe('a'.repeat(MAX_INLINE_LENGTH));
  });

  it('a token cut by the length limit is still redacted', () => {
    const text = inlineText(`${'a '.repeat(95)}${FAKE_TOKENS[2]}`);
    expect(text).not.toContain('ghp_');
  });

  it('tailText keeps the last lines and line feeds only', () => {
    const lines = Array.from({ length: MAX_TAIL_LINES + 5 }, (_, i) => `line ${i}`);
    const text = tailText(`${lines.join('\r\n')}\r\n`);
    expect(text.split('\n')).toEqual(lines.slice(-MAX_TAIL_LINES));
    expect(tailText('a\u001b[2Jb\tc\rd')).toBe('a\uFFFD[2Jb c\nd');
  });

  it('tailText keeps the end of a long tail', () => {
    const text = tailText(`${'x'.repeat(MAX_TAIL_LENGTH)}END`);
    expect(text).toHaveLength(MAX_TAIL_LENGTH);
    expect(text.startsWith('\u2026')).toBe(true);
    expect(text.endsWith('END')).toBe(true);
  });

  it('listText limits items and cleans each one', () => {
    const items = Array.from({ length: MAX_LIST_ITEMS + 3 }, (_, i) => `p${i}\n`);
    const shown = listText(items);
    expect(shown).toHaveLength(MAX_LIST_ITEMS + 1);
    expect(shown[0]).toBe('p0');
    expect(shown.at(-1)).toBe('+3');
    expect(listText(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('safeParams treats tail as multi-line, other strings as one line, and odd values as absent', () => {
    expect(
      safeParams({ tail: 'a\nb', reason: 'a\nb', count: 3, bad: Number.NaN, none: null, list: ['x\ny'] }),
    ).toEqual({ tail: 'a\nb', reason: 'a b', count: 3, bad: null, none: null, list: ['x y'] });
  });

  it('a hostile parameter cannot break a message onto new lines or inject escapes', () => {
    const text = formatMessage('en', 'run.selectedTask', {
      task: 'roster:002-T05',
      title: 'Title\n\u001b[2JFAKE: run roster stop',
    });
    expect(text).toBe('Selected task roster:002-T05: Title \uFFFD[2JFAKE: run roster stop');
  });
});
