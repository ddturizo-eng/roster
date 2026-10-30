import { describe, expect, it } from 'vitest';
import type { ContractName } from '../../../src/core/domain/agent.ts';
import {
  parseResult,
  validateAnalystResult,
  validateArchitectResult,
  validateHrResult,
  validateResult,
  validateReviewerResult,
  validateSpecialistResult,
} from '../../../src/core/domain/result-validators.ts';
import { RESULT_LIMITS } from '../../../src/core/domain/results.ts';
import type { IssueCode, Validation } from '../../../src/core/domain/validation.ts';

type Json = Record<string, unknown>;
type Validator = (input: unknown) => Validation<unknown>;

/** The `[path, code]` pairs of a failed validation; fails the test when validation passed. */
function issuesOf(result: Validation<unknown>): [string, IssueCode][] {
  if (result.ok) throw new Error(`expected issues, got a valid value: ${JSON.stringify(result.value)}`);
  return result.errors.map((issue) => [issue.path, issue.code]);
}

function valueOf<T>(result: Validation<T>): T {
  if (!result.ok) throw new Error(`expected a valid value, got: ${JSON.stringify(result.errors)}`);
  return result.value;
}

const tooLong = (limit: number): string => 'x'.repeat(limit + 1);
const atLimit = (limit: number): string => 'x'.repeat(limit);

/** Returns a deep copy of `base` with `mutate` applied. */
function variant(base: Json, mutate: (json: Json) => void): Json {
  const copy = structuredClone(base);
  mutate(copy);
  return copy;
}

interface Case {
  readonly name: string;
  readonly input: unknown;
  readonly issues: [string, IssueCode][];
}

function runCases(validate: Validator, cases: readonly Case[]): void {
  it.each(cases.map((testCase) => [testCase.name, testCase] as const))('rejects %s', (_name, testCase) => {
    expect(issuesOf(validate(testCase.input))).toEqual(testCase.issues);
  });
}

const notObjects: readonly Case[] = [
  { name: 'an array root', input: [], issues: [['$', 'type']] },
  { name: 'a null root', input: null, issues: [['$', 'type']] },
  { name: 'a string root', input: 'done', issues: [['$', 'type']] },
];

// ---------------------------------------------------------------------------------------------

