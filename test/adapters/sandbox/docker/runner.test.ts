import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FIXED_ENV, PASS_THROUGH_ENV, dockerEnv, execFileDockerRunner } from '../../../../src/adapters/sandbox/docker/index.ts';
import { ExternalCommandError } from '../../../../src/core/domain/errors.ts';

const FAKE_TOKEN = 'sk-ant-oat01-FAKE0123456789abcdefFAKE0123456789';

describe('dockerEnv', () => {
  it('copies only allowlisted variables, then fixed values, then per-call values', () => {
    const env = dockerEnv(
      {
        PATH: 'C:\\Windows',
        DOCKER_CONTEXT: 'desktop-linux',
        EMPTY: '',
        GH_TOKEN: 'ghp_x',
        GITHUB_TOKEN: 'ghp_x',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-parent',
        HTTPS_PROXY: 'http://corp:8080',
        HTTP_PROXY: 'http://corp:8080',
        NODE_OPTIONS: '--require x',
        TMP: undefined,
      },
      { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
    );
    expect(env).toEqual({
      PATH: 'C:\\Windows',
      DOCKER_CONTEXT: 'desktop-linux',
      DOCKER_CLI_HINTS: 'false',
      NO_COLOR: '1',
      CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
    });
  });

  it('has no secret, proxy or GitHub variable in its allowlist', () => {
    for (const name of PASS_THROUGH_ENV) expect(name).not.toMatch(/TOKEN|SECRET|KEY|PROXY|^GH_|^GITHUB_|^CLAUDE|^NODE_/);
    expect(FIXED_ENV).toEqual({ DOCKER_CLI_HINTS: 'false', NO_COLOR: '1' });
  });
});

describe('execFileDockerRunner', () => {
  const node = execFileDockerRunner({ program: process.execPath });
  const env = dockerEnv(process.env);

  it('exec resolves with exit code and output, whatever the exit code', async () => {
    const ok = await node.exec({ args: ['-e', 'process.stdout.write("out")'], env, cwd: tmpdir(), timeoutMs: 10_000 });
    expect(ok).toEqual({ exitCode: 0, stdout: 'out', stderr: '' });
    const failed = await node.exec({ args: ['-e', 'process.stderr.write("err"); process.exit(3)'], env, cwd: tmpdir(), timeoutMs: 10_000 });
    expect(failed).toEqual({ exitCode: 3, stdout: '', stderr: 'err' });
  });

  it('exec passes exactly the given environment', async () => {
    const output = await node.exec({
      args: ['-e', 'process.stdout.write(JSON.stringify([process.env.ROSTER_X ?? null, process.env.GH_TOKEN ?? null]))'],
      env: { ...env, ROSTER_X: 'y' },
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });
    expect(JSON.parse(output.stdout)).toEqual(['y', null]);
  });

  it('exec rejects at the timeout without arguments in the message', async () => {
    const error = await node.exec({ args: ['-e', 'setTimeout(() => {}, 20000)', FAKE_TOKEN], env, cwd: tmpdir(), timeoutMs: 300 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as Error).message).toContain('killed after');
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
  });

  it('exec and spawn reject when the program cannot start', async () => {
    const missing = execFileDockerRunner({ program: 'roster-no-such-docker-binary' });
    const error = await missing.exec({ args: [FAKE_TOKEN], env, cwd: tmpdir(), timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as Error).message).not.toContain(FAKE_TOKEN);
    const child = missing.spawn({ args: [FAKE_TOKEN], env, cwd: tmpdir(), input: '', onStdout: () => undefined, onStderr: () => undefined });
    const spawnError = await child.exited.catch((e: unknown) => e);
    expect(spawnError).toBeInstanceOf(ExternalCommandError);
    expect((spawnError as Error).message).not.toContain(FAKE_TOKEN);
  });

  it('spawn streams stdout and stderr separately, passes stdin and resolves after all output', async () => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = node.spawn({
      args: [
        '-e',
        'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write("got:"+s);process.stderr.write("e");process.exitCode=4;});',
      ],
      env,
      cwd: tmpdir(),
      input: 'prompt\n',
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });
    expect(await child.exited).toBe(4);
    expect(Buffer.concat(out).toString()).toBe('got:prompt\n');
    expect(Buffer.concat(err).toString()).toBe('e');
  });

  it('spawn kill ends the process', async () => {
    const child = node.spawn({
      args: ['-e', 'setTimeout(() => {}, 20000)'],
      env,
      cwd: tmpdir(),
      input: '',
      onStdout: () => undefined,
      onStderr: () => undefined,
    });
    setTimeout(() => child.kill(), 100);
    const code = await child.exited;
    expect(code === null || code !== 0).toBe(true);
  });
});
