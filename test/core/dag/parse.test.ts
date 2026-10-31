import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TasksMdError } from '../../../src/core/dag/errors.ts';
import { formatTasksMdIssue } from '../../../src/core/dag/issue.ts';
import { parseTasksMd, parseTasksMdStrict } from '../../../src/core/dag/parse.ts';
import { RosterError } from '../../../src/core/domain/errors.ts';
import { file, taskText, toCrlf } from './helpers.ts';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/tasks/${name}`, import.meta.url)), 'utf8');

// The real tasks.md of plan 002 is read from its own path, not copied: a copy goes stale when the
// architect amends the plan, while reading it keeps proving that the file Roster will import
// parses. If a plan PR changes the number of tasks, update EXPECTED_REAL_TASKS in the same PR.
const REAL_TASKS_MD = fileURLToPath(new URL('../../../specs/002-local-core/tasks.md', import.meta.url));
const EXPECTED_REAL_TASKS = 44;

describe('parseTasksMd: format of ADR 0019', () => {
  const result = parseTasksMd(fixture('valid.md'));

  it('has no errors', () => {
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('finds the tasks in file order, ignoring phase headings and fenced headings', () => {
    expect(result.tasks.map((t) => [t.key, t.ord])).toEqual([
      ['T01', 0],
      ['T02', 1],
      ['T103', 2],
    ]);
  });

  it('reads every field', () => {
    const [t01, t02, t103] = result.tasks;
    expect(t01).toMatchObject({
      title: 'Scaffold the package',
      done: true,
      dependsOn: [],
      needsHuman: null,
      agent: 'roster-core-ts-engineer',
      profile: 'TS core',
      areas: ['package.json', 'src/'],
      acceptanceCriteria: ['`package.json` exists.', 'Continued on a second line that is indented deeper.'],
      verification: '`npm test` passes.',
    });
    expect(t02).toMatchObject({
      done: false,
      dependsOn: ['T01'],
      needsHuman: 'needs a real token',
      agent: null,
      profile: null,
      areas: [],
      verification: 'unit tests, and a review.',
    });
    expect(t103?.dependsOn).toEqual(['T01', 'T02']);
  });

  it('records lines', () => {
    const lines = fixture('valid.md').split(/\r?\n/);
    for (const task of result.tasks) {
      expect(lines[task.line - 1]).toMatch(new RegExp(`^## ${task.key}\\. `));
      expect(lines[task.dependsOnLine - 1]).toMatch(/^- Depends on:/);
    }
  });

  it('keeps the full text in bodyMd, from heading to the end of the task, without trailing blanks', () => {
    const [, t02, t103] = result.tasks;
    expect(t02?.bodyMd.startsWith('## T02. Domain types\n\n- [ ] Done\n')).toBe(true);
    expect(t02?.bodyMd.endsWith('  and a review.')).toBe(true);
    expect(t02?.bodyMd).not.toContain('Phase B');
    expect(t02?.bodyMd).toContain('- Colour: blue');
    // A level-3 heading does not end a task.
    expect(t103?.bodyMd.endsWith('### Notes inside the task\n\nA level-3 heading does not end a task.')).toBe(true);
  });

  it('warns about unknown keys and does not fail', () => {
    expect(result.warnings.map((w) => [w.code, w.taskId, w.message])).toEqual([
      ['unknown_key', 'T02', 'unknown field "Colour" ignored'],
    ]);
    expect(result.warnings[0]?.line).toBe(
      fixture('valid.md')
        .split(/\r?\n/)
        .findIndex((l) => l === '- Colour: blue') + 1,
    );
  });
});

describe('parseTasksMd: line endings', () => {
  const lf = fixture('valid.md').replace(/\r\n/g, '\n');

  it('gives the same result for LF, CRLF, lone CR and a BOM', () => {
    const expected = parseTasksMd(lf);
    expect(parseTasksMd(toCrlf(lf))).toEqual(expected);
    expect(parseTasksMd(lf.replace(/\n/g, '\r'))).toEqual(expected);
    expect(parseTasksMd(`﻿${toCrlf(lf)}`)).toEqual(expected);
  });

  it('never leaves a carriage return in bodyMd or fields', () => {
    for (const task of parseTasksMd(toCrlf(lf)).tasks) {
      expect(JSON.stringify(task)).not.toContain('\\r');
    }
  });
});