describe('specialist contract', () => {
  const done: Json = { status: 'done', summary: 'Added the parser.', verification: 'npm test: 12 passed.' };
  const blocked: Json = {
    status: 'blocked',
    summary: 'The task names two formats.',
    verification: '',
    questions: [{ text: '¿Qué formato debe usar el parser?' }],
  };

  it('accepts a done result and a blocked result with questions', () => {
    expect(valueOf(validateSpecialistResult(done))).toEqual(done);
    expect(valueOf(validateSpecialistResult(blocked))).toEqual(blocked);
  });

  it('keeps notes and questions on a done result', () => {
    const input = { ...done, notes: 'Found a typo in plan.md.', questions: [{ text: 'Optional follow-up?' }] };
    expect(valueOf(validateSpecialistResult(input))).toEqual(input);
  });

  it('accepts text exactly at each length limit', () => {
    const input = {
      status: 'blocked',
      summary: atLimit(RESULT_LIMITS.summary),
      verification: atLimit(RESULT_LIMITS.verification),
      notes: atLimit(RESULT_LIMITS.notes),
      questions: [{ text: atLimit(RESULT_LIMITS.questionText) }],
    };
    expect(valueOf(validateSpecialistResult(input))).toEqual(input);
  });

  it('drops keys outside the contract and treats null optional fields as absent', () => {
    const input = { ...done, notes: null, questions: null, extra: 'ignored', status_override: 'x' };
    expect(valueOf(validateSpecialistResult(input))).toEqual(done);
  });

  it('reports every issue at once', () => {
    expect(issuesOf(validateSpecialistResult({ status: 'finished', notes: 3 }))).toEqual([
      ['$.status', 'enum'],
      ['$.summary', 'required'],
      ['$.verification', 'required'],
      ['$.notes', 'type'],
    ]);
  });

  runCases(validateSpecialistResult, [
    ...notObjects,
    { name: 'missing status', input: variant(done, (j) => delete j['status']), issues: [['$.status', 'required']] },
    { name: 'missing summary', input: variant(done, (j) => delete j['summary']), issues: [['$.summary', 'required']] },
    {
      name: 'missing verification',
      input: variant(done, (j) => delete j['verification']),
      issues: [['$.verification', 'required']],
    },
    {
      name: 'blocked without questions',
      input: variant(blocked, (j) => delete j['questions']),
      issues: [['$.questions', 'required']],
    },
    {
      name: 'blocked with an empty questions list',
      input: variant(blocked, (j) => (j['questions'] = [])),
      issues: [['$.questions', 'empty']],
    },
    {
      name: 'a question without text',
      input: variant(blocked, (j) => (j['questions'] = [{ text: 'ok' }, {}])),
      issues: [['$.questions[1].text', 'required']],
    },
    {
      name: 'a question that is not an object',
      input: variant(blocked, (j) => (j['questions'] = ['¿Qué formato?'])),
      issues: [['$.questions[0]', 'type']],
    },
    { name: 'a wrong status value', input: variant(done, (j) => (j['status'] = 'Done')), issues: [['$.status', 'enum']] },
    { name: 'a non-string status', input: variant(done, (j) => (j['status'] = true)), issues: [['$.status', 'enum']] },
    { name: 'an empty summary', input: variant(done, (j) => (j['summary'] = '  ')), issues: [['$.summary', 'empty']] },
    { name: 'a non-string summary', input: variant(done, (j) => (j['summary'] = 42)), issues: [['$.summary', 'type']] },
    {
      name: 'questions that are not an array',
      input: variant(blocked, (j) => (j['questions'] = { text: 'x' })),
      issues: [['$.questions', 'type']],
    },
    {
      name: 'too many questions',
      input: variant(blocked, (j) => (j['questions'] = Array.from({ length: RESULT_LIMITS.questions + 1 }, () => ({ text: 'q' })))),
      issues: [['$.questions', 'too_many']],
    },
    {
      name: 'an over-long summary',
      input: variant(done, (j) => (j['summary'] = tooLong(RESULT_LIMITS.summary))),
      issues: [['$.summary', 'too_long']],
    },
    {
      name: 'an over-long verification',
      input: variant(done, (j) => (j['verification'] = tooLong(RESULT_LIMITS.verification))),
      issues: [['$.verification', 'too_long']],
    },
    {
      name: 'over-long notes',
      input: variant(done, (j) => (j['notes'] = tooLong(RESULT_LIMITS.notes))),
      issues: [['$.notes', 'too_long']],
    },
    {
      name: 'an over-long question',
      input: variant(blocked, (j) => (j['questions'] = [{ text: tooLong(RESULT_LIMITS.questionText) }])),
      issues: [['$.questions[0].text', 'too_long']],
    },
  ]);
});

// ---------------------------------------------------------------------------------------------

describe('hr contract', () => {
  const valid: Json = {
    slug: 'roster-core-ts-engineer',
    skills: ['better-ui'],
    reason: 'An existing agent covers the TS core profile.',
    needsHuman: false,
  };

  it('accepts a valid result, with or without skills', () => {
    expect(valueOf(validateHrResult(valid))).toEqual(valid);
    expect(valueOf(validateHrResult({ ...valid, skills: [] }))).toEqual({ ...valid, skills: [] });
  });

  it('accepts text exactly at each length limit', () => {
    const input = {
      ...valid,
      slug: 'a'.repeat(RESULT_LIMITS.slug),
      skills: Array.from({ length: RESULT_LIMITS.skills }, () => atLimit(RESULT_LIMITS.skillName)),
      reason: atLimit(RESULT_LIMITS.reason),
    };
    expect(valueOf(validateHrResult(input))).toEqual(input);
  });

  runCases(validateHrResult, [
    ...notObjects,
    { name: 'missing slug', input: variant(valid, (j) => delete j['slug']), issues: [['$.slug', 'required']] },
    { name: 'missing skills', input: variant(valid, (j) => delete j['skills']), issues: [['$.skills', 'required']] },
    { name: 'missing reason', input: variant(valid, (j) => delete j['reason']), issues: [['$.reason', 'required']] },
    {
      name: 'missing needsHuman',
      input: variant(valid, (j) => delete j['needsHuman']),
      issues: [['$.needsHuman', 'required']],
    },
    {
      name: 'a slug outside the slug pattern',
      input: variant(valid, (j) => (j['slug'] = '../agents/Evil')),
      issues: [['$.slug', 'pattern']],
    },
    {
      name: 'a non-boolean needsHuman',
      input: variant(valid, (j) => (j['needsHuman'] = 'false')),
      issues: [['$.needsHuman', 'type']],
    },
    {
      name: 'a non-string skill',
      input: variant(valid, (j) => (j['skills'] = ['ok', 7])),
      issues: [['$.skills[1]', 'type']],
    },
    { name: 'an empty skill', input: variant(valid, (j) => (j['skills'] = [''])), issues: [['$.skills[0]', 'empty']] },
    {
      name: 'too many skills',
      input: variant(valid, (j) => (j['skills'] = Array.from({ length: RESULT_LIMITS.skills + 1 }, () => 's'))),
      issues: [['$.skills', 'too_many']],
    },
    {
      name: 'an over-long slug',
      input: variant(valid, (j) => (j['slug'] = 'a'.repeat(RESULT_LIMITS.slug + 1))),
      issues: [['$.slug', 'too_long']],
    },
    {
      name: 'an over-long skill name',
      input: variant(valid, (j) => (j['skills'] = [tooLong(RESULT_LIMITS.skillName)])),
      issues: [['$.skills[0]', 'too_long']],
    },
    {
      name: 'an over-long reason',
      input: variant(valid, (j) => (j['reason'] = tooLong(RESULT_LIMITS.reason))),
      issues: [['$.reason', 'too_long']],
    },
  ]);
});

