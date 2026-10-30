// Fixture for test/architecture.test.ts: core imports core and ports.
import type { Task } from '../domain/task.ts';
import type { StorePort } from '../../ports/store-port.ts';

export const selectNext = (store: StorePort): Task | undefined => store.tasks[0];
