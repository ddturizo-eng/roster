import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreOperationError, openSqliteStore } from '../../../../src/adapters/store/sqlite/index.ts';
import type { SqliteStore } from '../../../../src/adapters/store/sqlite/index.ts';
import { NotFoundError } from '../../../../src/core/domain/errors.ts';
import type { RateLimitSnapshot } from '../../../../src/core/domain/runtime.ts';
import type { Task } from '../../../../src/core/domain/task.ts';
import type { NewExecution, StorePort } from '../../../../src/ports/store.ts';

// Each test gets a fresh directory under the OS temp dir. The store is closed before the directory
// is removed, because Windows keeps `roster.db`, `-wal` and `-shm` locked while the file is open.
const dirs: string[] = [];
const open: SqliteStore[] = [];

function openStore(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), 'roster-exec-'));
  dirs.push(dir);
  const store = openSqliteStore(join(dir, 'roster.db'));
  open.push(store);
  store.upsertProject({
    name: 'roster',
    repoPath: 'C:\\roster',
    remoteUrl: 'https://github.com/o/r',
    ownerRepo: 'o/r',
    registrationCommit: 'abc',
    syncedAt: '2026-10-30T10:00:00.000Z',
  });
  for (const number of ['001', '002']) {
    store.createFeature({
      id: `roster:${number}`,
      project: 'roster',
      number,
      slug: `f-${number}`,
      stage: 'execution',
      step: 'running',
      ideaText: null,
      createdAt: `2026-10-30T10:00:0${number.slice(-1)}.000Z`,
      updatedAt: '2026-10-30T10:00:00.000Z',
    });
  }
  const t: Task = {
    id: 'roster:001-T01',
    featureId: 'roster:001',
    key: 'T01',
    ord: 1,
    title: 'T',
    status: 'todo',
    needsHuman: null,
    agentSlug: null,
    profile: null,
    bodyMd: 'b',
    sourceCommit: 'c',
    branch: null,
    prNumber: null,
    prUrl: null,
    mergedAt: null,
    stopReason: null,
    retryNote: null,
    updatedAt: '2026-10-30T10:00:00.000Z',
  };
  store.importTasks('roster:001', [t], []);
  return store;
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const newExec = (startedAt: string, overrides: Partial<NewExecution> = {}): NewExecution => ({
  taskId: 'roster:001-T01',
  featureId: 'roster:001',
  jobKind: 'specialist',
  agentSlug: 'roster-sqlite-store-engineer',
  runtime: 'claude-code',
  startedAt,
  pid: 4242,
  ...overrides,
});

