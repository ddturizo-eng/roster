import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FIXED_ENV, PASS_THROUGH_ENV, execFileGitRunner, gitEnv } from '../../../../src/adapters/vcs/git/index.ts';
import { ExternalCommandError } from '../../../../src/core/domain/errors.ts';

const FAKE_TOKEN = 'ghp_FAKE0000000000000000000000000000000';

describe('gitEnv', () => {
  it('copies only allowlisted variables and always disables prompts', () => {
    const env = gitEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      EMPTY: '',
      GH_TOKEN: FAKE_TOKEN,
      GITHUB_TOKEN: FAKE_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake',
      GIT_DIR: '/evil',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'",
      GIT_SSH_COMMAND: 'evil',
      GIT_ASKPASS: 'evil',
      TMP: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' });
  });

  it('adds per-call variables last', () => {
    expect(gitEnv({ PATH: '/bin' }, { GH_TOKEN: FAKE_TOKEN })).toEqual({
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
      GH_TOKEN: FAKE_TOKEN,
    });
  });

  it('has no secret or git variable in its allowlist', () => {
    for (const name of PASS_THROUGH_ENV) expect(name).not.toMatch(/TOKEN|SECRET|KEY|^GIT_|^GH_/);
    expect(FIXED_ENV).toEqual({ GIT_TERMINAL_PROMPT: '0' });
  });
});

describe('execFileGitRunner', () => {
  const env = gitEnv(process.env);

  it('resolves with exit code 0 and stdout', async () => {
    const output = await execFileGitRunner()({ args: ['--version'], env, cwd: tmpdir() });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toMatch(/^git version /);
  });

  it('resolves, not rejects, on a non-zero exit code', async () => {
    const output = await execFileGitRunner()({ args: ['--git-dir=/nonexistent-roster', 'rev-parse', 'HEAD'], env, cwd: tmpdir() });
    expect(output.exitCode).not.toBe(0);
  });

  it('passes stdin', async () => {
    const output = await execFileGitRunner()({ args: ['hash-object', '--stdin'], env, cwd: tmpdir(), input: 'hello\n' });
    expect(output.stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('rejects with ExternalCommandError when the program cannot start', async () => {
    const run = execFileGitRunner({ program: 'roster-no-such-git-binary' });
    const error = await run({ args: ['status', FAKE_TOKEN], env, cwd: tmpdir() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as ExternalCommandError).exitCode).toBeNull();
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
  });

  it('kills the child at the timeout', async () => {
    const run = execFileGitRunner({ program: process.execPath, timeoutMs: 300 });
    const error = await run({ args: ['-e', 'setTimeout(() => {}, 20000)'], env, cwd: tmpdir() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as Error).message).toContain('killed after');
  });
});
