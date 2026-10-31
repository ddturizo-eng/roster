import { describe, expect, it } from 'vitest';
import { lastFour, runAuth } from '../../src/cli/commands/auth.ts';
import { FakeConsole } from '../fakes/console.ts';
import { FakeSecrets } from '../fakes/secrets.ts';

const VALUE = 'sk-ant-oat01-DUMMYvalue-WXYZ';

function setup(answer: string) {
  const secrets = new FakeSecrets();
  const console = new FakeConsole();
  console.responses.setDefault('readSecret', () => answer);
  return { secrets, console };
}

describe('roster auth set', () => {
  it.each([
    ['claude', 'claude-oauth-token'],
    ['github', 'github-token'],
  ] as const)('stores the %s secret and prints only the last 4 characters', async (target, name) => {
    const { secrets, console } = setup(`${VALUE}\n`);
    expect(await runAuth(['set', target], { secrets, console })).toBe(0);
    expect(secrets.values.get(name)).toBe(VALUE);
    expect(console.stdout).toHaveLength(1);
    expect(console.stdout[0]).toContain('WXYZ');
    expect(console.stdout.join('\n')).not.toContain(VALUE);
    expect(console.stdout.join('\n')).not.toContain('DUMMY');
  });

  it('prints usage and stores nothing for bad arguments', async () => {
    for (const args of [[], ['set'], ['set', 'other'], ['get', 'claude'], ['set', 'claude', 'x'], ['set', 'constructor']]) {
      const { secrets, console } = setup(VALUE);
      expect(await runAuth(args, { secrets, console })).toBe(1);
      expect(secrets.values.size).toBe(0);
      expect(console.stderr[0]).toContain('Usage: roster auth set');
    }
  });

  it('refuses an empty value', async () => {
    const { secrets, console } = setup('  \n');
    expect(await runAuth(['set', 'claude'], { secrets, console })).toBe(1);
    expect(secrets.values.size).toBe(0);
  });

  it('hides values of 4 or fewer characters', () => {
    expect(lastFour('abcd')).toBe('****');
    expect(lastFour('abcde')).toBe('bcde');
  });
});
