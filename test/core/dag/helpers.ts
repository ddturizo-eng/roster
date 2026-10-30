// Builders shared by the dag tests.

import type { Feature } from '../../../src/core/domain/feature.ts';
import type { Task, TaskStatus } from '../../../src/core/domain/task.ts';
import type { DagTask } from '../../../src/core/dag/select.ts';

export interface TaskTextOptions {
  /** Field names left out: `Done`, `Depends on`, `Acceptance criteria`, `Verification`. */
  readonly omit?: readonly string[];
  /** Extra lines appended at the end of the task. */
  readonly extra?: readonly string[];
  readonly done?: string;
  readonly depends?: string;
  readonly needsHuman?: string;
  readonly agent?: string;
  readonly criteria?: string;
  readonly verification?: string;
}

/** One valid task as `tasks.md` text, LF-terminated. */
export function taskText(key: string, overrides: TaskTextOptions = {}): string {
  const omit = new Set(overrides.omit ?? []);
  const lines: string[] = [`## ${key}. Title of ${key}`, ''];
  const add = (name: string, line: string): void => {
    if (!omit.has(name)) {
      lines.push(line);
    }
  };
  add('Done', overrides.done ?? '- [ ] Done');
  add('Depends on', `- Depends on: ${overrides.depends ?? 'none'}`);
  if (overrides.needsHuman !== undefined) {
    lines.push(`- Needs human: ${overrides.needsHuman}`);
  }
  if (overrides.agent !== undefined) {
    lines.push(`- Agent: ${overrides.agent}`);
  }
  add('Acceptance criteria', overrides.criteria ?? '- Acceptance criteria:\n  - It works.');
  add('Verification', `- Verification: ${overrides.verification ?? 'unit tests'}`);
  lines.push(...(overrides.extra ?? []));
  return `${lines.join('\n')}\n`;
}

export function file(...tasks: readonly string[]): string {
  return `# Tasks\n\nPreamble.\n\n${tasks.join('\n')}`;
}

export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function row(key: string, overrides: Partial<DagTask> = {}): DagTask {
  const base: Task = {
    id: `p:001-${key}`,
    featureId: 'p:001',
    key,
    ord: 0,
    title: `Title of ${key}`,
    status: 'todo' as TaskStatus,
    needsHuman: null,
    agentSlug: null,
    profile: null,
    bodyMd: '',
    sourceCommit: 'abc',
    branch: null,
    prNumber: null,
    prUrl: null,
    mergedAt: null,
    stopReason: null,
    retryNote: null,
    updatedAt: '2026-01-01T00:00:00Z',
  };
  return { ...base, dependsOn: [], ...overrides };
}

export function feature(id: string, overrides: Partial<Feature> = {}): Feature {
  const number = id.split(':')[1] ?? '001';
  return {
    id,
    project: id.split(':')[0] ?? 'p',
    number,
    slug: 'feature',
    stage: 'execution',
    step: 'running',
    ideaText: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
