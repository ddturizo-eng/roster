// Hand-written validators for the result contracts of ADR 0026.
//
// - Input is untrusted. Validators never throw; they return the typed value or every issue found,
//   each with a JSON path (`$.questions[0].text`), a stable code and an English message.
// - Free-text fields are length-limited (RESULT_LIMITS); over-long text is an issue, never truncated.
// - Required text fields must not be empty, except `verification`, which may be empty.
// - Optional fields may be absent or null. Keys outside the contract are ignored and dropped: the
//   returned value holds only contract fields.

import { SLUG_PATTERN } from './ids.ts';
import type { ContractName } from './agent.ts';
import {
  ANALYST_STATUSES,
  ARCHITECT_STATUSES,
  FINDING_SEVERITIES,
  RESULT_LIMITS,
  REVIEW_VERDICTS,
  SPECIALIST_STATUSES,
} from './results.ts';
import type {
  AnalystQuestion,
  AnalystResult,
  ArchitectResult,
  HrResult,
  ResultByContract,
  ResultQuestion,
  ReviewFinding,
  ReviewerResult,
  SpecialistResult,
} from './results.ts';
import { IssueCollector, childPath, indexPath } from './validation.ts';
import type { Validation } from './validation.ts';

const ROOT = '$';

type Json = Readonly<Record<string, unknown>>;

/** Reads `questions: [{ text }]`; required and non-empty when `required` is true. */
function readQuestions(c: IssueCollector, object: Json, required: boolean, when: string): ResultQuestion[] | undefined {
  const path = childPath(ROOT, 'questions');
  const items = c.array(object, 'questions', ROOT, { required: false, maxItems: RESULT_LIMITS.questions });
  if (items === undefined) {
    if (required && !c.has(object, 'questions')) c.add(path, 'required', `is required when ${when}`);
    return undefined;
  }
  if (required && items.length === 0) c.add(path, 'empty', `must not be empty when ${when}`);
  const questions: ResultQuestion[] = [];
  items.forEach((item, index) => {
    const itemPath = indexPath(path, index);
    const question = c.object(item, itemPath);
    if (question === undefined) return;
    const text = c.requiredString(question, 'text', itemPath, { maxLength: RESULT_LIMITS.questionText, nonEmpty: true });
    if (text !== undefined) questions.push({ text });
  });
  return questions;
}

export function validateSpecialistResult(input: unknown): Validation<SpecialistResult> {
  const c = new IssueCollector();
  const object = c.object(input, ROOT);
  if (object === undefined) return c.fail();
  const status = c.requiredEnum(object, 'status', ROOT, SPECIALIST_STATUSES);
  const summary = c.requiredString(object, 'summary', ROOT, { maxLength: RESULT_LIMITS.summary, nonEmpty: true });
  const verification = c.requiredString(object, 'verification', ROOT, {
    maxLength: RESULT_LIMITS.verification,
    nonEmpty: false,
  });
  const questions = readQuestions(c, object, status === 'blocked', 'status is blocked');
  const notes = c.optionalString(object, 'notes', ROOT, { maxLength: RESULT_LIMITS.notes, nonEmpty: false });
  return c.result(() => ({
    status: status!,
    summary: summary!,
    verification: verification!,
    ...(questions === undefined ? {} : { questions }),
    ...(notes === undefined ? {} : { notes }),
  }));
}

export function validateHrResult(input: unknown): Validation<HrResult> {
  const c = new IssueCollector();
  const object = c.object(input, ROOT);
  if (object === undefined) return c.fail();
  const slug = c.requiredString(object, 'slug', ROOT, {
    maxLength: RESULT_LIMITS.slug,
    nonEmpty: true,
    pattern: SLUG_PATTERN,
  });
  const skillItems = c.array(object, 'skills', ROOT, { required: true, maxItems: RESULT_LIMITS.skills });
  const skills: string[] = [];
  skillItems?.forEach((item, index) => {
    const skill = c.checkString(item, indexPath(childPath(ROOT, 'skills'), index), {
      maxLength: RESULT_LIMITS.skillName,
      nonEmpty: true,
    });
    if (skill !== undefined) skills.push(skill);
  });
  const reason = c.requiredString(object, 'reason', ROOT, { maxLength: RESULT_LIMITS.reason, nonEmpty: true });
  const needsHuman = c.requiredBoolean(object, 'needsHuman', ROOT);
  return c.result(() => ({ slug: slug!, skills, reason: reason!, needsHuman: needsHuman! }));
}