// ---------------------------------------------------------------------------------------------

describe('analyst contract', () => {
  const questions: Json = {
    status: 'questions',
    questions: [
      { id: 'q1', text: '¿Quién usa la app?', textEn: 'Who uses the app?' },
      { id: 'q2', text: '¿Necesita login?', textEn: 'Does it need a login?' },
    ],
  };
  const done: Json = { status: 'done', summary: 'Spec drafted in specs/003-x/spec.md.' };

  it('accepts a questions result and a done result', () => {
    expect(valueOf(validateAnalystResult(questions))).toEqual(questions);
    expect(valueOf(validateAnalystResult(done))).toEqual(done);
    expect(valueOf(validateAnalystResult({ status: 'done' }))).toEqual({ status: 'done' });
  });

  it('accepts text exactly at each length limit', () => {
    const input = {
      status: 'questions',
      summary: atLimit(RESULT_LIMITS.summary),
      questions: [
        {
          id: atLimit(RESULT_LIMITS.questionId),
          text: atLimit(RESULT_LIMITS.questionText),
          textEn: atLimit(RESULT_LIMITS.questionText),
        },
      ],
    };
    expect(valueOf(validateAnalystResult(input))).toEqual(input);
  });

  runCases(validateAnalystResult, [
    ...notObjects,
    { name: 'missing status', input: variant(done, (j) => delete j['status']), issues: [['$.status', 'required']] },
    {
      name: 'status questions without questions',
      input: { status: 'questions' },
      issues: [['$.questions', 'required']],
    },
    {
      name: 'status questions with an empty list',
      input: { status: 'questions', questions: [] },
      issues: [['$.questions', 'empty']],
    },
    {
      name: 'a question without id',
      input: variant(questions, (j) => delete (j['questions'] as Json[])[0]!['id']),
      issues: [['$.questions[0].id', 'required']],
    },
    {
      name: 'a question without text',
      input: variant(questions, (j) => delete (j['questions'] as Json[])[0]!['text']),
      issues: [['$.questions[0].text', 'required']],
    },
    {
      name: 'a question without textEn',
      input: variant(questions, (j) => delete (j['questions'] as Json[])[1]!['textEn']),
      issues: [['$.questions[1].textEn', 'required']],
    },
    {
      name: 'duplicate question ids',
      input: variant(questions, (j) => ((j['questions'] as Json[])[1]!['id'] = 'q1')),
      issues: [['$.questions[1].id', 'duplicate']],
    },
    { name: 'a wrong status value', input: { status: 'blocked' }, issues: [['$.status', 'enum']] },
    {
      name: 'an over-long question text',
      input: variant(questions, (j) => ((j['questions'] as Json[])[0]!['text'] = tooLong(RESULT_LIMITS.questionText))),
      issues: [['$.questions[0].text', 'too_long']],
    },
    {
      name: 'an over-long question textEn',
      input: variant(questions, (j) => ((j['questions'] as Json[])[0]!['textEn'] = tooLong(RESULT_LIMITS.questionText))),
      issues: [['$.questions[0].textEn', 'too_long']],
    },
    {
      name: 'an over-long question id',
      input: variant(questions, (j) => ((j['questions'] as Json[])[0]!['id'] = tooLong(RESULT_LIMITS.questionId))),
      issues: [['$.questions[0].id', 'too_long']],
    },
    {
      name: 'an over-long summary',
      input: variant(done, (j) => (j['summary'] = tooLong(RESULT_LIMITS.summary))),
      issues: [['$.summary', 'too_long']],
    },
  ]);
});

