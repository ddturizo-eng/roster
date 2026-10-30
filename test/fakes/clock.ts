// Fake ClockPort: time stands still until a test advances it; `sleep` advances it without waiting.

import type { ClockPort } from '../../src/ports/clock.ts';
import { CallLog, Responses } from './recorder.ts';

export const FAKE_START_TIME = '2026-11-01T03:00:00.000Z';

export class FakeClock implements ClockPort {
  readonly log: CallLog;
  readonly responses = new Responses<ClockPort>();
  #now: number;

  constructor(start: string = FAKE_START_TIME, log: CallLog = new CallLog()) {
    this.#now = Date.parse(start);
    this.log = log;
  }

  now(): Date {
    this.log.record('clock', 'now', []);
    return this.responses.answer('now', [], () => new Date(this.#now));
  }

  async sleep(ms: number): Promise<void> {
    this.log.record('clock', 'sleep', [ms]);
    this.responses.answer('sleep', [ms], () => {
      this.#now += ms;
    });
  }

  /** Moves time forward without recording a call. */
  advance(ms: number): void {
    this.#now += ms;
  }

  /** Sets the current time without recording a call. */
  set(iso: string): void {
    this.#now = Date.parse(iso);
  }

  /** Current time as ISO 8601 UTC, without recording a call. */
  iso(): string {
    return new Date(this.#now).toISOString();
  }
}
