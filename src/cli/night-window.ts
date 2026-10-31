// Night window of `config.json` (ADR 0015): local-time `HH:MM-HH:MM`, ending on the next day when
// the end is not after the start.

import type { NightWindow } from './config.ts';

function at(base: Date, dayOffset: number, hour: number, minute: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0);
}

/**
 * Start of the night window that contains `now`, or null when `now` is outside every window (a
 * manual run in the daytime). Works on local time, so a daylight-saving change moves the bounds with
 * the wall clock.
 */
export function currentWindowStart(now: Date, window: NightWindow): Date | null {
  const wraps =
    window.end.hour < window.start.hour ||
    (window.end.hour === window.start.hour && window.end.minute <= window.start.minute);
  for (const offset of [-1, 0]) {
    const start = at(now, offset, window.start.hour, window.start.minute);
    const end = at(now, offset + (wraps ? 1 : 0), window.end.hour, window.end.minute);
    if (start.getTime() <= now.getTime() && now.getTime() < end.getTime()) return start;
  }
  return null;
}
