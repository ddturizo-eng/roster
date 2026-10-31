// SecretsPort over Windows DPAPI, CurrentUser scope (ADR 0016, ADR 0029). Each secret is a file
// `<secrets dir>\<name>.dpapi` (default dir: `%LOCALAPPDATA%\Roster\secrets`). Encryption and
// decryption run in `powershell.exe -NoProfile -NonInteractive`; the value goes in through stdin
// (base64 of its UTF-8 bytes) and comes out through stdout, never through arguments. Errors never
// contain a value: PowerShell output is redacted against the values this adapter has handled.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ExternalCommandError, RosterError, SecretMissingError } from '../../../core/domain/errors.ts';
import type { SecretName, SecretsPort } from '../../../ports/secrets.ts';
import { redactSecrets } from './redact.ts';
import { execFilePowerShellRunner } from './runner.ts';
import type { PowerShellRunner } from './runner.ts';

/** An input would be invalid to store (unknown name, empty value). Names the field, never a value. */
export class SecretInputError extends RosterError {
  override readonly name = 'SecretInputError';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.field = field;
  }
}

const SET_COMMANDS: Readonly<Record<SecretName, string>> = {
  'claude-oauth-token': 'roster auth set claude',
  'github-token': 'roster auth set github',
};

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'] as const;

/** A PowerShell single-quoted literal: the only quoting used for data placed in a script. */
export function psQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Security',
];

/** Reads base64 of the value from stdin, encrypts it for the current user and writes the file. */
export function setScript(file: string): string {
  return [
    ...PRELUDE,
    `$path = ${psQuote(file)}`,
    '$plain = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    "$cipher = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')",
    '$dir = [System.IO.Path]::GetDirectoryName($path)',
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    "$tmp = $path + '.tmp'",
    '[System.IO.File]::WriteAllBytes($tmp, $cipher)',
    'Move-Item -Force -LiteralPath $tmp -Destination $path',
  ].join('\n');
}

/** Decrypts the file for the current user and writes base64 of the value to stdout. */
export function getScript(file: string): string {
  return [
    ...PRELUDE,
    `$path = ${psQuote(file)}`,
    '$cipher = [System.IO.File]::ReadAllBytes($path)',
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, 'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($plain))',
  ].join('\n');
}

export interface DpapiSecretsOptions {
  /** Secrets directory; defaults to `%LOCALAPPDATA%\Roster\secrets`. */
  readonly dir?: string;
  readonly runner?: PowerShellRunner;
  /** Environment used to find `LOCALAPPDATA`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class DpapiSecrets implements SecretsPort {
  readonly #dir: string;
  readonly #runner: PowerShellRunner;
  /** Values handled by this instance, redacted from error text. */
  readonly #known = new Set<string>();

  constructor(dir: string, runner: PowerShellRunner) {
    this.#dir = dir;
    this.#runner = runner;
  }

  #file(name: SecretName): string {
    if (!Object.hasOwn(SET_COMMANDS, name)) throw new SecretInputError('secret name', 'unknown secret');
    return join(this.#dir, `${name}.dpapi`);
  }

  async #run(script: string, input: string): Promise<string> {
    const out = await this.#runner({ args: [...POWERSHELL_ARGS, encodeScript(script)], input });
    if (out.exitCode !== 0) {
      const line =
        redactSecrets(out.stderr, this.#known)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== '')[0] ?? 'no output';
      // Control characters and length are limited; the text is also free of known values.
      const clean = line.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').slice(0, 200);
      throw new ExternalCommandError('powershell.exe', out.exitCode, clean);
    }
    return out.stdout;
  }

  async set(name: SecretName, value: string): Promise<void> {
    const file = this.#file(name);
    if (value.length === 0) throw new SecretInputError('secret value', 'must not be empty');
    this.#known.add(value);
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    this.#known.add(encoded);
    await this.#run(setScript(file), encoded);
  }

  async get(name: SecretName): Promise<string> {
    const file = this.#file(name);
    if (!existsSync(file)) throw new SecretMissingError(name, SET_COMMANDS[name]);
    const stdout = await this.#run(getScript(file), '');
    const value = Buffer.from(stdout.trim(), 'base64').toString('utf8');
    this.#known.add(value);
    return value;
  }

  async has(name: SecretName): Promise<boolean> {
    return existsSync(this.#file(name));
  }
}

/** The real adapter: files under `%LOCALAPPDATA%\Roster\secrets`, powershell.exe through execFile. */
export function createDpapiSecrets(options: DpapiSecretsOptions = {}): DpapiSecrets {
  let dir = options.dir;
  if (dir === undefined) {
    const localAppData = (options.env ?? process.env).LOCALAPPDATA;
    if (localAppData === undefined || localAppData === '') {
      throw new SecretInputError('LOCALAPPDATA', 'is not set; DPAPI secrets need a Windows user session');
    }
    dir = join(localAppData, 'Roster', 'secrets');
  }
  return new DpapiSecrets(dir, options.runner ?? execFilePowerShellRunner());
}
