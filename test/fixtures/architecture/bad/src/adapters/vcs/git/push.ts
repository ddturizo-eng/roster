// Deliberately bad fixture for test/architecture.test.ts: an adapter imports another adapter.
import { branchName } from './branch.ts';
import { openStore } from '../../store/sqlite/store.ts';

export const push = (taskId: string): string => `${branchName(taskId)} ${openStore().tasks.length}`;
