// Deliberately bad fixture for test/architecture.test.ts: an adapter imports cli.
import type { StorePort } from '../../../ports/store-port.ts';
import { usage } from '../../../cli/main.ts';

export const openStore = (): StorePort => ({ tasks: [] });
export const banner = usage;
