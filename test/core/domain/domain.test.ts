import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CONTRACT_NAMES } from '../../../src/core/domain/agent.ts';
import { APPROVAL_KINDS } from '../../../src/core/domain/approval.ts';
import {
  ConfigError,
  DockerUnavailableError,
  ExternalCommandError,
  InvalidTransitionError,
  NotFoundError,
  PushRejectedError,
  ResultValidationError,
  RosterError,
  SecretMissingError,
} from '../../../src/core/domain/errors.ts';
import { EXECUTION_STEP_NAMES, JOB_KINDS, JOB_PROFILES } from '../../../src/core/domain/execution.ts';
import { STAGES, STAGE_STEPS, isStepOf } from '../../../src/core/domain/feature.ts';
import {
  FEATURE_NUMBER_PATTERN,
  SLUG_PATTERN,
  TASK_KEY_PATTERN,
  featureId,
  isExecutionId,
  taskId,
} from '../../../src/core/domain/ids.ts';
import { RUNTIME_OUTCOME_KINDS } from '../../../src/core/domain/runtime.ts';
import { TASK_STATUSES } from '../../../src/core/domain/task.ts';
import type { ValidationIssue } from '../../../src/core/domain/validation.ts';

describe('ids', () => {
  it.each([
    ['20261101030000-0a1b2c', true],
    ['20261101030000-000001', true],
    ['20261101030000-0A1B2C', false],
    ['2026110103000-0a1b2c', false],
    ['20261101030000-0a1b2', false],
    ['20261101030000_0a1b2c', false],
    ['x20261101030000-0a1b2c', false],
  ])('isExecutionId(%s) is %s', (id, expected) => {
    expect(isExecutionId(id)).toBe(expected);
  });

  it('builds feature and task ids as in plan 002 section 5', () => {
    expect(featureId('roster', '002')).toBe('roster:002');
    expect(taskId('roster', '002', 'T02')).toBe('roster:002-T02');
  });

  it.each([
    [FEATURE_NUMBER_PATTERN, '002', true],
    [FEATURE_NUMBER_PATTERN, '02', false],
    [TASK_KEY_PATTERN, 'T02', true],
    [TASK_KEY_PATTERN, 'T102', true],
    [TASK_KEY_PATTERN, 'T2', false],
    [TASK_KEY_PATTERN, 't02', false],
    [SLUG_PATTERN, 'roster-core-ts-engineer', true],
    [SLUG_PATTERN, 'Roster', false],
    [SLUG_PATTERN, '../x', false],
  ])('%s matches %s: %s', (pattern, value, expected) => {
    expect(pattern.test(value)).toBe(expected);
  });
});

describe('enumerations', () => {
  it('match the ADRs and plan 002', () => {
    expect(STAGES).toEqual(['idea', 'analysis', 'spec_approved', 'plan_approved', 'execution', 'delivered']);
    expect(TASK_STATUSES).toEqual([
      'todo',
      'waiting_hire',
      'running',
      'in_review',
      'done',
      'blocked',
      'failed',
      'stopped',
      'rejected',
      'cancelled',
    ]);
    expect(CAPABILITIES).toEqual(['read', 'edit', 'shell', 'web']);
    expect(CONTRACT_NAMES).toEqual(['specialist', 'hr', 'analyst', 'architect', 'reviewer']);
    expect(JOB_KINDS).toEqual(['specialist', 'analyst', 'architect', 'hr-director', 'reviewer']);
    expect(JOB_PROFILES).toEqual(['agent', 'review', 'setup', 'verify']);
    expect(RUNTIME_OUTCOME_KINDS).toEqual(['completed', 'quota_exhausted', 'timeout', 'error', 'stopped']);
    expect(EXECUTION_STEP_NAMES).toEqual(['workspace', 'setup', 'agent', 'policy', 'commit', 'verify', 'review', 'push', 'pr']);
    expect(APPROVAL_KINDS).toEqual(['dependencies', 'protected_path']);
  });
});

describe('feature steps', () => {
  it('lists the steps of ADR 0020 for every stage', () => {
    expect(Object.keys(STAGE_STEPS)).toEqual([...STAGES]);
    expect(STAGE_STEPS.analysis).toEqual(['questions_pending', 'answers_recorded', 'drafting', 'spec_pr_open']);
  });

  it.each([
    ['idea', 'recorded', true],
    ['spec_approved', 'plan_job_pending', true],
    ['plan_approved', 'import_failed', true],
    ['execution', 'running', true],
    ['execution', 'plan_pr_open', false],
    ['delivered', 'recorded', false],
  ] as const)('isStepOf(%s, %s) is %s', (stage, step, expected) => {
    expect(isStepOf(stage, step)).toBe(expected);
  });
});

describe('typed errors', () => {
  const issues: ValidationIssue[] = [{ path: '$.summary', code: 'required', message: 'is required' }];
  const cases: ReadonlyArray<readonly [string, RosterError]> = [
    ['ResultValidationError', new ResultValidationError('specialist', issues)],
    ['InvalidTransitionError', new InvalidTransitionError('feature', 'idea', 'execution')],
    ['NotFoundError', new NotFoundError('task', 'roster:002-T99')],
    ['SecretMissingError', new SecretMissingError('github-token', 'roster auth set github')],
    ['PushRejectedError', new PushRejectedError('refs/heads/main', 'only refs/heads/agent/* may be pushed')],
    ['ExternalCommandError', new ExternalCommandError('git', 128, 'not a git repository')],
    ['DockerUnavailableError', new DockerUnavailableError('docker info timed out')],
    ['ConfigError', new ConfigError(['workspaceRoot is missing'])],
  ];

  it.each(cases)('%s has a stable name and extends RosterError and Error', (name, error) => {
    expect(error.name).toBe(name);
    expect(error.constructor.name).toBe(name);
    expect(error).toBeInstanceOf(RosterError);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(new RegExp(`^${name}: `));
  });

  it('keeps structured data on the error', () => {
    const validation = new ResultValidationError('specialist', issues);
    expect(validation.contract).toBe('specialist');
    expect(validation.issues).toEqual(issues);
    expect(validation.message).toBe('Invalid specialist result: $.summary is required');
    expect(new InvalidTransitionError('feature', 'idea', 'execution', 'skips analysis').message).toBe(
      'Invalid feature transition from idea to execution: skips analysis',
    );
    const missing = new SecretMissingError('claude-oauth-token', 'roster auth set claude');
    expect(missing.message).toBe('Secret claude-oauth-token is not set. Run: roster auth set claude');
    expect(new ExternalCommandError('docker', null, 'killed').message).toBe('docker failed (exit none): killed');
  });

  it('summarizes at most five validation issues in the message', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ path: `$.adrs[${i}]`, code: 'type' as const, message: 'must be a string' }));
    const error = new ResultValidationError('architect', many);
    expect(error.message).toMatch(/\$\.adrs\[4\] must be a string; and 2 more$/);
    expect(error.issues).toHaveLength(7);
  });
});