describe('parseTasksMd: field edge cases', () => {
  it('accepts a checked box in upper case', () => {
    expect(parseTasksMd(file(taskText('T01', { done: '- [X] Done' }))).tasks[0]?.done).toBe(true);
  });

  it('accepts any order of fields', () => {
    const text = file(
      [
        '## T01. Reordered',
        '',
        '- Verification: v',
        '- Acceptance criteria:',
        '  - c',
        '- Depends on: none',
        '- [x] Done',
        '',
      ].join('\n'),
    );
    const result = parseTasksMd(text);
    expect(result.errors).toEqual([]);
    expect(result.tasks[0]).toMatchObject({ done: true, verification: 'v', acceptanceCriteria: ['c'] });
  });

  it('accepts a tab as the nested indent and ignores empty nested items', () => {
    const text = file(taskText('T01', { criteria: '- Acceptance criteria:\n\t- tab item\n  -\n  - second' }));
    expect(parseTasksMd(text).tasks[0]?.acceptanceCriteria).toEqual(['tab item', 'second']);
  });

  it('drops a trailing parenthetical note from Depends on', () => {
    const text = file(
      taskText('T01', { depends: 'none (runs first)' }),
      taskText('T02', { depends: 'T01 (needs the scaffold)' }),
    );
    const result = parseTasksMd(text);
    expect(result.errors).toEqual([]);
    expect(result.tasks.map((t) => t.dependsOn)).toEqual([[], ['T01']]);
  });

  it('warns about a repeated dependency and keeps one edge', () => {
    const result = parseTasksMd(file(taskText('T01'), taskText('T02', { depends: 'T01, T01' })));
    expect(result.errors).toEqual([]);
    expect(result.tasks[1]?.dependsOn).toEqual(['T01']);
    expect(result.warnings.map((w) => w.code)).toEqual(['duplicate_dependency']);
  });

  it('ignores list items that are not "- Key: value" with a warning', () => {
    const result = parseTasksMd(file(taskText('T01', { extra: ['- just a note'] })));
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['unrecognized_line']);
  });

  it('warns about an unknown checkbox item', () => {
    const result = parseTasksMd(file(taskText('T01', { extra: ['- [ ] Reviewed'] })));
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => [w.code, w.message])).toEqual([
      ['unknown_key', 'unknown field "[ ] Reviewed" ignored'],
    ]);
  });

  it('ignores field-like lines inside code fences', () => {
    const text = file(taskText('T01', { extra: ['', '```', '- Depends on: T77', '## T55. fake', '```'] }));
    const result = parseTasksMd(text);
    expect(result.errors).toEqual([]);
    expect(result.tasks.map((t) => t.key)).toEqual(['T01']);
    expect(result.tasks[0]?.dependsOn).toEqual([]);
  });

  it('parses a file with no tasks as empty and valid', () => {
    expect(parseTasksMd('# Only a preamble\n')).toMatchObject({ ok: true, tasks: [], errors: [] });
    expect(parseTasksMd('')).toMatchObject({ ok: true, tasks: [] });
  });

  it('clips and sanitizes text echoed from the file in warnings', () => {
    const key = `K${'x'.repeat(100)}\u001b[31m`;
    const result = parseTasksMd(file(taskText('T01', { extra: [`- ${key}: v`] })));
    const message = result.warnings[0]?.message ?? '';
    expect(message.length).toBeLessThan(80);
    expect(message).not.toContain('\u001b');
  });
});

