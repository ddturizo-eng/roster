import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const mainPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const temp: string[] = [];

afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('src/cli/main.ts', () => {
  it.each([[[]], [['--help']], [['status']]])('prints usage and exits 0 with arguments %j', (args) => {
    const result = spawnSync(process.execPath, [mainPath, ...args], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^roster: /);
    expect(result.stdout).toContain('Usage:\n  roster <command> [options]\n');
    expect(result.stderr).toBe('');
  });

  it.each([[['run', '--dry-run']], [['run']], [['sync']], [['doctor']], [['feature', 'import', 'web', '001-x']]])(
    'reports a missing config file and exits 1 for %j, leaving no lock behind',
    (args) => {
      const localAppData = mkdtempSync(join(tmpdir(), 'roster-cli-'));
      temp.push(localAppData);
      const result = spawnSync(process.execPath, [mainPath, ...args], {
        encoding: 'utf8',
        env: { ...process.env, LOCALAPPDATA: localAppData },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ConfigError');
      expect(result.stderr).toContain('config file not found');
      expect(result.stdout).toBe('');
    },
  );
});
