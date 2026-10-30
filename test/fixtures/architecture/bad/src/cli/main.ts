// Fixture for test/architecture.test.ts. Allowed: cli imports every layer.
import { openStore } from '../adapters/store/sqlite/store.ts';

export const usage = 'usage';
export const store = openStore;