// ---------------------------------------------------------------------------------------------

describe('architect contract', () => {
  const done: Json = {
    status: 'done',
    summary: 'Plan, tasks and two ADRs written.',
    adrs: ['docs/adr/0031-x.md', 'docs/adr/0032-y.md'],
  };
  const blocked: Json = {
    status: 'blocked',
    summary: 'The spec contradicts ADR 0024.',
    adrs: [],
    questions: [{ text: '¿Se permite instalar dependencias aquí?' }],
  };

  it('accepts a done result and a blocked result with questions', () => {
    expect(valueOf(validateArchitectResult(done))).toEqual(done);
    expect(valueOf(validateArchitectResult(blocked))).toEqual(blocked);
  });

  it('accepts text exactly at each length limit', () => {
    const input = {
      status: 'blocked',
      summary: atLimit(RESULT_LIMITS.summary),
      adrs: Array.from({ length: RESULT_LIMITS.adrs }, () => atLimit(RESULT_LIMITS.adrPath)),
      questions: [{ text: atLimit(RESULT_LIMITS.questionText) }],
    };
    expect(valueOf(validateArchitectResult(input))).toEqual(input);
  });

  runCases(validateArchitectResult, [
    ...notObjects,
    { name: 'missing status', input: variant(done, (j) => delete j['status']), issues: [['$.status', 'required']] },
    { name: 'missing summary', input: variant(done, (j) => delete j['summary']), issues: [['$.summary', 'required']] },
    { name: 'missing adrs', input: variant(done, (j) => delete j['adrs']), issues: [['$.adrs', 'required']] },
    {
      name: 'blocked without questions',
      input: variant(blocked, (j) => delete j['questions']),
      issues: [['$.questions', 'required']],
    },
    { name: 'a wrong status value', input: variant(done, (j) => (j['status'] = 'questions')), issues: [['$.status', 'enum']] },
    { name: 'a non-string adr', input: variant(done, (j) => (j['adrs'] = [1])), issues: [['$.adrs[0]', 'type']] },
    {
      name: 'too many adrs',
      input: variant(done, (j) => (j['adrs'] = Array.from({ length: RESULT_LIMITS.adrs + 1 }, () => 'a.md'))),
      issues: [['$.adrs', 'too_many']],
    },
    {
      name: 'an over-long summary',
      input: variant(done, (j) => (j['summary'] = tooLong(RESULT_LIMITS.summary))),
      issues: [['$.summary', 'too_long']],
    },
    {
      name: 'an over-long adr path',
      input: variant(done, (j) => (j['adrs'] = [tooLong(RESULT_LIMITS.adrPath)])),
      issues: [['$.adrs[0]', 'too_long']],
    },
    {
      name: 'an over-long question',
      input: variant(blocked, (j) => (j['questions'] = [{ text: tooLong(RESULT_LIMITS.questionText) }])),
      issues: [['$.questions[0].text', 'too_long']],
    },
  ]);
});

// ---------------------------------------------------------------------------------------------

