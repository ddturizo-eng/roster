import { describe, expect, it } from 'vitest';
import {
  BranchNameError,
  ROSTER_REPO_BRANCH_RULES,
  assertBranchRules,
  hireBranch,
  isAgentBranch,
  planBranch,
  registrationBranch,
  specBranch,
  taskBranch,
} from '../../../src/core/domain/branches.ts';
import type { BranchRules } from '../../../src/core/domain/branches.ts';

const def: BranchRules = { baseBranch: 'main', branchPrefix: 'agent' };
const feature: BranchRules = { baseBranch: 'develop', branchPrefix: 'feature' };

describe('branch names', () => {
  it.each([
    ['task agent', taskBranch(def, '002', 'T01'), 'agent/002-T01'],
    ['task feature', taskBranch(feature, '002', 'T01'), 'feature/agent-002-T01'],
    ['task three-digit key', taskBranch(feature, '014', 'T100'), 'feature/agent-014-T100'],
    ['spec agent', specBranch(def, '014'), 'agent/014-spec'],
    ['spec feature', specBranch(feature, '014'), 'feature/agent-014-spec'],
    ['plan agent', planBranch(def, '014'), 'agent/014-plan'],
    ['plan feature', planBranch(feature, '014'), 'feature/agent-014-plan'],
    ['hire', hireBranch('analyst'), 'agent/hire-analyst'],
    ['registration', registrationBranch('web'), 'agent/project-web'],
  ])('%s', (_label, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('Roster repo rules are main and agent and frozen', () => {
    expect(ROSTER_REPO_BRANCH_RULES).toEqual({ baseBranch: 'main', branchPrefix: 'agent' });
    expect(Object.isFrozen(ROSTER_REPO_BRANCH_RULES)).toBe(true);
  });

  it.each([
    ['NNN too short', () => taskBranch(def, '02', 'T01')],
    ['NNN not digits', () => specBranch(def, 'abc')],
    ['NNN with slash', () => planBranch(def, '0/2')],
    ['task key bad', () => taskBranch(def, '002', 'X1')],
    ['task key with slash', () => taskBranch(def, '002', 'T1/2')],
    ['slug uppercase', () => hireBranch('Analyst')],
    ['slug with slash', () => hireBranch('a/b')],
    ['slug empty', () => registrationBranch('')],
    ['invalid prefix', () => taskBranch({ baseBranch: 'main', branchPrefix: 'Bad' }, '002', 'T01')],
  ])('throws BranchNameError: %s', (_label, run) => {
    expect(run).toThrow(BranchNameError);
  });

  it('assertBranchRules rejects invalid rules and accepts valid ones', () => {
    expect(() => assertBranchRules(feature)).not.toThrow();
    expect(() => assertBranchRules({ baseBranch: 'main', branchPrefix: 'develop' })).toThrow(BranchNameError);
    expect(() => assertBranchRules({ baseBranch: 'agent/x', branchPrefix: 'agent' })).toThrow(BranchNameError);
  });
});

describe('isAgentBranch', () => {
  it.each([
    [def, 'agent/002-T01', true],
    [def, 'agent/hire-x', true],
    [feature, 'feature/agent-002-T01', true],
    [feature, 'feature/agent-x', true],
    [feature, 'feature/login', false],
    [def, 'agent/x/y', false],
    [def, 'agent/', false],
    [feature, 'feature/agent-', false],
    [feature, 'agent/002-T01', false],
    [feature, 'feature/agent-a/b', false],
    [def, 'main', false],
    [def, 'feature/agent-002-T01', false],
    [{ baseBranch: 'main', branchPrefix: 'BAD' }, 'BAD/agent-1', false],
  ] as const)('%j %s -> %s', (rules, name, expected) => {
    expect(isAgentBranch(rules, name)).toBe(expected);
  });
});
