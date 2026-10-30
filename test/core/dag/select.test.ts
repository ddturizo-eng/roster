import { describe, expect, it } from 'vitest';
import { indexTasks, isReady, selectNext, withDependencies } from '../../../src/core/dag/select.ts';
import type { DagTask } from '../../../src/core/dag/select.ts';
import { TASK_STATUSES } from '../../../src/core/domain/task.ts';
import type { TaskStatus } from '../../../src/core/domain/task.ts';
import { feature, row } from './helpers.ts';

/** Task rows of feature `p:001` by key, with the given status. */
function tasksOf(...specs: readonly [key: string, status: TaskStatus, dependsOn: readonly string[]][]): DagTask[] {
  return specs.map(([key, status, dependsOn], ord) =>
    row(key, { ord, status, dependsOn: dependsOn.map((d) => `p:001-${d}`) }),
  );
}

describe('isReady', () => {
  it('is ready when todo, not needs-human and every dependency is done', () => {
    const tasks = tasksOf(['T01', 'done', []], ['T02', 'done', []], ['T03', 'todo', ['T01', 'T02']]);
    expect(isReady(tasks[2] as DagTask, indexTasks(tasks))).toBe(true);
  });

  it('is ready with no dependencies', () => {
    const tasks = tasksOf(['T01', 'todo', []]);
    expect(isReady(tasks[0] as DagTask, indexTasks(tasks))).toBe(true);
  });

  it.each(TASK_STATUSES.filter((s) => s !== 'todo'))('is not ready when the task itself is %s', (status) => {
    const tasks = tasksOf(['T01', status, []]);
    expect(isReady(tasks[0] as DagTask, indexTasks(tasks))).toBe(false);
  });

  it.each(TASK_STATUSES.filter((s) => s !== 'done'))('is not ready when a dependency is %s', (status) => {
    const tasks = tasksOf(['T01', 'done', []], ['T02', status, []], ['T03', 'todo', ['T01', 'T02']]);
    expect(isReady(tasks[2] as DagTask, indexTasks(tasks))).toBe(false);
  });

  it('is not ready when it needs a human, whatever its dependencies', () => {
    const tasks = [row('T01', { needsHuman: 'needs Docker Desktop' })];
    expect(isReady(tasks[0] as DagTask, indexTasks(tasks))).toBe(false);
  });

  it('is not ready when a dependency is missing from the map', () => {
    const task = row('T02', { dependsOn: ['p:001-T01'] });
    expect(isReady(task, new Map())).toBe(false);
  });

  it('accepts a map of bare statuses', () => {
    const task = row('T02', { dependsOn: ['x'] });
    expect(isReady(task, new Map([['x', { status: 'done' as const }]]))).toBe(true);
  });
});

describe('withDependencies', () => {
  it('attaches the edges of each task in the order given', () => {
    const tasks = [row('T01'), row('T02'), row('T03')];
    const result = withDependencies(tasks, [
      { taskId: 'p:001-T03', dependsOnId: 'p:001-T02' },
      { taskId: 'p:001-T03', dependsOnId: 'p:001-T01' },
      { taskId: 'p:001-T02', dependsOnId: 'p:001-T01' },
    ]);
    expect(result.map((t) => t.dependsOn)).toEqual([[], ['p:001-T01'], ['p:001-T02', 'p:001-T01']]);
  });
});

describe('selectNext', () => {
  const key = (task: DagTask | null): string | null => (task === null ? null : task.id);

  it('takes the first ready task in file order', () => {
    const tasks = tasksOf(['T01', 'done', []], ['T02', 'todo', ['T01']], ['T03', 'todo', []]);
    expect(key(selectNext([feature('p:001')], tasks))).toBe('p:001-T02');
  });

  it('follows ord, not the order of the array', () => {
    const tasks = tasksOf(['T01', 'todo', []], ['T02', 'todo', []], ['T03', 'todo', []]).reverse();
    expect(key(selectNext([feature('p:001')], tasks))).toBe('p:001-T01');
  });

  it('skips tasks that are not ready', () => {
    const tasks = [
      row('T01', { ord: 0, status: 'running' }),
      row('T02', { ord: 1, needsHuman: 'x' }),
      row('T03', { ord: 2, dependsOn: ['p:001-T01'] }),
      row('T04', { ord: 3 }),
    ];
    expect(key(selectNext([feature('p:001')], tasks))).toBe('p:001-T04');
  });

  it('returns null when nothing is ready', () => {
    const tasks = tasksOf(['T01', 'running', []], ['T02', 'todo', ['T01']]);
    expect(selectNext([feature('p:001')], tasks)).toBeNull();
    expect(selectNext([], [])).toBeNull();
  });

  it('takes the oldest feature in execution first', () => {
    const features = [
      feature('p:002', { createdAt: '2026-02-01T00:00:00Z' }),
      feature('p:001', { createdAt: '2026-01-01T00:00:00Z' }),
    ];
    const tasks = [
      row('T01', { id: 'p:002-T01', featureId: 'p:002', ord: 0 }),
      row('T01', { id: 'p:001-T01', featureId: 'p:001', ord: 5 }),
    ];
    expect(key(selectNext(features, tasks))).toBe('p:001-T01');
  });

  it('moves to the next feature when the oldest has no ready task', () => {
    const features = [feature('p:001'), feature('p:002', { createdAt: '2026-02-01T00:00:00Z' })];
    const tasks = [
      row('T01', { id: 'p:001-T01', featureId: 'p:001', status: 'running' }),
      row('T01', { id: 'p:002-T01', featureId: 'p:002' }),
    ];
    expect(key(selectNext(features, tasks))).toBe('p:002-T01');
  });

  it('ignores features that are not in stage execution', () => {
    const features = [
      feature('p:001', { stage: 'plan_approved', step: 'importing' }),
      feature('p:002', { stage: 'delivered', step: 'done' }),
      feature('p:003', { createdAt: '2026-03-01T00:00:00Z' }),
    ];
    const tasks = ['p:001', 'p:002', 'p:003'].map((id) => row('T01', { id: `${id}-T01`, featureId: id }));
    expect(key(selectNext(features, tasks))).toBe('p:003-T01');
  });

  it('ignores tasks of unknown features', () => {
    expect(selectNext([feature('p:001')], [row('T01', { featureId: 'p:009' })])).toBeNull();
  });

  it('breaks a tie of creation time by feature number, then id', () => {
    const same = { createdAt: '2026-01-01T00:00:00Z' };
    const features = [feature('b:002', same), feature('a:002', same), feature('a:001', same)];
    const tasks = features.map((f) => row('T01', { id: `${f.id}-T01`, featureId: f.id }));
    expect(key(selectNext(features, tasks))).toBe('a:001-T01');
    expect(key(selectNext(features.slice(0, 2), tasks.slice(0, 2)))).toBe('a:002-T01');
  });

  it('does not mutate its inputs', () => {
    const features = [feature('p:002', { createdAt: '2026-02-01T00:00:00Z' }), feature('p:001')];
    const tasks = tasksOf(['T02', 'todo', []], ['T01', 'todo', []]);
    const before = JSON.stringify([features, tasks]);
    selectNext(features, tasks);
    expect(JSON.stringify([features, tasks])).toBe(before);
  });

  it('a task whose dependency was cancelled is never selected', () => {
    const tasks = tasksOf(['T01', 'cancelled', []], ['T02', 'todo', ['T01']]);
    expect(selectNext([feature('p:001')], tasks)).toBeNull();
  });
});