describe('reviewer contract', () => {
  const valid: Json = {
    verdict: 'request_changes',
    summary: 'One acceptance criterion is not met.',
    findings: [
      { severity: 'blocker', path: 'src/core/dag/parse.ts', line: 42, text: 'Cycle error does not name the cycle.' },
      { severity: 'info', text: 'Consider a table-driven test.' },
    ],
  };

  it('accepts a valid result and an approval without findings', () => {
    expect(valueOf(validateReviewerResult(valid))).toEqual(valid);
    const approve = { verdict: 'approve', summary: 'Looks good.', findings: [] };
    expect(valueOf(validateReviewerResult(approve))).toEqual(approve);
  });

  it('accepts text exactly at each length limit', () => {
    const input = {
      verdict: 'comment',
      summary: atLimit(RESULT_LIMITS.summary),
      findings: [
        { severity: 'minor', path: atLimit(RESULT_LIMITS.findingPath), line: 1, text: atLimit(RESULT_LIMITS.findingText) },
      ],
    };
    expect(valueOf(validateReviewerResult(input))).toEqual(input);
  });

  const finding = (patch: Json): Json => variant(valid, (j) => (j['findings'] = [{ ...(j['findings'] as Json[])[0], ...patch }]));
  const findingWithout = (key: string): Json =>
    variant(valid, (j) => {
      const first = { ...(j['findings'] as Json[])[0] };
      delete first[key];
      j['findings'] = [first];
    });

  runCases(validateReviewerResult, [
    ...notObjects,
    { name: 'missing verdict', input: variant(valid, (j) => delete j['verdict']), issues: [['$.verdict', 'required']] },
    { name: 'missing summary', input: variant(valid, (j) => delete j['summary']), issues: [['$.summary', 'required']] },
    { name: 'missing findings', input: variant(valid, (j) => delete j['findings']), issues: [['$.findings', 'required']] },
    {
      name: 'a finding without severity',
      input: findingWithout('severity'),
      issues: [['$.findings[0].severity', 'required']],
    },
    { name: 'a finding without text', input: findingWithout('text'), issues: [['$.findings[0].text', 'required']] },
    { name: 'a wrong verdict value', input: variant(valid, (j) => (j['verdict'] = 'reject')), issues: [['$.verdict', 'enum']] },
    {
      name: 'a wrong severity value',
      input: finding({ severity: 'critical' }),
      issues: [['$.findings[0].severity', 'enum']],
    },
    { name: 'a fractional line', input: finding({ line: 1.5 }), issues: [['$.findings[0].line', 'type']] },
    { name: 'a line below 1', input: finding({ line: 0 }), issues: [['$.findings[0].line', 'range']] },
    { name: 'a string line', input: finding({ line: '42' }), issues: [['$.findings[0].line', 'type']] },
    { name: 'an empty path', input: finding({ path: '' }), issues: [['$.findings[0].path', 'empty']] },
    {
      name: 'too many findings',
      input: variant(valid, (j) =>
        (j['findings'] = Array.from({ length: RESULT_LIMITS.findings + 1 }, () => ({ severity: 'info', text: 't' })))),
      issues: [['$.findings', 'too_many']],
    },
    {
      name: 'an over-long summary',
      input: variant(valid, (j) => (j['summary'] = tooLong(RESULT_LIMITS.summary))),
      issues: [['$.summary', 'too_long']],
    },
    {
      name: 'an over-long finding text',
      input: finding({ text: tooLong(RESULT_LIMITS.findingText) }),
      issues: [['$.findings[0].text', 'too_long']],
    },
    {
      name: 'an over-long finding path',
      input: finding({ path: tooLong(RESULT_LIMITS.findingPath) }),
      issues: [['$.findings[0].path', 'too_long']],
    },
  ]);
});

// ---------------------------------------------------------------------------------------------

describe('validateResult and parseResult', () => {
  const samples: Readonly<Record<ContractName, Json>> = {
    specialist: { status: 'done', summary: 's', verification: 'v' },
    hr: { slug: 'a', skills: [], reason: 'r', needsHuman: true },
    analyst: { status: 'done' },
    architect: { status: 'done', summary: 's', adrs: [] },
    reviewer: { verdict: 'approve', summary: 's', findings: [] },
  };

  it.each(Object.entries(samples))('dispatches the %s contract to its validator', (contract, sample) => {
    const name = contract as ContractName;
    expect(valueOf(validateResult(name, sample))).toEqual(sample);
    expect(valueOf(parseResult(name, JSON.stringify(sample)))).toEqual(sample);
  });

  it('rejects a result written for another contract', () => {
    expect(issuesOf(validateResult('reviewer', samples.specialist))).toEqual([
      ['$.verdict', 'required'],
      ['$.findings', 'required'],
    ]);
  });

  it('reports unparsable JSON without echoing the text', () => {
    const text = '{"status": "done", "summary": "fake-secret-value-1234"';
    const result = parseResult('specialist', text);
    expect(issuesOf(result)).toEqual([['$', 'invalid_json']]);
    expect(JSON.stringify(result)).not.toContain('fake-secret-value-1234');
  });

  it('reports an empty file as invalid JSON', () => {
    expect(issuesOf(parseResult('specialist', ''))).toEqual([['$', 'invalid_json']]);
  });

  it('rejects a file over the size limit before parsing it', () => {
    const text = JSON.stringify({ ...samples.specialist, notes: 'x'.repeat(RESULT_LIMITS.fileLength) });
    expect(issuesOf(parseResult('specialist', text))).toEqual([['$', 'too_long']]);
  });

  it('never echoes an offending value in an issue message', () => {
    const marker = 'fake-token-abcdef';
    const result = validateSpecialistResult({ status: marker, summary: { marker }, verification: [marker] });
    expect(issuesOf(result)).toEqual([
      ['$.status', 'enum'],
      ['$.summary', 'type'],
      ['$.verification', 'type'],
    ]);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
