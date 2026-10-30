// Deliberately bad fixture for test/architecture.test.ts: ports imports core outside core/domain.
import type { Task } from '../core/domain/task.ts';
import { selectNext } from '../core/dag/select.ts';

export interface StorePort {
  readonly tasks: readonly Task[];
}
export const pick = selectNext;
