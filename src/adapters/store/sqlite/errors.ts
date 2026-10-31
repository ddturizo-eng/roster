// Typed errors of the SQLite store. They name the operation and the SQLite error code, never row
// content, because rows can hold task text or approval details.

import { RosterError } from '../../../core/domain/errors.ts';

/** The database file could not be opened or configured. */
export class StoreOpenError extends RosterError {
  override readonly name = 'StoreOpenError';
  readonly code: string | null;

  constructor(reason: string, code: string | null = null) {
    super(`Cannot open the store: ${reason}`);
    this.code = code;
  }
}

/** A migration failed or the database is newer than this build. The transaction was rolled back. */
export class StoreMigrationError extends RosterError {
  override readonly name = 'StoreMigrationError';
  readonly version: number | null;

  constructor(reason: string, version: number | null = null) {
    super(`Store migration failed${version === null ? '' : ` at version ${version}`}: ${reason}`);
    this.version = version;
  }
}

/** A store operation failed (constraint, locked database, closed store). */
export class StoreOperationError extends RosterError {
  override readonly name = 'StoreOperationError';
  readonly operation: string;
  /** SQLite error name such as `ERR_SQLITE_ERROR`, or null. */
  readonly code: string | null;

  constructor(operation: string, code: string | null, options?: { readonly cause?: unknown }) {
    super(`Store operation ${operation} failed${code === null ? '' : ` (${code})`}`, options);
    this.operation = operation;
    this.code = code;
  }
}
