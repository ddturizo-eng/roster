import { describe, expect, it } from 'vitest';
import { parseTasksMd } from '../../../src/core/dag/parse.ts';
import type { ParsedTask } from '../../../src/core/dag/parse.ts';
import { planReimport } from '../../../src/core/dag/reimport.ts';
import type { ReimportChange } from '../../../src/core/dag/reimport.ts';
import type { DagTask } from '../../../src/core/dag/select.ts';
import { TASK_STATUSES } from '../../../src/core/domain/task.ts';
import type { TaskStatus } from '../../../src/core/domain/task.ts';
import { file, row, taskText } from './helpers.ts';

function parse(...tasks: readonly string[]): ParsedTask[] {
  const result = parseTasksMd(file(...tasks));
  expect(result.errors).toEqual([]);
  return [...result.tasks];
}

/** A store row that matches a parsed task exactly, with the given status. */
function stored(task: ParsedTask, status: TaskStatus = 'todo', overrides: Partial<DagTask> = {}): DagTask {
  return row(task.key, {
    ord: task.ord,
    title: task.title,
    status,
    needsHuman: task.needsHuman,
    agentSlug: task.agent,
    profile: task.profile,
    bodyMd: task.bodyMd,
    dependsOn: task.dependsOn.map((key) => `p:001-${key}`),
    ...overrides,
  });
}

function changesOf(existing: readonly DagTask[], parsed: readonly ParsedTask[]): readonly ReimportChange[] {
  const plan = planReimport(existing, parsed);
  if (!plan.ok) {
    throw new Error(`plan rejected: ${JSON.stringify(plan.blockers)}`);
  }
  return plan.changes;
}

const NOT_STARTED: readonly TaskStatus[] = ['todo', 'waiting_hire', 'blocked', 'failed', 'stopped', 'rejected'];
const KEEP_STATE: readonly TaskStatus[] = ['done', 'in_review', 'running'];

describe('planReimport: no change', () => {
  it('returns no changes when the file matches the store', () => {
    const parsed = parse(taskText('T01'), taskText('T02', { depends: 'T01' }));
    const existing = parsed.map((t) => stored(t));
    expect(planReimport(existing, parsed)).toEqual({ ok: true, changes: [], warnings: [] });
  });

  it('ignores the Done checkbox for tasks the store already has', () => {
    const before = parse(taskText('T01'));
    const after = parse(taskText('T01', { done: '- [x] Done' }));
    expect(after[0]?.done).toBe(true);
    for (const status of TASK_STATUSES.filter((s) => s !== 'cancelled')) {
      expect(changesOf([stored(before[0] as ParsedTask, status)], after)).toEqual([]);
    }
  });

  it('is a no-op for an empty store and an empty file', () => {
    expect(planReimport([], [])).toEqual({ ok: true, changes: [], warnings: [] });
  });
});

describe('planReimport: new tasks', () => {
  it('adds tasks that are not in the store, in file order, with their Done state', () => {
    const parsed = parse(taskText('T01'), taskText('T02', { done: '- [x] Done' }), taskText('T03'));
    const changes = changesOf([stored(parsed[0] as ParsedTask)], parsed);
    expect(changes.map((c) => [c.kind, c.kind === 'add' ? c.task.key : null])).toEqual([
      ['add', 'T02'],
      ['add', 'T03'],
    ]);
    expect(changes[0]).toMatchObject({ kind: 'add', task: { key: 'T02', done: true, ord: 1 } });
  });

  it('adds every task of a first import', () => {
    const parsed = parse(taskText('T01'), taskText('T02'));
    expect(changesOf([], parsed).map((c) => c.kind)).toEqual(['add', 'add']);
  });
});

