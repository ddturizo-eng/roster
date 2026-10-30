// Fixture for test/architecture.test.ts: an adapter imports Node built-ins, ports, core/domain and
// its own files.
import { existsSync } from 'node:fs';
import type { Task } from '../../../core/domain/task.ts';
import type { StorePort } from '../../../ports/store-port.ts';
import { schemaVersion } from './schema.ts';

export const openStore = (path: string): StorePort & { readonly version: number } => {
  const tasks: Task[] = existsSync(path) ? [{ id: 'T01' }] : [];
  return { tasks, version: schemaVersion };
};
