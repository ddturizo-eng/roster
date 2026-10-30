// ClockPort: time for the core, so tests control it (cooldowns, night windows, stop waits).

export interface ClockPort {
  now(): Date;
  sleep(ms: number): Promise<void>;
}