describe('planReimport: tasks not yet started follow the file', () => {
  describe.each(NOT_STARTED)('status %s', (status) => {
    const base = parse(taskText('T01'), taskText('T02'), taskText('T03', { depends: 'T01' }));
    const existing = base.map((t) => stored(t, status));

    it.each([
      ['text', { verification: 'new check' }, (c: ReimportChange) => c.kind === 'update' && c.changes.bodyMd?.includes('new check')],
      ['agent', { agent: 'new-agent' }, (c: ReimportChange) => c.kind === 'update' && c.changes.agentSlug === 'new-agent'],
      ['needs human', { needsHuman: 'a reason' }, (c: ReimportChange) => c.kind === 'update' && c.changes.needsHuman === 'a reason'],
      ['dependencies', { depends: 'T02' }, (c: ReimportChange) => c.kind === 'update' && c.changes.dependsOn?.join() === 'T02'],
    ] as const)('updates %s', (_name, override, check) => {
      const parsed = parse(taskText('T01'), taskText('T02'), taskText('T03', override));
      const changes = changesOf(existing, parsed);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: 'update', taskId: 'p:001-T03', key: 'T03' });
      expect(check(changes[0] as ReimportChange)).toBe(true);
    });
  });

  it('lists only the changed fields', () => {
    const base = parse(taskText('T01'), taskText('T02'));
    const parsed = parse(taskText('T01'), taskText('T02', { agent: 'someone' }));
    const [change] = changesOf([stored(base[0] as ParsedTask), stored(base[1] as ParsedTask)], parsed);
    expect(change).toMatchObject({ kind: 'update', taskId: 'p:001-T02' });
    if (change?.kind !== 'update') {
      throw new Error('expected update');
    }
    expect(Object.keys(change.changes).sort()).toEqual(['agentSlug', 'bodyMd']);
  });

  it('clears needs human and agent when the file drops them', () => {
    const base = parse(taskText('T01', { needsHuman: 'why', agent: 'someone' }));
    const parsed = parse(taskText('T01'));
    const [change] = changesOf([stored(base[0] as ParsedTask)], parsed);
    expect(change).toMatchObject({ kind: 'update', changes: { needsHuman: null, agentSlug: null } });
  });

  it('updates the title', () => {
    const base = parse(taskText('T01'));
    const parsed = [{ ...(base[0] as ParsedTask), title: 'Another title' }];
    expect(changesOf([stored(base[0] as ParsedTask)], parsed)[0]).toMatchObject({
      kind: 'update',
      changes: { title: 'Another title' },
    });
  });

  it('compares dependencies as a set, by key', () => {
    const base = parse(taskText('T01'), taskText('T02'), taskText('T03', { depends: 'T01, T02' }));
    const parsed = parse(taskText('T01'), taskText('T02'), taskText('T03', { depends: 'T02, T01' }));
    const existing = base.map((t) => stored(t));
    // Same set in another order: only the text differs.
    const [change] = changesOf(existing, parsed);
    if (change?.kind !== 'update') {
      throw new Error('expected update');
    }
    expect(Object.keys(change.changes)).toEqual(['bodyMd']);
  });
});

describe('planReimport: tasks that started keep their state', () => {
  describe.each(KEEP_STATE)('status %s', (status) => {
    const base = parse(taskText('T01'), taskText('T02'));
    const existing = base.map((t) => stored(t, status));

    it('records changed text as an event and changes nothing else', () => {
      const parsed = parse(taskText('T01'), taskText('T02', { verification: 'new', agent: 'someone', needsHuman: 'x', depends: 'T01' }));
      const changes = changesOf(existing, parsed);
      expect(changes).toEqual([
        { kind: 'text_changed', taskId: 'p:001-T02', key: 'T02', bodyMd: parsed[1]?.bodyMd },
      ]);
    });
  });
});

describe('planReimport: order', () => {
  it('reports a moved position for every task still in the file', () => {
    const base = parse(taskText('T01'), taskText('T02'), taskText('T03'));
    const existing = base.map((t) => stored(t, t.key === 'T01' ? 'done' : 'todo'));
    const parsed = parse(taskText('T01'), taskText('T04'), taskText('T02'), taskText('T03'));
    expect(changesOf(existing, parsed)).toEqual([
      { kind: 'add', task: parsed[1] },
      { kind: 'reorder', taskId: 'p:001-T02', key: 'T02', ord: 2 },
      { kind: 'reorder', taskId: 'p:001-T03', key: 'T03', ord: 3 },
    ]);
  });

  it('puts the reorder of a task before its update', () => {
    const base = parse(taskText('T01'), taskText('T02'));
    const existing = base.map((t) => stored(t));
    const parsed = parse(taskText('T00'), taskText('T01'), taskText('T02', { agent: 'someone' }));
    expect(changesOf(existing, parsed).map((c) => [c.kind, 'key' in c ? c.key : c.task.key])).toEqual([
      ['add', 'T00'],
      ['reorder', 'T01'],
      ['reorder', 'T02'],
      ['update', 'T02'],
    ]);
  });
});

