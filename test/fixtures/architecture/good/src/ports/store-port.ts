// Fixture for test/architecture.test.ts: ports imports core/domain only.
import type { Task } from '../core/domain/task.ts';

export type { Task } from '../core/domain/task.ts';

export interface StorePort {
  readonly tasks: readonly Task[];
}