export function validateAnalystResult(input: unknown): Validation<AnalystResult> {
  const c = new IssueCollector();
  const object = c.object(input, ROOT);
  if (object === undefined) return c.fail();
  const status = c.requiredEnum(object, 'status', ROOT, ANALYST_STATUSES);
  const path = childPath(ROOT, 'questions');
  const required = status === 'questions';
  const items = c.array(object, 'questions', ROOT, { required: false, maxItems: RESULT_LIMITS.questions });
  let questions: AnalystQuestion[] | undefined;
  if (items === undefined) {
    if (required && !c.has(object, 'questions')) c.add(path, 'required', 'is required when status is questions');
  } else {
    if (required && items.length === 0) c.add(path, 'empty', 'must not be empty when status is questions');
    questions = [];
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const itemPath = indexPath(path, index);
      const question = c.object(item, itemPath);
      if (question === undefined) return;
      const id = c.requiredString(question, 'id', itemPath, { maxLength: RESULT_LIMITS.questionId, nonEmpty: true });
      const text = c.requiredString(question, 'text', itemPath, { maxLength: RESULT_LIMITS.questionText, nonEmpty: true });
      const textEn = c.requiredString(question, 'textEn', itemPath, {
        maxLength: RESULT_LIMITS.questionText,
        nonEmpty: true,
      });
      if (id !== undefined && seen.has(id)) c.add(childPath(itemPath, 'id'), 'duplicate', 'must be unique');
      if (id !== undefined) seen.add(id);
      if (id !== undefined && text !== undefined && textEn !== undefined) questions?.push({ id, text, textEn });
    });
  }
  const summary = c.optionalString(object, 'summary', ROOT, { maxLength: RESULT_LIMITS.summary, nonEmpty: false });
  return c.result(() => ({
    status: status!,
    ...(questions === undefined ? {} : { questions }),
    ...(summary === undefined ? {} : { summary }),
  }));
}

export function validateArchitectResult(input: unknown): Validation<ArchitectResult> {
  const c = new IssueCollector();
  const object = c.object(input, ROOT);
  if (object === undefined) return c.fail();
  const status = c.requiredEnum(object, 'status', ROOT, ARCHITECT_STATUSES);
  const summary = c.requiredString(object, 'summary', ROOT, { maxLength: RESULT_LIMITS.summary, nonEmpty: true });
  const adrItems = c.array(object, 'adrs', ROOT, { required: true, maxItems: RESULT_LIMITS.adrs });
  const adrs: string[] = [];
  adrItems?.forEach((item, index) => {
    const adr = c.checkString(item, indexPath(childPath(ROOT, 'adrs'), index), {
      maxLength: RESULT_LIMITS.adrPath,
      nonEmpty: true,
    });
    if (adr !== undefined) adrs.push(adr);
  });
  const questions = readQuestions(c, object, status === 'blocked', 'status is blocked');
  return c.result(() => ({
    status: status!,
    summary: summary!,
    adrs,
    ...(questions === undefined ? {} : { questions }),
  }));
}

export function validateReviewerResult(input: unknown): Validation<ReviewerResult> {
  const c = new IssueCollector();
  const object = c.object(input, ROOT);
  if (object === undefined) return c.fail();
  const verdict = c.requiredEnum(object, 'verdict', ROOT, REVIEW_VERDICTS);
  const summary = c.requiredString(object, 'summary', ROOT, { maxLength: RESULT_LIMITS.summary, nonEmpty: true });
  const path = childPath(ROOT, 'findings');
  const items = c.array(object, 'findings', ROOT, { required: true, maxItems: RESULT_LIMITS.findings });
  const findings: ReviewFinding[] = [];
  items?.forEach((item, index) => {
    const itemPath = indexPath(path, index);
    const finding = c.object(item, itemPath);
    if (finding === undefined) return;
    const severity = c.requiredEnum(finding, 'severity', itemPath, FINDING_SEVERITIES);
    const findingPath = c.optionalString(finding, 'path', itemPath, {
      maxLength: RESULT_LIMITS.findingPath,
      nonEmpty: true,
    });
    const line = c.optionalPositiveInteger(finding, 'line', itemPath);
    const text = c.requiredString(finding, 'text', itemPath, { maxLength: RESULT_LIMITS.findingText, nonEmpty: true });
    if (severity === undefined || text === undefined) return;
    findings.push({
      severity,
      ...(findingPath === undefined ? {} : { path: findingPath }),
      ...(line === undefined ? {} : { line }),
      text,
    });
  });
  return c.result(() => ({ verdict: verdict!, summary: summary!, findings }));
}

type Validators = { readonly [C in ContractName]: (input: unknown) => Validation<ResultByContract[C]> };

const VALIDATORS: Validators = {
  specialist: validateSpecialistResult,
  hr: validateHrResult,
  analyst: validateAnalystResult,
  architect: validateArchitectResult,
  reviewer: validateReviewerResult,
};

/** Validates an already parsed result against the contract named by the agent definition. */
export function validateResult<C extends ContractName>(contract: C, input: unknown): Validation<ResultByContract[C]> {
  const validator: (input: unknown) => Validation<ResultByContract[C]> = VALIDATORS[contract];
  return validator(input);
}

/** Parses the text of `result.json` and validates it. Never echoes the text in an issue. */
export function parseResult<C extends ContractName>(contract: C, text: string): Validation<ResultByContract[C]> {
  if (text.length > RESULT_LIMITS.fileLength) {
    return {
      ok: false,
      errors: [{ path: ROOT, code: 'too_long', message: `must be at most ${RESULT_LIMITS.fileLength} characters` }],
    };
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ path: ROOT, code: 'invalid_json', message: 'is not valid JSON' }] };
  }
  return validateResult(contract, input);
}
