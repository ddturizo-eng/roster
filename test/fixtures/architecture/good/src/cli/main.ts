// Fixture for test/architecture.test.ts: cli imports every layer, also through a literal dynamic
// import.
import { selectNext } from '../core/dag/select.ts';
import { openStore } from '../adapters/store/sqlite/store.ts';

export const run = async (path: string): Promise<string | undefined> => {
  const adapter = await import('../adapters/store/sqlite/store.ts');
  return selectNext(adapter.openStore(path))?.id ?? selectNext(openStore(path))?.id;
};
