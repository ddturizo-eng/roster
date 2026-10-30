// Fake SecretsPort: an in-memory map. Recorded calls never contain a secret value.

import { SecretMissingError } from '../../src/core/domain/errors.ts';
import type { SecretName, SecretsPort } from '../../src/ports/secrets.ts';
import { CallLog, Responses } from './recorder.ts';

export const REDACTED = '[redacted]';

const SET_COMMANDS: Readonly<Record<SecretName, string>> = {
  'claude-oauth-token': 'roster auth set claude',
  'github-token': 'roster auth set github',
};

export class FakeSecrets implements SecretsPort {
  readonly log: CallLog;
  readonly responses = new Responses<SecretsPort>();
  readonly values = new Map<SecretName, string>();

  constructor(initial: Partial<Readonly<Record<SecretName, string>>> = {}, log: CallLog = new CallLog()) {
    for (const [name, value] of Object.entries(initial) as [SecretName, string][]) this.values.set(name, value);
    this.log = log;
  }

  async set(name: SecretName, value: string): Promise<void> {
    this.log.record('secrets', 'set', [name, REDACTED]);
    this.responses.answer('set', [name, value], () => {
      this.values.set(name, value);
    });
  }

  async get(name: SecretName): Promise<string> {
    this.log.record('secrets', 'get', [name]);
    return this.responses.answer('get', [name], () => {
      const value = this.values.get(name);
      if (value === undefined) throw new SecretMissingError(name, SET_COMMANDS[name]);
      return value;
    });
  }

  async has(name: SecretName): Promise<boolean> {
    this.log.record('secrets', 'has', [name]);
    return this.responses.answer('has', [name], () => this.values.has(name));
  }
}