describe('parseTasksMd: errors name the line and the task id', () => {
  // Lines are 1-based. `file()` has a 4-line preamble, so the first heading is line 5. `taskText`
  // puts Done on 7, Depends on on 8, Acceptance criteria on 9 (item on 10) and Verification on 11,
  // or one line later when Needs human or Agent is present. The second task heading is line 13.
  const cases: readonly {
    readonly name: string;
    readonly text: string;
    readonly code: string;
    readonly taskId: string;
    readonly line: number;
    readonly contains: string;
  }[] = [
    {
      name: 'duplicate id',
      text: file(taskText('T01'), taskText('T01')),
      code: 'duplicate_id',
      taskId: 'T01',
      line: 13,
      contains: 'already used at line 5',
    },
    {
      name: 'missing Done',
      text: file(taskText('T01', { omit: ['Done'] })),
      code: 'missing_field',
      taskId: 'T01',
      line: 5,
      contains: '"Done"',
    },
    {
      name: 'missing Depends on',
      text: file(taskText('T01', { omit: ['Depends on'] })),
      code: 'missing_field',
      taskId: 'T01',
      line: 5,
      contains: '"Depends on"',
    },
    {
      name: 'missing Acceptance criteria',
      text: file(taskText('T01', { omit: ['Acceptance criteria'] })),
      code: 'missing_field',
      taskId: 'T01',
      line: 5,
      contains: '"Acceptance criteria"',
    },
    {
      name: 'missing Verification',
      text: file(taskText('T01', { omit: ['Verification'] })),
      code: 'missing_field',
      taskId: 'T01',
      line: 5,
      contains: '"Verification"',
    },
    {
      name: 'empty Verification',
      text: file(taskText('T01', { verification: '' })),
      code: 'missing_field',
      taskId: 'T01',
      line: 11,
      contains: '"Verification"',
    },
    {
      name: 'empty Depends on',
      text: file(taskText('T01', { depends: '' })),
      code: 'missing_field',
      taskId: 'T01',
      line: 8,
      contains: '"Depends on"',
    },
    {
      name: 'empty acceptance criteria (no nested items)',
      text: file(taskText('T01', { criteria: '- Acceptance criteria:' })),
      code: 'empty_acceptance_criteria',
      taskId: 'T01',
      line: 9,
      contains: 'at least one',
    },
    {
      name: 'empty acceptance criteria (only blank items)',
      text: file(taskText('T01', { criteria: '- Acceptance criteria:\n  -\n  - ' })),
      code: 'empty_acceptance_criteria',
      taskId: 'T01',
      line: 9,
      contains: 'at least one',
    },
    {
      name: 'criteria written inline are not nested items',
      text: file(taskText('T01', { criteria: '- Acceptance criteria: it works' })),
      code: 'empty_acceptance_criteria',
      taskId: 'T01',
      line: 9,
      contains: 'nested item',
    },
    {
      name: 'unknown dependency',
      text: file(taskText('T01'), taskText('T02', { depends: 'T01, T09' })),
      code: 'unknown_dependency',
      taskId: 'T02',
      line: 16,
      contains: 'T02 depends on T09',
    },
    {
      name: 'self dependency',
      text: file(taskText('T01', { depends: 'T01' })),
      code: 'self_dependency',
      taskId: 'T01',
      line: 8,
      contains: 'depends on itself',
    },
    {
      name: 'dependency that is not a task id',
      text: file(taskText('T01', { depends: 'T01x' })),
      code: 'invalid_value',
      taskId: 'T01',
      line: 8,
      contains: 'comma-separated task ids',
    },
    {
      name: 'none mixed with ids',
      text: file(taskText('T01'), taskText('T02', { depends: 'none, T01' })),
      code: 'invalid_value',
      taskId: 'T02',
      line: 16,
      contains: '"none"',
    },
    {
      name: 'capitalized None',
      text: file(taskText('T01', { depends: 'None' })),
      code: 'invalid_value',
      taskId: 'T01',
      line: 8,
      contains: '"none"',
    },
    {
      name: 'Needs human without a reason',
      text: file(taskText('T01', { needsHuman: '' })),
      code: 'invalid_value',
      taskId: 'T01',
      line: 9,
      contains: 'reason',
    },
    {
      name: 'Agent that is not a slug',
      text: file(taskText('T01', { agent: 'Core Engineer' })),
      code: 'invalid_value',
      taskId: 'T01',
      line: 9,
      contains: 'slug',
    },
    {
      name: 'repeated field',
      text: file(taskText('T01', { extra: ['- Verification: again'] })),
      code: 'duplicate_field',
      taskId: 'T01',
      line: 12,
      contains: '"Verification" appears more than once',
    },
    {
      name: 'repeated Done',
      text: file(taskText('T01', { extra: ['- [x] Done'] })),
      code: 'duplicate_field',
      taskId: 'T01',
      line: 12,
      contains: '"Done"',
    },
    {
      name: 'task heading with a one-digit id',
      text: file('## T1. Short id\n\n- [ ] Done\n'),
      code: 'invalid_heading',
      taskId: 'T1',
      line: 5,
      contains: '## T<nn>. <title>',
    },
    {
      name: 'task heading without a title',
      text: file('## T01.\n\n- [ ] Done\n'),
      code: 'invalid_heading',
      taskId: 'T01',
      line: 5,
      contains: 'non-empty title',
    },
    {
      name: 'task heading without the dot',
      text: file('## T01 Title\n'),
      code: 'invalid_heading',
      taskId: 'T01',
      line: 5,
      contains: 'task heading must be',
    },
  ];

  it.each(cases)('$name', ({ text, code, taskId, line, contains }) => {
    const result = parseTasksMd(text);
    expect(result.ok).toBe(false);
    const issue = result.errors.find((e) => e.code === code);
    expect(issue, JSON.stringify(result.errors)).toBeDefined();
    if (issue === undefined) {
      return;
    }
    expect(issue.taskId).toBe(taskId);
    expect(issue.line).toBe(line);
    expect(issue.message).toContain(contains);
    expect(formatTasksMdIssue(issue)).toBe(`line ${line}, ${taskId}: ${issue.message}`);
  });

  it('reports every missing field of a task, not only the first', () => {
    const text = file('## T01. Bare\n');
    expect(parseTasksMd(text).errors.map((e) => e.message)).toEqual([
      'missing required field "Done"',
      'missing required field "Depends on"',
      'missing required field "Acceptance criteria"',
      'missing required field "Verification"',
    ]);
  });

  it('sorts errors by line', () => {
    const text = file(taskText('T01', { omit: ['Verification'] }), taskText('T01', { depends: 'T09' }));
    const lines = parseTasksMd(text).errors.map((e) => e.line);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('keeps best-effort tasks so later checks do not cascade', () => {
    const text = file(taskText('T01', { omit: ['Verification'] }), taskText('T02', { depends: 'T01' }));
    const result = parseTasksMd(text);
    expect(result.errors.map((e) => e.code)).toEqual(['missing_field']);
    expect(result.tasks.map((t) => t.key)).toEqual(['T01', 'T02']);
  });

  it('formats an issue without a task id', () => {
    expect(formatTasksMdIssue({ line: 3, taskId: null, code: 'invalid_heading', message: 'm' })).toBe('line 3: m');
  });
});

describe('parseTasksMd: dependency cycles', () => {
  it('rejects the three-node fixture and names the cycle in order', () => {
    const result = parseTasksMd(fixture('cycle.md'));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    const [issue] = result.errors;
    expect(issue?.code).toBe('dependency_cycle');
    expect(issue?.message).toContain('T03 -> T07 -> T05 -> T03');
    expect(issue?.taskId).toBe('T03');
    const lines = fixture('cycle.md').split(/\r?\n/);
    expect(lines[(issue?.line ?? 0) - 1]).toBe('- Depends on: T01, T07');
  });

  it('names the same cycle for CRLF text', () => {
    expect(parseTasksMd(toCrlf(fixture('cycle.md'))).errors[0]?.message).toContain('T03 -> T07 -> T05 -> T03');
  });

  const cases: readonly { readonly name: string; readonly deps: Readonly<Record<string, string>>; readonly cycle: string }[] = [
    { name: 'two nodes', deps: { T01: 'T02', T02: 'T01' }, cycle: 'T01 -> T02 -> T01' },
    {
      name: 'starts at the first task of the ring in file order',
      deps: { T01: 'none', T02: 'T04', T03: 'T02', T04: 'T03' },
      cycle: 'T02 -> T04 -> T03 -> T02',
    },
    {
      name: 'a ring reached from outside',
      deps: { T01: 'T02', T02: 'T03', T03: 'T04', T04: 'T03' },
      cycle: 'T03 -> T04 -> T03',
    },
    {
      name: 'a ring behind a diamond',
      deps: { T01: 'none', T02: 'T01', T03: 'T01, T02', T04: 'T03, T05', T05: 'T04' },
      cycle: 'T04 -> T05 -> T04',
    },
  ];

  it.each(cases)('$name', ({ deps, cycle }) => {
    const text = file(...Object.entries(deps).map(([key, depends]) => taskText(key, { depends })));
    const result = parseTasksMd(text);
    expect(result.errors.map((e) => e.code)).toEqual(['dependency_cycle']);
    expect(result.errors[0]?.message).toContain(cycle);
  });

  it('accepts a diamond (no cycle)', () => {
    const text = file(
      taskText('T01'),
      taskText('T02', { depends: 'T01' }),
      taskText('T03', { depends: 'T01' }),
      taskText('T04', { depends: 'T02, T03' }),
    );
    expect(parseTasksMd(text).errors).toEqual([]);
  });

  it('accepts a dependency on a task that appears later in the file', () => {
    expect(parseTasksMd(file(taskText('T01', { depends: 'T02' }), taskText('T02'))).errors).toEqual([]);
  });

  it('reports self and unknown dependencies as their own errors, not as cycles', () => {
    const result = parseTasksMd(file(taskText('T01', { depends: 'T01, T09' })));
    expect(result.errors.map((e) => e.code).sort()).toEqual(['self_dependency', 'unknown_dependency']);
  });
});

describe('parseTasksMdStrict', () => {
  it('returns tasks and warnings for a valid file', () => {
    const result = parseTasksMdStrict(fixture('valid.md'));
    expect(result.tasks).toHaveLength(3);
    expect(result.warnings).toHaveLength(1);
  });

  it('throws a typed error listing the issues for an invalid one', () => {
    let thrown: unknown;
    try {
      parseTasksMdStrict(fixture('cycle.md'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TasksMdError);
    expect(thrown).toBeInstanceOf(RosterError);
    const error = thrown as TasksMdError;
    expect(error.name).toBe('TasksMdError');
    expect(error.message).toContain('T03 -> T07 -> T05 -> T03');
    expect(error.issues).toHaveLength(1);
  });

  it('limits the message to five issues', () => {
    const text = file(...Array.from({ length: 7 }, (_, i) => taskText(`T0${i + 1}`, { depends: 'T99' })));
    let thrown: unknown;
    try {
      parseTasksMdStrict(text);
    } catch (error) {
      thrown = error;
    }
    const error = thrown as TasksMdError;
    expect(error.issues).toHaveLength(7);
    expect(error.message).toContain('and 2 more');
  });
});

describe('the real tasks.md of plan 002', () => {
  const raw = readFileSync(REAL_TASKS_MD, 'utf8');

  it.each([
    ['as checked out', raw],
    ['with LF endings', raw.replace(/\r\n/g, '\n')],
    ['with CRLF endings', toCrlf(raw)],
  ])('parses with no errors and no warnings (%s)', (_name, text) => {
    const result = parseTasksMd(text);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.tasks).toHaveLength(EXPECTED_REAL_TASKS);
  });

  it('gives the same tasks whatever the line endings', () => {
    expect(parseTasksMd(toCrlf(raw))).toEqual(parseTasksMd(raw.replace(/\r\n/g, '\n')));
  });

  it('reads known facts of the file', () => {
    const { tasks } = parseTasksMd(raw);
    const byKey = new Map(tasks.map((t) => [t.key, t] as const));
    expect(byKey.get('T14')?.dependsOn).toEqual([]);
    expect(byKey.get('T14')?.needsHuman).toMatch(/Docker Desktop/);
    expect(byKey.get('T04')).toMatchObject({
      title: '`tasks.md` parser and task DAG',
      dependsOn: ['T02'],
      agent: 'roster-core-ts-engineer',
      profile: 'TS core',
      areas: ['src/core/dag/', 'test/fixtures/tasks/'],
    });
    expect(byKey.get('T04')?.acceptanceCriteria).toHaveLength(6);
    expect(tasks.filter((t) => t.needsHuman !== null)).toHaveLength(6);
    // File order is the selection order: T14 was moved to the front (ADR 0019).
    expect(tasks.slice(0, 2).map((t) => t.key)).toEqual(['T14', 'T01']);
  });
});
