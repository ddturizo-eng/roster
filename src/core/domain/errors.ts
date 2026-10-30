// Typed errors with a stable `name`. Code branches on `instanceof` or `name`, never on the message.
//
// A secret value never appears in an error: no constructor here takes one, and adapters pass only
// names (of secrets, programs, refs), exit codes and English reasons they wrote themselves.

import type { ContractName } from './agent.ts';
import type { ValidationIssue } from './validation.ts';

/** Base class of every error Roster raises on purpose. */
export class RosterError extends Error {
  override readonly name: string = 'RosterError';
}

/** A result file does not match its contract (ADR 0026). */
export class ResultValidationError extends RosterError {
  override readonly name = 'ResultValidationError';
  readonly contract: ContractName;
  readonly issues: readonly ValidationIssue[];

  constructor(contract: ContractName, issues: readonly ValidationIssue[]) {
    const shown = issues
      .slice(0, 5)
      .map((issue) => `${issue.path} ${issue.message}`)
      .join('; ');
    const more = issues.length > 5 ? `; and ${issues.length - 5} more` : '';
    super(`Invalid ${contract} result: ${shown}${more}`);
    this.contract = contract;
    this.issues = issues;
  }
}

/** A state machine refused a transition (feature stages, task states). */
export class InvalidTransitionError extends RosterError {
  override readonly name = 'InvalidTransitionError';
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string, reason?: string) {
    super(`Invalid ${entity} transition from ${from} to ${to}${reason === undefined ? '' : `: ${reason}`}`);
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/** An entity that must exist does not. */
export class NotFoundError extends RosterError {
  override readonly name = 'NotFoundError';
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.entity = entity;
    this.id = id;
  }
}

/** A secret is not stored. Carries the secret's name only, never a value. */
export class SecretMissingError extends RosterError {
  override readonly name = 'SecretMissingError';
  readonly secret: string;
  readonly setCommand: string;

  /** `setCommand` is the command that stores it, for example `roster auth set claude`. */
  constructor(secret: string, setCommand: string) {
    super(`Secret ${secret} is not set. Run: ${setCommand}`);
    this.secret = secret;
    this.setCommand = setCommand;
  }
}

/** The push guard refused a push (ADR 0024, ADR 0025). */
export class PushRejectedError extends RosterError {
  override readonly name = 'PushRejectedError';
  readonly ref: string;

  constructor(ref: string, reason: string) {
    super(`Push of ${ref} rejected: ${reason}`);
    this.ref = ref;
  }
}

/** An external program (git, gh, docker, powershell) failed. */
export class ExternalCommandError extends RosterError {
  override readonly name = 'ExternalCommandError';
  /** Program name only, for example `git`; never the argument list. */
  readonly program: string;
  readonly exitCode: number | null;

  /** `reason` is written by the adapter and must already be redacted. */
  constructor(program: string, exitCode: number | null, reason: string) {
    super(`${program} failed (exit ${exitCode === null ? 'none' : exitCode}): ${reason}`);
    this.program = program;
    this.exitCode = exitCode;
  }
}

/** Docker is not reachable; `roster run` exits with code 2. */
export class DockerUnavailableError extends RosterError {
  override readonly name = 'DockerUnavailableError';
  readonly reason: string;

  constructor(reason: string) {
    super(`Docker is unavailable: ${reason}`);
    this.reason = reason;
  }
}

/** Machine config is invalid; lists every invalid or missing key (T03). */
export class ConfigError extends RosterError {
  override readonly name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid config: ${problems.join('; ')}`);
    this.problems = problems;
  }
}