describe('planReimport: removed tasks', () => {
  const base = parse(taskText('T01'), taskText('T02'));
  const parsed = parse(taskText('T01'));

  it.each(NOT_STARTED)('cancels a removed task that is %s', (status) => {
    const existing = [stored(base[0] as ParsedTask), stored(base[1] as ParsedTask, status)];
    expect(changesOf(existing, parsed)).toEqual([{ kind: 'cancel', taskId: 'p:001-T02', key: 'T02' }]);
  });

  it('keeps a removed task that is done and says so', () => {
    const existing = [stored(base[0] as ParsedTask), stored(base[1] as ParsedTask, 'done')];
    expect(changesOf(existing, parsed)).toEqual([{ kind: 'removed_kept', taskId: 'p:001-T02', key: 'T02' }]);
  });

  it('does nothing for a removed task that is already cancelled', () => {
    const existing = [stored(base[0] as ParsedTask), stored(base[1] as ParsedTask, 'cancelled')];
    expect(changesOf(existing, parsed)).toEqual([]);
  });

  it.each(['running', 'in_review'] as const)('rejects the whole re-import when a removed task is %s', (status) => {
    const existing = [stored(base[0] as ParsedTask), stored(base[1] as ParsedTask, status)];
    const added = parse(taskText('T01', { agent: 'someone' }), taskText('T09'));
    expect(planReimport(existing, added.slice(0, 1))).toEqual({
      ok: false,
      blockers: [{ taskId: 'p:001-T02', key: 'T02', status }],
    });
    // Nothing else is proposed, even though T01 changed and T09 is new.
    const plan = planReimport(existing, added);
    expect(plan.ok).toBe(false);
    expect('changes' in plan).toBe(false);
  });

  it('lists every blocker', () => {
    const three = parse(taskText('T01'), taskText('T02'), taskText('T03'));
    const existing = [
      stored(three[0] as ParsedTask, 'running'),
      stored(three[1] as ParsedTask, 'in_review'),
      stored(three[2] as ParsedTask, 'done'),
    ];
    const plan = planReimport(existing, []);
    expect(plan).toEqual({
      ok: false,
      blockers: [
        { taskId: 'p:001-T01', key: 'T01', status: 'running' },
        { taskId: 'p:001-T02', key: 'T02', status: 'in_review' },
      ],
    });
  });

  it('does not reject when a running task stays in the file', () => {
    const existing = base.map((t) => stored(t, 'running'));
    expect(planReimport(existing, base)).toEqual({ ok: true, changes: [], warnings: [] });
  });
});

describe('planReimport: cancelled tasks that reappear', () => {
  it('leaves them cancelled and warns', () => {
    const parsed = parse(taskText('T01'));
    const existing = [stored(parsed[0] as ParsedTask, 'cancelled', { ord: 7 })];
    expect(planReimport(existing, parsed)).toEqual({
      ok: true,
      changes: [],
      warnings: [{ taskId: 'p:001-T01', key: 'T01', code: 'cancelled_reappeared' }],
    });
  });
});

describe('planReimport: does not mutate its inputs', () => {
  it('leaves rows and parsed tasks untouched', () => {
    const base = parse(taskText('T01'), taskText('T02'));
    const existing = base.map((t) => stored(t));
    const parsed = parse(taskText('T01', { agent: 'someone' }));
    const before = JSON.stringify([existing, parsed]);
    planReimport(existing, parsed);
    expect(JSON.stringify([existing, parsed])).toBe(before);
  });
});