describe('executions', () => {
  it('SqliteStore is assignable to the whole StorePort', () => {
    const store: StorePort = openStore();
    expect(typeof store.latestRateLimit).toBe('function');
  });

  it('runs a full lifecycle with steps and events', () => {
    const store = openStore();
    const started = store.startExecution(newExec('2026-10-30T22:15:09.123Z'));
    expect(started.id).toMatch(/^20261030221509-[0-9a-f]{6}$/);
    expect(started).toMatchObject({
      status: 'running',
      endedAt: null,
      pid: 4242,
      rateLimit: null,
      taskId: 'roster:001-T01',
    });

    const updated = store.updateExecution(started.id, { branch: 'agent/002-T07', logDir: 'logs\\x', baseCommit: 'aaa' });
    expect(updated).toMatchObject({ branch: 'agent/002-T07', logDir: 'logs\\x', baseCommit: 'aaa', pid: 4242 });
    expect(store.updateExecution(started.id, { pid: null }).pid).toBeNull();
    expect(store.updateExecution(started.id, {}).branch).toBe('agent/002-T07');

    store.recordStep({ executionId: started.id, step: 'workspace', status: 'running', startedAt: '2026-10-30T22:15:10.000Z', endedAt: null, detail: null });
    store.recordStep({ executionId: started.id, step: 'setup', status: 'succeeded', startedAt: '2026-10-30T22:15:11.000Z', endedAt: '2026-10-30T22:15:20.000Z', detail: 'npm ci' });
    store.recordStep({ executionId: started.id, step: 'workspace', status: 'succeeded', startedAt: '2026-10-30T22:15:10.000Z', endedAt: '2026-10-30T22:15:11.000Z', detail: null });
    const steps = store.listSteps(started.id);
    expect(steps.map((s) => [s.step, s.status])).toEqual([
      ['workspace', 'succeeded'],
      ['setup', 'succeeded'],
    ]);
    expect(steps[0]?.endedAt).toBe('2026-10-30T22:15:11.000Z');

    const e1 = store.appendEvent({ executionId: started.id, at: '2026-10-30T22:16:00.000Z', type: 'outcome', payload: { kind: 'completed', n: 1 } });
    const e2 = store.appendEvent({ executionId: started.id, at: '2026-10-30T22:16:01.000Z', type: 'egress_denied', payload: null });
    expect(e2.id).toBeGreaterThan(e1.id);
    expect(store.listEvents(started.id)).toEqual([e1, e2]);
    expect(e1.payload).toEqual({ kind: 'completed', n: 1 });

    const finished = store.finishExecution(started.id, {
      status: 'succeeded',
      endedAt: '2026-10-30T22:30:00.000Z',
      headCommit: 'bbb',
      prUrl: 'https://github.com/o/r/pull/1',
    });
    expect(finished).toMatchObject({ status: 'succeeded', endedAt: '2026-10-30T22:30:00.000Z', headCommit: 'bbb', reason: null });
    expect(store.getExecution(started.id)).toEqual(finished);
    expect(store.getExecution('nope')).toBeUndefined();
  });

  it('throws NotFoundError for unknown executions and approvals', () => {
    const store = openStore();
    expect(() => store.updateExecution('x', { pid: 1 })).toThrow(NotFoundError);
    expect(() => store.finishExecution('x', { status: 'failed', endedAt: '2026-10-30T22:30:00.000Z' })).toThrow(NotFoundError);
    expect(() => store.recordRateLimit('x', { observedAt: '2026-10-30T22:30:00.000Z' })).toThrow(NotFoundError);
    expect(() => store.resolveApproval(99, 'approved', '2026-10-30T22:30:00.000Z')).toThrow(NotFoundError);
  });

  it('enforces foreign keys', () => {
    const store = openStore();
    expect(() => store.startExecution(newExec('2026-10-30T22:15:09.000Z', { featureId: 'roster:999' }))).toThrow(StoreOperationError);
    expect(() => store.startExecution(newExec('2026-10-30T22:15:09.000Z', { taskId: 'missing' }))).toThrow(StoreOperationError);
    expect(() => store.recordStep({ executionId: 'x', step: 'agent', status: 'running', startedAt: 't', endedAt: null, detail: null })).toThrow(StoreOperationError);
    expect(() => store.appendEvent({ executionId: 'x', at: 't', type: 'outcome', payload: 1 })).toThrow(StoreOperationError);
    expect(() => store.requestApproval({ taskId: 'missing', kind: 'dependencies', detail: { kind: 'dependencies', manifests: [], diff: '' }, contentHash: null, createdAt: 't' })).toThrow(StoreOperationError);
  });

  it('accepts a stage job without a task and rejects an invalid start time', () => {
    const store = openStore();
    const stage = store.startExecution(newExec('2026-10-30T22:15:09.000Z', { taskId: null, jobKind: 'architect', agentSlug: null, runtime: null, pid: null }));
    expect(stage).toMatchObject({ taskId: null, agentSlug: null, runtime: null, pid: null });
    expect(() => store.startExecution(newExec('not a time'))).toThrow(StoreOperationError);
  });

  it('gives distinct ids to executions started in the same second', () => {
    const store = openStore();
    const ids = new Set(Array.from({ length: 50 }, () => store.startExecution(newExec('2026-10-30T22:15:09.000Z')).id));
    expect(ids.size).toBe(50);
  });

  it('counts executions started inside a half-open window', () => {
    const store = openStore();
    for (const at of ['2026-10-30T21:59:59.999Z', '2026-10-30T22:00:00.000Z', '2026-10-31T03:00:00.000Z', '2026-10-31T06:00:00.000Z']) {
      store.startExecution(newExec(at));
    }
    expect(store.countExecutionsStarted('2026-10-30T22:00:00.000Z', '2026-10-31T06:00:00.000Z')).toBe(2);
    expect(store.countExecutionsStarted('2026-10-31T06:00:00.000Z', '2026-10-31T07:00:00.000Z')).toBe(1);
    expect(store.countExecutionsStarted('2027-01-01T00:00:00.000Z', '2027-01-02T00:00:00.000Z')).toBe(0);
  });

  it('lists executions newest first with filters, limit and latest per feature', () => {
    const store = openStore();
    const a = store.startExecution(newExec('2026-10-30T10:00:00.000Z'));
    const b = store.startExecution(newExec('2026-10-30T11:00:00.000Z'));
    const c = store.startExecution(newExec('2026-10-30T12:00:00.000Z', { featureId: 'roster:002', taskId: null }));
    store.finishExecution(a.id, { status: 'failed', endedAt: '2026-10-30T10:30:00.000Z', reason: 'verify failed' });
    expect(store.listExecutions().map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect(store.listExecutions({ featureId: 'roster:001', limit: 1 }).map((e) => e.id)).toEqual([b.id]);
    expect(store.listExecutions({ featureId: 'roster:002', limit: 1 }).map((e) => e.id)).toEqual([c.id]);
    expect(store.listExecutions({ status: 'failed' })).toMatchObject([{ id: a.id, reason: 'verify failed' }]);
    expect(store.listExecutions({ taskId: 'roster:001-T01' })).toHaveLength(2);
    expect(store.listExecutions({ project: 'roster' })).toHaveLength(3);
    expect(store.listExecutions({ project: 'other' })).toEqual([]);
  });

  it('rolls back an execution and its step when the surrounding transaction fails', () => {
    const store = openStore();
    let id = '';
    expect(() =>
      store.transaction(() => {
        id = store.startExecution(newExec('2026-10-30T10:00:00.000Z')).id;
        store.recordStep({ executionId: id, step: 'agent', status: 'running', startedAt: 't', endedAt: null, detail: null });
        throw new Error('forced');
      }),
    ).toThrow('forced');
    expect(store.getExecution(id)).toBeUndefined();
    expect(store.listSteps(id)).toEqual([]);
    expect(store.countExecutionsStarted('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toBe(0);
  });
});

describe('rate-limit snapshots', () => {
  const full: RateLimitSnapshot = {
    status: 'allowed',
    limitType: 'five_hour',
    fiveHour: { utilization: 0.6, resetsAt: '2026-10-31T01:00:00.000Z' },
    sevenDay: { utilization: 0.25, resetsAt: '2026-11-03T00:00:00.000Z' },
    observedAt: '2026-10-30T22:20:00.000Z',
  };

  it('keeps every column null when no snapshot was recorded', () => {
    const store = openStore();
    const e = store.startExecution(newExec('2026-10-30T22:15:09.000Z'));
    expect(e.rateLimit).toBeNull();
    expect(store.latestRateLimit('claude-code')).toBeUndefined();
    const raw = new DatabaseSync(join(dirs[0] as string, 'roster.db'));
    try {
      const row = raw.prepare('SELECT * FROM executions WHERE id = ?').get(e.id) as Record<string, unknown>;
      for (const column of ['rate_limit_status', 'rate_limit_type', 'five_hour_utilization', 'five_hour_resets_at', 'seven_day_utilization', 'seven_day_resets_at', 'rate_limit_observed_at']) {
        expect(row[column]).toBeNull();
      }
    } finally {
      raw.close();
    }
  });

  it('round-trips a full snapshot and a minimal one', () => {
    const store = openStore();
    const e = store.startExecution(newExec('2026-10-30T22:15:09.000Z'));
    store.recordRateLimit(e.id, full);
    expect(store.getExecution(e.id)?.rateLimit).toEqual(full);
    store.recordRateLimit(e.id, { observedAt: '2026-10-30T22:25:00.000Z' });
    expect(store.getExecution(e.id)?.rateLimit).toEqual({ observedAt: '2026-10-30T22:25:00.000Z' });
  });

  it('overwrites the previous snapshot of the same execution', () => {
    const store = openStore();
    const e = store.startExecution(newExec('2026-10-30T22:15:09.000Z'));
    store.recordRateLimit(e.id, full);
    const later: RateLimitSnapshot = { status: 'allowed_warning', fiveHour: { utilization: 0.9 }, observedAt: '2026-10-30T22:40:00.000Z' };
    store.recordRateLimit(e.id, later);
    expect(store.getExecution(e.id)?.rateLimit).toEqual(later);
    expect(store.latestRateLimit('claude-code')).toEqual({ executionId: e.id, snapshot: later });
  });

  it('returns the most recently observed snapshot of the runtime across executions', () => {
    const store = openStore();
    const a = store.startExecution(newExec('2026-10-30T10:00:00.000Z'));
    const b = store.startExecution(newExec('2026-10-30T11:00:00.000Z'));
    const other = store.startExecution(newExec('2026-10-30T12:00:00.000Z', { runtime: 'opencode' }));
    const none = store.startExecution(newExec('2026-10-30T13:00:00.000Z'));
    store.recordRateLimit(a.id, { ...full, observedAt: '2026-10-30T10:30:00.000Z' });
    store.recordRateLimit(b.id, { ...full, observedAt: '2026-10-30T11:30:00.000Z' });
    store.recordRateLimit(other.id, { ...full, observedAt: '2026-10-30T12:30:00.000Z' });
    expect(none.rateLimit).toBeNull();
    expect(store.latestRateLimit('claude-code')?.executionId).toBe(b.id);
    expect(store.latestRateLimit('opencode')?.executionId).toBe(other.id);
    // A snapshot of an older execution observed later wins: ordering is by observation time.
    store.recordRateLimit(a.id, { ...full, observedAt: '2026-10-30T14:00:00.000Z' });
    expect(store.latestRateLimit('claude-code')?.executionId).toBe(a.id);
    expect(store.latestRateLimit('unknown')).toBeUndefined();
  });
});

describe('approvals', () => {
  it('requests, lists, filters and resolves', () => {
    const store = openStore();
    const deps = store.requestApproval({
      taskId: 'roster:001-T01',
      kind: 'dependencies',
      detail: { kind: 'dependencies', manifests: ['package.json'], diff: '+ "x": "1"' },
      contentHash: 'sha256:abc',
      createdAt: '2026-10-30T10:00:00.000Z',
    });
    const paths = store.requestApproval({
      taskId: 'roster:001-T01',
      kind: 'protected_path',
      detail: { kind: 'protected_path', paths: ['.claude/x'], branch: 'agent/002-T07' },
      contentHash: null,
      createdAt: '2026-10-30T10:01:00.000Z',
    });
    expect(deps).toMatchObject({ resolvedAt: null, resolution: null, contentHash: 'sha256:abc' });
    expect(deps.detail).toEqual({ kind: 'dependencies', manifests: ['package.json'], diff: '+ "x": "1"' });
    expect(paths.contentHash).toBeNull();
    expect(store.listApprovals().map((a) => a.id)).toEqual([deps.id, paths.id]);

    const resolved = store.resolveApproval(deps.id, 'approved', '2026-10-30T11:00:00.000Z');
    expect(resolved).toMatchObject({ resolution: 'approved', resolvedAt: '2026-10-30T11:00:00.000Z' });
    expect(store.listApprovals({ pending: true }).map((a) => a.id)).toEqual([paths.id]);
    expect(store.listApprovals({ pending: false }).map((a) => a.id)).toEqual([deps.id]);
    expect(store.listApprovals({ kind: 'protected_path' }).map((a) => a.id)).toEqual([paths.id]);
    expect(store.listApprovals({ taskId: 'other' })).toEqual([]);
    expect(store.resolveApproval(deps.id, 'consumed', '2026-10-30T12:00:00.000Z').resolution).toBe('consumed');
  });

  it('rejects a resolution outside the allowed values', () => {
    const store = openStore();
    const req = store.requestApproval({
      taskId: 'roster:001-T01',
      kind: 'protected_path',
      detail: { kind: 'protected_path', paths: [], branch: 'b' },
      contentHash: null,
      createdAt: 't',
    });
    expect(() => store.resolveApproval(req.id, 'bogus' as 'approved', 't')).toThrow(StoreOperationError);
    expect(store.listApprovals({ pending: true })).toHaveLength(1);
  });
});

describe('runtime state', () => {
  it('reads and writes the cooldown with both sources', () => {
    const store = openStore();
    expect(store.getRuntimeState('claude-code')).toBeUndefined();
    const fromReset = {
      runtime: 'claude-code',
      quotaExhaustedAt: '2026-10-30T22:00:00.000Z',
      cooldownUntil: '2026-10-31T01:00:00.000Z',
      cooldownSource: 'resets_at' as const,
      cooldownWindow: 'five_hour',
    };
    store.setRuntimeState(fromReset);
    expect(store.getRuntimeState('claude-code')).toEqual(fromReset);
    const fallback = { ...fromReset, cooldownUntil: '2026-10-31T03:00:00.000Z', cooldownSource: 'fallback' as const, cooldownWindow: null };
    store.setRuntimeState(fallback);
    expect(store.getRuntimeState('claude-code')).toEqual(fallback);
    const cleared = { runtime: 'claude-code', quotaExhaustedAt: null, cooldownUntil: null, cooldownSource: null, cooldownWindow: null };
    store.setRuntimeState(cleared);
    expect(store.getRuntimeState('claude-code')).toEqual(cleared);
    store.setRuntimeState({ ...fromReset, runtime: 'a-runtime' });
    expect(store.listRuntimeStates().map((s) => s.runtime)).toEqual(['a-runtime', 'claude-code']);
  });

  it('rejects an unknown cooldown source', () => {
    const store = openStore();
    expect(() =>
      store.setRuntimeState({ runtime: 'x', quotaExhaustedAt: null, cooldownUntil: null, cooldownSource: 'bogus' as 'fallback', cooldownWindow: null }),
    ).toThrow(StoreOperationError);
  });
});
