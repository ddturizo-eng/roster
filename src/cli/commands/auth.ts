// `roster auth set claude|github` (ADR 0016, ADR 0029): reads the secret without echo, stores it and
// prints only its last 4 characters.

import type { ConsolePort } from '../../ports/console.ts';
import type { SecretName, SecretsPort } from '../../ports/secrets.ts';

export const AUTH_USAGE = 'Usage: roster auth set claude|github';

const TARGETS: Readonly<Record<string, { readonly name: SecretName; readonly label: string }>> = {
  claude: { name: 'claude-oauth-token', label: 'Claude OAuth token' },
  github: { name: 'github-token', label: 'GitHub token' },
};

export interface AuthDeps {
  readonly secrets: SecretsPort;
  readonly console: ConsolePort;
}

/** Last 4 characters only; a value of 4 or fewer characters is fully hidden. */
export function lastFour(value: string): string {
  return value.length > 4 ? value.slice(-4) : '****';
}

/** Runs `roster auth <args>`; returns the process exit code. */
export async function runAuth(args: readonly string[], deps: AuthDeps): Promise<number> {
  const [action, target, ...rest] = args;
  const entry = target === undefined || !Object.hasOwn(TARGETS, target) ? undefined : TARGETS[target];
  if (action !== 'set' || entry === undefined || rest.length > 0) {
    deps.console.printError(AUTH_USAGE);
    return 1;
  }
  const value = (await deps.console.readSecret(`Paste the ${entry.label} and press Enter:`)).trim();
  if (value === '') {
    deps.console.printError('No value given; nothing stored.');
    return 1;
  }
  await deps.secrets.set(entry.name, value);
  deps.console.print(`Stored ${entry.label} (ends with ${lastFour(value)}).`);
  return 0;
}
