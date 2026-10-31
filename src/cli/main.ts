// Composition root of the roster CLI. Commands are added by later tasks of spec 002;
// until then every other invocation prints usage and exits 0.

import { createTtyConsole } from '../adapters/console/tty/index.ts';
import { createDpapiSecrets } from '../adapters/secrets/dpapi/index.ts';
import { RosterError } from '../core/domain/errors.ts';
import { runAuth } from './commands/auth.ts';

const USAGE = `roster: local orchestration of agent specialists

Usage:
  roster <command> [options]

Commands:
  auth set claude|github   Store a secret (read from the terminal, never echoed).

Other commands are not available yet.
`;

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'auth') {
    const console = createTtyConsole();
    try {
      return await runAuth(argv.slice(1), { secrets: createDpapiSecrets(), console });
    } catch (error) {
      if (error instanceof RosterError) {
        console.printError(error.message);
        return 1;
      }
      throw error;
    }
  }
  process.stdout.write(USAGE);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
