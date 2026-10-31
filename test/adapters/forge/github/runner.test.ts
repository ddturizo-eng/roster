import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXED_ENV, PASS_THROUGH_ENV, execFileGhRunner, ghEnv } from '../../../../src/adapters/forge/github/index.ts';
import { ExternalCommandError } from '../../../../src/core/domain/errors.ts';

// The real runner is exercised with `node` standing in for `gh`; no test runs the gh binary.

const FAKE_TOKEN = 'github_pat_FAKE0000000000000000000000000000000';
const PARENT_TOKEN = 'ghp_PARENTshouldNEVERreachGH000000000000';
const CONFIG_DIR = 'C:\\Users\\u\\AppData\\Local\\Roster\\gh';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roster-gh-runner-'));
  dirs.push(dir);
  return dir;
}

describe('ghEnv', () => {
  it('copies only allowlisted variables, then fixes the gh settings and adds the token', () => {
    const env = ghEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        LANG: 'C.UTF-8',
        EMPTY: '',
        GH_TOKEN: PARENT_TOKEN,
        GITHUB_TOKEN: PARENT_TOKEN,
        GH_ENTERPRISE_TOKEN: PARENT_TOKEN,
        GH_HOST: 'evil.example',
        GH_CONFIG_DIR: '/home/u/.config/gh',
        GH_PAGER: 'evil',
        GIT_DIR: '/evil',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake',
        TMP: undefined,
      },
      CONFIG_DIR,
      FAKE_TOKEN,
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      GH_CONFIG_DIR: CONFIG_DIR,
      GH_TOKEN: FAKE_TOKEN,
    });
  });

  it('has no secret, gh or git variable in its allowlist', () => {
    for (const name of PASS_THROUGH_ENV) expect(name).not.toMatch(/TOKEN|SECRET|KEY|^GIT|^GH_/);
    expect(FIXED_ENV).toEqual({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });
  });
});

describe('execFileGhRunner', () => {
  const run = execFileGhRunner({ program: process.execPath });

  it('passes exactly the given environment, the arguments and stdin', async () => {
    const env = ghEnv(process.env, CONFIG_DIR, FAKE_TOKEN);
    const script =
      'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.stringify(' +
      '{ token: process.env.GH_TOKEN, other: process.env.GITHUB_TOKEN ?? null, arg: process.argv[1], stdin: s })))';
    const output = await run({ args: ['-e', script, '--', '--marker'], env, cwd: tempDir(), input: '{"body":"--repo evil"}' });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({ token: FAKE_TOKEN, other: null, arg: '--marker', stdin: '{"body":"--repo evil"}' });
  });

  it('runs in the given directory', async () => {
    const cwd = tempDir();
    const output = await run({ args: ['-e', 'console.log(process.cwd())'], env: ghEnv(process.env, CONFIG_DIR, FAKE_TOKEN), cwd });
    expect(output.stdout.trim().toLowerCase()).toBe(cwd.toLowerCase());
  });

  it('resolves, not rejects, on a non-zero exit code', async () => {
    const output = await run({
      args: ['-e', 'process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1)'],
      env: ghEnv(process.env, CONFIG_DIR, FAKE_TOKEN),
      cwd: tempDir(),
    });
    expect(output).toEqual({ exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' });
  });

  it('rejects with ExternalCommandError without arguments or token when the program cannot start', async () => {
    const missing = execFileGhRunner({ program: 'roster-no-such-gh-binary' });
    const error = await missing({ args: ['api', FAKE_TOKEN], env: ghEnv(process.env, CONFIG_DIR, FAKE_TOKEN), cwd: tempDir() }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as ExternalCommandError).program).toBe('gh');
    expect((error as ExternalCommandError).exitCode).toBeNull();
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
  });

  it('kills the child at the timeout', async () => {
    const slow = execFileGhRunner({ program: process.execPath, timeoutMs: 300 });
    const error = await slow({
      args: ['-e', 'setTimeout(() => {}, 20000)'],
      env: ghEnv(process.env, CONFIG_DIR, FAKE_TOKEN),
      cwd: tempDir(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as Error).message).toContain('killed after');
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
  });
});
