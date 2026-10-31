// Shared setup for the CLI command tests: all ports are fakes sharing one call log.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Task } from '../../src/core/domain/task.ts';
import type { RunLock, LockResult } from '../../src/cli/lock.ts';
import { CallLog } from '../fakes/recorder.ts';
import { FakeClock } from '../fakes/clock.ts';
import { FakeConsole } from '../fakes/console.ts';
import { FakeFileSystem } from '../fakes/file-system.ts';
import { FakeForge } from '../fakes/forge.ts';
import { FakeRuntime } from '../fakes/runtime.ts';
import { FakeSandbox } from '../fakes/sandbox.ts';
import { FakeSecrets } from '../fakes/secrets.ts';
import { FakeStore } from '../fakes/store.ts';
import { FakeVcs } from '../fakes/vcs.ts';

export const ROSTER = 'C:\\roster';
export const WEB = 'C:\\code\\web';
export const REGISTRY_COMMIT = 'reg1234';

const POLICY_DIR = fileURLToPath(new URL('../../policies/', import.meta.url));
export const POLICY_MVP = readFileSync(`${POLICY_DIR}mvp.json`, 'utf8');
export const POLICY_PROTECTED = readFileSync(`${POLICY_DIR}protected-paths.json`, 'utf8');

export function registration(name: string, repoPath: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name,
    repoPath,
    remote: `https://github.com/acme/${name}`,
    setup: [],
    verify: [],
    dependencyManifests: [],
    protectedPaths: [],
    image: 'roster/runtime-claude',
    ...extra,
  });
}

export class FakeLock implements RunLock {
  readonly log: CallLog;
  busyPid: number | undefined;
  held = false;

  constructor(log: CallLog) {
    this.log = log;
  }

  acquire(): LockResult {
    this.log.record('lock', 'acquire', []);
    if (this.busyPid !== undefined) return { kind: 'busy', pid: this.busyPid };
    this.held = true;
    return { kind: 'acquired' };
  }

  release(): void {
    this.log.record('lock', 'release', []);
    this.held = false;
  }
}

export function task(key: string, ord: number, extra: Partial<Task> = {}): Task {
  return {
    id: `web:001-${key}`,
    featureId: 'web:001',
    key,
    ord,
    title: `Title ${key}`,
    status: 'todo',
    needsHuman: null,
    agentSlug: null,
    profile: null,
    bodyMd: 'body',
    sourceCommit: 'src1',
    branch: null,
    prNumber: null,
    prUrl: null,
    mergedAt: null,
    stopReason: null,
    retryNote: null,
    updatedAt: '2026-10-31T00:00:00.000Z',
    ...extra,
  };
}

/** A machine with registrations `roster` and `web` (base `develop`, prefix `feature`) at `origin/main`. */
export function machine(tasks: Task[] = [], edges: { taskId: string; dependsOnId: string }[] = []) {
  const log = new CallLog();
  const vcs = new FakeVcs(log);
  vcs.seedRef(ROSTER, 'origin/main', REGISTRY_COMMIT);
  vcs.seedFile(ROSTER, REGISTRY_COMMIT, 'projects/roster.json', registration('roster', ROSTER));
  vcs.seedFile(ROSTER, REGISTRY_COMMIT, 'projects/web.json', registration('web', WEB, { baseBranch: 'develop', branchPrefix: 'feature' }));
  vcs.seedFile(ROSTER, REGISTRY_COMMIT, 'policies/mvp.json', POLICY_MVP);
  vcs.seedFile(ROSTER, REGISTRY_COMMIT, 'policies/protected-paths.json', POLICY_PROTECTED);
  const store = new FakeStore(log);
  store.upsertProject({
    name: 'web',
    repoPath: WEB,
    remoteUrl: 'https://github.com/acme/web',
    ownerRepo: 'acme/web',
    registrationCommit: 'old',
    syncedAt: '2026-10-01T00:00:00.000Z',
  });
  store.createFeature({
    id: 'web:001',
    project: 'web',
    number: '001',
    slug: 'thing',
    stage: 'execution',
    step: 'running',
    ideaText: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  store.importTasks('web:001', tasks, edges);
  const forge = new FakeForge(log);
  const sandbox = new FakeSandbox(log);
  const secrets = new FakeSecrets({ 'claude-oauth-token': 'fake-claude-0000', 'github-token': 'fake-gh-0000' }, log);
  const console = new FakeConsole(log);
  // Between 22:00 and 06:00 local time, so the night window is open.
  const clock = new FakeClock(new Date(2026, 10, 1, 23, 0, 0).toISOString(), log);
  const fs = new FakeFileSystem(log);
  const lock = new FakeLock(log);
  const runtime = new FakeRuntime();
  log.clear();
  return { log, vcs, store, forge, sandbox, secrets, console, clock, fs, lock, runtime };
}
