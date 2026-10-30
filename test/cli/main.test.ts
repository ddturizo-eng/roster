import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

describe('src/cli/main.ts', () => {
  it.each([[[]], [['--help']], [['run', '--dry-run']]])('prints usage and exits 0 with arguments %j', (args) => {
    const result = spawnSync(process.execPath, [mainPath, ...args], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^roster: /);
    expect(result.stdout).toContain('Usage:\n  roster <command> [options]\n');
    expect(result.stderr).toBe('');
  });
});
