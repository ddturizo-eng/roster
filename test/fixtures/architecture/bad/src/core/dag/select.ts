// Deliberately bad fixture for test/architecture.test.ts: core imports a Node built-in, an adapter
// and a module it cannot name statically.
import { readFileSync } from 'node:fs';
import { openStore } from '../../adapters/store/sqlite/store.ts';
import type { Task } from '../domain/task.ts';

export const selectNext = (tasks: readonly Task[]): Task | undefined => tasks[0];
export const readTasks = (path: string): string => readFileSync(path, 'utf8');
export const store = openStore;
export const load = (name: string): Promise<unknown> => import(name);
