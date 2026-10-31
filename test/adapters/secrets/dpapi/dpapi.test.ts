import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDpapiSecrets,
  DpapiSecrets,
  execFilePowerShellRunner,
  psQuote,
  redactSecrets,
  SecretInputError,
} from '../../../../src/adapters/secrets/dpapi/index.ts';
import type { PowerShellCall, PowerShellOutput } from '../../../../src/adapters/secrets/dpapi/index.ts';
import { ExternalCommandError, SecretMissingError } from '../../../../src/core/domain/errors.ts';

const DUMMY = 'sk-ant-oat01-DUMMYvalue-0000000000';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "roster-dpapi-o'brien-"));
  dirs.push(dir);
  return dir;
}

function stub(output: Partial<PowerShellOutput> = {}) {
  const calls: PowerShellCall[] = [];
  const runner = async (call: PowerShellCall): Promise<PowerShellOutput> => {
    calls.push(call);
    return { exitCode: 0, stdout: '', stderr: '', ...output };
  };
  return { calls, runner };
}

function decodedScript(call: PowerShellCall): string {
  return Buffer.from(call.args[call.args.length - 1] ?? '', 'base64').toString('utf16le');
}

describe('DpapiSecrets.set', () => {
  it('runs powershell with fixed flags, the value only on stdin', async () => {
    const dir = tempDir();
    const { calls, runner } = stub();
    await new DpapiSecrets(dir, runner).set('claude-oauth-token', DUMMY);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(call.args[4]).toBe('-EncodedCommand');
    expect(call.args).toHaveLength(6);
    const base64 = Buffer.from(DUMMY, 'utf8').toString('base64');
    expect(call.input).toBe(base64);
    for (const arg of call.args) {
      expect(arg).not.toContain(DUMMY);
      expect(arg).not.toContain(base64);
    }
    const script = decodedScript(call);
    expect(script).not.toContain(DUMMY);
    expect(script).not.toContain(base64);
    expect(script).toContain("'CurrentUser'");
    expect(script).toContain(psQuote(join(dir, 'claude-oauth-token.dpapi')));
  });

  it('rejects an empty value and an unknown name without running powershell', async () => {
    const { calls, runner } = stub();
    const secrets = new DpapiSecrets(tempDir(), runner);
    await expect(secrets.set('github-token', '')).rejects.toBeInstanceOf(SecretInputError);
    await expect(secrets.set('../evil' as 'github-token', DUMMY)).rejects.toBeInstanceOf(SecretInputError);
    expect(calls).toHaveLength(0);
  });

  it('maps a failure to ExternalCommandError with the value redacted', async () => {
    const { runner } = stub({ exitCode: 1, stderr: `boom ${DUMMY} happened\nsecond line` });
    const error = await new DpapiSecrets(tempDir(), runner).set('github-token', DUMMY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCommandError);
    const message = (error as Error).message;
    expect(message).toContain('exit 1');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain(DUMMY);
  });
});

describe('DpapiSecrets.get and has', () => {
  it('raises SecretMissingError naming the roster auth set command when the file is absent', async () => {
    const { calls, runner } = stub();
    const secrets = new DpapiSecrets(tempDir(), runner);
    const error = await secrets.get('claude-oauth-token').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretMissingError);
    expect((error as Error).message).toContain('roster auth set claude');
    const github = await secrets.get('github-token').catch((e: unknown) => e);
    expect((github as Error).message).toContain('roster auth set github');
    expect(await secrets.has('github-token')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('decodes the base64 stdout of powershell and has() does not run it', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'github-token.dpapi'), 'ciphertext');
    const { calls, runner } = stub({ stdout: Buffer.from(DUMMY, 'utf8').toString('base64') });
    const secrets = new DpapiSecrets(dir, runner);
    expect(await secrets.has('github-token')).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await secrets.get('github-token')).toBe(DUMMY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe('');
    expect(calls[0]!.args.join(' ')).not.toContain(DUMMY);
  });
});

describe('createDpapiSecrets', () => {
  it('uses %LOCALAPPDATA%\\Roster\\secrets and refuses to guess without LOCALAPPDATA', async () => {
    expect(() => createDpapiSecrets({ env: {} })).toThrow(SecretInputError);
    const { calls, runner } = stub();
    await createDpapiSecrets({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, runner }).set('github-token', DUMMY);
    expect(decodedScript(calls[0]!)).toContain(psQuote(join('C:\\Users\\u\\AppData\\Local', 'Roster', 'secrets', 'github-token.dpapi')));
  });
});

describe('psQuote', () => {
  it('doubles single quotes so text stays one literal', () => {
    expect(psQuote("a'b")).toBe("'a''b'");
  });
});

describe('redactSecrets', () => {
  it('replaces every known value, longest first, and ignores empty values', () => {
    expect(redactSecrets('a abc b abc', ['abc', 'a', ''])).toBe('[redacted] [redacted] b [redacted]');
    expect(redactSecrets('nothing', [DUMMY])).toBe('nothing');
  });
});

describe('execFilePowerShellRunner', () => {
  it('passes args as an array and input through stdin (node stands in for powershell)', async () => {
    const run = execFilePowerShellRunner({ program: process.execPath });
    const script = "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))";
    const out = await run({ args: ['-e', script], input: 'abc' });
    expect(out).toEqual({ exitCode: 0, stdout: 'ABC', stderr: '' });
  });

  it('resolves with a non-zero exit code and rejects when the program cannot run', async () => {
    const node = execFilePowerShellRunner({ program: process.execPath });
    expect((await node({ args: ['-e', 'process.exit(3)'], input: '' })).exitCode).toBe(3);
    const missing = execFilePowerShellRunner({ program: join(tmpdir(), 'does-not-exist-roster.exe') });
    await expect(missing({ args: [], input: DUMMY })).rejects.toBeInstanceOf(ExternalCommandError);
  });
});

describe.skipIf(process.platform !== 'win32')('DPAPI round trip (Windows)', () => {
  it('stores and reads a dummy value with the real powershell.exe', async () => {
    const dir = join(tempDir(), 'secrets');
    const secrets = createDpapiSecrets({ dir });
    const value = 'dummy-ünï-value-0123';
    expect(await secrets.has('github-token')).toBe(false);
    await secrets.set('github-token', value);
    expect(await secrets.has('github-token')).toBe(true);
    expect(await secrets.get('github-token')).toBe(value);
    const raw = (await import('node:fs')).readFileSync(join(dir, 'github-token.dpapi'));
    expect(raw.includes(Buffer.from(value, 'utf8'))).toBe(false);
  }, 60_000);
});
