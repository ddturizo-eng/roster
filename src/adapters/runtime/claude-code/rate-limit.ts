// Parsing of Claude Code's `rate_limit_event` lines (ADR 0030, spike T14 finding 6). Shared by
// `interpret` and, later, the activity reducer of `roster watch` (ADR 0031, T41), so the format is
// read in one place.
//
// Shape observed with CLI 2.1.314 (fixture `success-pong.jsonl`):
//   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793410800,
//    "rateLimitType":"five_hour",...,"unifiedWindows":{
//      "five_hour":{"utilization":0.04,"resetsAt":1793410800,"status":"allowed"},
//      "seven_day":{"utilization":0.6,"resetsAt":1793617200,"status":"allowed"}}}}
// `resetsAt` is epoch seconds, `utilization` a fraction. The log is untrusted (whatever runs inside
// the container as uid 1000 can write to the CLI's stdout): every field is checked, anything missing
// or malformed is left out, and nothing here throws.

import type { RateLimitSnapshot, RateLimitWindow } from '../../../core/domain/runtime.ts';

/** `unifiedWindows` keys stored in the snapshot (ADR 0030). */
export const FIVE_HOUR_WINDOW = 'five_hour';
export const SEVEN_DAY_WINDOW = 'seven_day';

/** Status and window names: short identifiers only, so nothing odd reaches the store or a terminal. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Upper bound for an epoch-seconds value (year 9999). */
const MAX_EPOCH_SECONDS = 253_402_300_799;

/** One window of `unifiedWindows`, already converted. */
export interface ParsedWindow {
  readonly name: string;
  readonly utilization?: number;
  /** ISO 8601 UTC. */
  readonly resetsAt?: string;
}

/** Everything `interpret` needs from one `rate_limit_event`. */
export interface ParsedRateLimit {
  readonly snapshot: RateLimitSnapshot;
  /** Top-level `rate_limit_info.resetsAt`, ISO 8601 UTC. */
  readonly resetsAt?: string;
  /** Every well-formed entry of `unifiedWindows`, in log order. */
  readonly windows: readonly ParsedWindow[];
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function name(value: unknown): string | undefined {
  return typeof value === 'string' && NAME.test(value) ? value : undefined;
}

/** Epoch seconds to ISO 8601 UTC; undefined for anything that is not a plausible time. */
export function epochSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_EPOCH_SECONDS) return undefined;
  return new Date(Math.round(value * 1000)).toISOString();
}

function utilization(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseWindow(windowName: string, value: unknown): ParsedWindow | undefined {
  if (!isObject(value)) return undefined;
  const used = utilization(value.utilization);
  const resetsAt = epochSecondsToIso(value.resetsAt);
  return {
    name: windowName,
    ...(used === undefined ? {} : { utilization: used }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function snapshotWindow(window: ParsedWindow | undefined): RateLimitWindow | undefined {
  if (window === undefined || (window.utilization === undefined && window.resetsAt === undefined)) return undefined;
  return {
    ...(window.utilization === undefined ? {} : { utilization: window.utilization }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
}

/** True for a parsed `stream-json` line whose `type` is `rate_limit_event`. */
export function isRateLimitEvent(line: unknown): boolean {
  return isObject(line) && line.type === 'rate_limit_event';
}

/**
 * Parses one `rate_limit_event` line (already `JSON.parse`d). Returns undefined when the line is not
 * a `rate_limit_event`; otherwise a snapshot observed at `observedAt` with every valid field, possibly
 * none besides `observedAt`.
 */
export function parseRateLimitEvent(line: unknown, observedAt: string): ParsedRateLimit | undefined {
  if (!isObject(line) || line.type !== 'rate_limit_event') return undefined;
  const info = isObject(line.rate_limit_info) ? line.rate_limit_info : {};
  const status = name(info.status);
  const limitType = name(info.rateLimitType);
  const resetsAt = epochSecondsToIso(info.resetsAt);

  const windows: ParsedWindow[] = [];
  if (isObject(info.unifiedWindows)) {
    for (const [windowName, value] of Object.entries(info.unifiedWindows)) {
      if (name(windowName) === undefined) continue;
      const window = parseWindow(windowName, value);
      if (window !== undefined) windows.push(window);
    }
  }
  const fiveHour = snapshotWindow(windows.find((window) => window.name === FIVE_HOUR_WINDOW));
  const sevenDay = snapshotWindow(windows.find((window) => window.name === SEVEN_DAY_WINDOW));

  const snapshot: RateLimitSnapshot = {
    ...(status === undefined ? {} : { status }),
    ...(limitType === undefined ? {} : { limitType }),
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    observedAt,
  };
  return { snapshot, ...(resetsAt === undefined ? {} : { resetsAt }), windows };
}

/** Reset time of an exhausted quota and the window it belongs to (ADR 0030 decision 1). */
export interface QuotaReset {
  readonly resetsAt: string;
  readonly window: string;
}

/**
 * The latest `resetsAt` among (a) the window named by `rateLimitType` (its `unifiedWindows` entry,
 * else the top-level `resetsAt`) and (b) every window with `utilization >= 1`. Undefined when none of
 * them has a reset time. No fallback: the orchestrator applies `quotaCooldownMinutes` (ADR 0030).
 */
export function quotaReset(parsed: ParsedRateLimit | undefined): QuotaReset | undefined {
  if (parsed === undefined) return undefined;
  const candidates: QuotaReset[] = [];
  const named = parsed.snapshot.limitType;
  if (named !== undefined) {
    const entry = parsed.windows.find((window) => window.name === named);
    const resetsAt = entry?.resetsAt ?? parsed.resetsAt;
    if (resetsAt !== undefined) candidates.push({ resetsAt, window: named });
  }
  for (const window of parsed.windows) {
    if (window.utilization !== undefined && window.utilization >= 1 && window.resetsAt !== undefined) {
      candidates.push({ resetsAt: window.resetsAt, window: window.name });
    }
  }
  let latest: QuotaReset | undefined;
  for (const candidate of candidates) {
    // ISO 8601 UTC strings of the same format compare in time order. Ties keep the first (named).
    if (latest === undefined || candidate.resetsAt > latest.resetsAt) latest = candidate;
  }
  return latest;
}
