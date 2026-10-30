// SecretsPort (ADR 0016, ADR 0029): secrets stored with Windows DPAPI under
// `%LOCALAPPDATA%\Roster\secrets\`. Values travel through stdin, never through arguments.

export type SecretName = 'claude-oauth-token' | 'github-token';

export interface SecretsPort {
  set(name: SecretName, value: string): Promise<void>;
  /** Rejects with SecretMissingError, naming the `roster auth set` command, when it is not stored. */
  get(name: SecretName): Promise<string>;
  /** For `doctor`: whether the secret is stored, without reading its value. */
  has(name: SecretName): Promise<boolean>;
}
