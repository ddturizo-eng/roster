// Line-by-line job log writer (ADR 0031). Output chunks are split into complete lines; each line is
// redacted and appended as soon as it is complete, and an unterminated last line is redacted and
// flushed by `close`. A secret split across two chunks is therefore still redacted.
//
// Apart from redaction, a line is written exactly as the job produced it, followed by `\n`. Nothing
// else is written into the file.
//
// The file is opened in append mode and kept open while the job runs; every line is one `writeSync`,
// so another process sees it at once. Node opens files on Windows with shared read, write and delete
// access (libuv default), so `roster watch` can read the file while it is written and retention can
// delete it later.

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { longestSecret, secretRedactor } from './redact.ts';

/**
 * Longest unterminated text kept in memory. Beyond it, the redacted head of the pending text is
 * written without a line break (the line continues in the file) and only a tail as long as the
 * longest secret is kept, so a job printing a huge line without newline cannot exhaust memory and a
 * secret crossing the cut is still caught.
 */
export const MAX_PENDING_CHARS = 8 * 1024 * 1024;

export interface LineLogWriterOptions {
  /** Secret values replaced by `[redacted]` in every line. */
  readonly secrets: readonly string[];
  /** Called with each complete, redacted line (without its line break). */
  readonly onLine?: (line: string) => void;
  /** Overrides MAX_PENDING_CHARS; for tests. */
  readonly maxPendingChars?: number;
}

export class LineLogWriter {
  readonly path: string;
  readonly #fd: number;
  readonly #decoder = new StringDecoder('utf8');
  readonly #redact: (text: string) => string;
  readonly #keep: number;
  readonly #maxPending: number;
  readonly #onLine: ((line: string) => void) | undefined;
  #pending = '';
  #closed = false;

  constructor(path: string, options: LineLogWriterOptions) {
    this.path = path;
    this.#redact = secretRedactor(options.secrets);
    this.#keep = Math.max(longestSecret(options.secrets) - 1, 0);
    this.#maxPending = Math.max(options.maxPendingChars ?? MAX_PENDING_CHARS, this.#keep + 1);
    this.#onLine = options.onLine;
    mkdirSync(dirname(path), { recursive: true });
    this.#fd = openSync(path, 'a');
  }

  /** Adds a chunk of output; writes every line it completes. */
  write(chunk: Buffer | string): void {
    if (this.#closed) return;
    this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    this.#drain();
  }

  /** Flushes an unterminated last line (redacted, with a line break) and closes the file. */
  close(): void {
    if (this.#closed) return;
    this.#pending += this.#decoder.end();
    this.#drain();
    if (this.#pending.length > 0) this.#emit(this.#pending);
    this.#pending = '';
    this.#closed = true;
    closeSync(this.#fd);
  }

  #drain(): void {
    let newline = this.#pending.indexOf('\n');
    while (newline !== -1) {
      this.#emit(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf('\n');
    }
    if (this.#pending.length > this.#maxPending) {
      // Every secret wholly inside the pending text is replaced first; one that is still incomplete
      // must start inside the kept tail, so it is caught when the rest of it arrives.
      const redacted = this.#redact(this.#pending);
      const cut = redacted.length - this.#keep;
      writeSync(this.#fd, redacted.slice(0, cut));
      this.#pending = redacted.slice(cut);
    }
  }

  #emit(line: string): void {
    const redacted = this.#redact(line);
    writeSync(this.#fd, `${redacted}\n`);
    this.#onLine?.(redacted);
  }
}
