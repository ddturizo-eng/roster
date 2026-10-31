// Outcome of a Claude Code job from its exit and its `stream-json` log (ADR 0022, ADR 0028, ADR 0030,
// ADR 0031, spike T14 findings 2, 4 and 6).
//
// The log is the job's stdout only (`<job>.jsonl`, redacted by the sandbox). It is untrusted: whatever
// runs inside the container as uid 1000 can write lines to the CLI's stdout. So only top-level fields
// of whole lines count, `reason` is always text written here (never log text), and a faked outcome
// gains nothing that the checks after `interpret` do not catch: `completed` still needs a valid
// `/roster/out/result.json` and the policy check (orchestrator), `quota_exhausted` still goes through
// the policy check and the push guard (ADR 0028).
//
// Precedence:
// 1. `stopped`: the human or `roster stop` ended the job (exit.stopped).
// 2. `quota_exhausted`: a quota pattern (`QUOTA_PATTERNS`) in the final result when it is an error,
//    or, when the job has no successful result, in an API error message of the CLI. A recognized quota
//    signal wins over a timeout, so the work is kept as WIP and the runtime cools down (ADR 0028).
// 3. `timeout`: the sandbox killed the job at its timeout (exit.timedOut).
// 4. The last `result` line: `success` with `is_error` false is `completed`, whatever the exit code;
//    `error_max_turns` is `error` with reason `turn limit` (finding 2: it exits 1, which alone is not
//    a crash); any other result, or no result at all, is `error`. Real exhaustion was never observed
//    (H5), so a missed quota signal ends as `error`, never as `completed`.
// Whatever the outcome, `detail.rateLimit` is the last `rate_limit_event` (ADR 0030).

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ContainerExit, RuntimeOutcome, RuntimeOutcomeDetail } from '../../../core/domain/runtime.ts';
import { parseRateLimitEvent, quotaReset } from './rate-limit.ts';
import type { ParsedRateLimit } from './rate-limit.ts';

/**
 * Quota exhaustion patterns: the only place they live (plan 002 H5, ADR 0030 decision 3). Matched
 * against the text of an error `result` (`result` and `errors[]`) and of CLI API error messages
 * (`assistant` lines with a top-level `error`), never against model text or tool output.
 * - `usage limit reached`: the subscription limit message of earlier CLI versions
 *   (`Claude AI usage limit reached|<epoch>`);
 * - `you've hit your ... limit`: the current subscription limit message (`You've hit your limit`,
 *   `You've hit your weekly limit`);
 * - `<window> limit reached`: per-window wording (`5-hour limit reached`, `Weekly limit reached`).
 * Unverified against a real exhaustion (spike T14, H5): T24, T29 and T40 confirm or extend them.
 */
export const QUOTA_PATTERNS: readonly RegExp[] = [
  /\busage limit reached\b/i,
  /\byou(?:'|’)ve hit your (?:[a-z0-9-]+ )?limit\b/i,
  /\b(?:5-hour|five-hour|session|daily|weekly|opus|sonnet) limit reached\b/i,
];

/** Logs above this size are read from the end: the result and the last events are there. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;

/** Text examined per field when matching quota patterns. */
const MAX_MATCH_TEXT = 2000;

/** Fixed English reasons (`RuntimeOutcomeDetail.reason`). Never log or agent text. */
export const OUTCOME_REASONS = {
  stopped: 'stopped',
  quota: 'quota exhausted',
  timeout: 'timeout',
  turnLimit: 'turn limit',
  duringExecution: 'error during execution',
  resultError: 'result reported an error',
  unknownResult: 'unknown result',
  noResult: 'no result in the log',
} as const;

interface ResultLine {
  readonly subtype?: string;
  readonly isError: boolean;
  /** `result` and `errors[]` text, for quota matching only. */
  readonly texts: readonly string[];
}

/** What `interpret` keeps from a log. */
export interface StreamSummary {
  /** The last `result` line. */
  readonly result?: ResultLine;
  /** The last `rate_limit_event`. */
  readonly rateLimit?: ParsedRateLimit;
  /** True when an API error message of the CLI matched a quota pattern. */
  readonly apiQuotaError: boolean;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when any text matches a quota pattern. */
export function matchesQuota(texts: readonly string[]): boolean {
  return texts.some((text) => {
    const head = text.slice(0, MAX_MATCH_TEXT);
    return QUOTA_PATTERNS.some((pattern) => pattern.test(head));
  });
}

function resultLine(line: Readonly<Record<string, unknown>>): ResultLine {
  const texts: string[] = [];
  if (typeof line.result === 'string') texts.push(line.result);
  if (Array.isArray(line.errors)) for (const error of line.errors) if (typeof error === 'string') texts.push(error);
  return {
    ...(typeof line.subtype === 'string' ? { subtype: line.subtype } : {}),
    isError: line.is_error !== false,
    texts,
  };
}

/** Text items of an `assistant` line that the CLI marked as an API error (top-level `error`). */
function apiErrorTexts(line: Readonly<Record<string, unknown>>): string[] {
  if (line.error === undefined && line.isApiErrorMessage !== true) return [];
  const texts: string[] = [];
  const message = isObject(line.message) ? line.message : {};
  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (isObject(item) && item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
    }
  }
  return texts;
}

/** Reads a whole log, or its last `MAX_LOG_BYTES` from the first complete line. Missing: empty. */
export function readLogTail(logPath: string, maxBytes: number = MAX_LOG_BYTES): string {
  let fd: number;
  try {
    fd = openSync(logPath, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, size - length + read);
      if (count === 0) break;
      read += count;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (length < size) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/** Parses the lines of a `stream-json` log. Malformed and unknown lines are skipped; never throws. */
export function summarizeStream(text: string, observedAt: string): StreamSummary {
  let result: ResultLine | undefined;
  let rateLimit: ParsedRateLimit | undefined;
  let apiQuotaError = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    switch (parsed.type) {
      case 'result':
        result = resultLine(parsed);
        break;
      case 'rate_limit_event':
        rateLimit = parseRateLimitEvent(parsed, observedAt);
        break;
      case 'assistant':
        if (matchesQuota(apiErrorTexts(parsed))) apiQuotaError = true;
        break;
      default:
        break;
    }
  }
  return {
    ...(result === undefined ? {} : { result }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    apiQuotaError,
  };
}

function quotaExhausted(summary: StreamSummary): boolean {
  const result = summary.result;
  if (result !== undefined && result.isError && matchesQuota(result.texts)) return true;
  const succeeded = result !== undefined && !result.isError && result.subtype === 'success';
  return !succeeded && summary.apiQuotaError;
}

function resultOutcome(result: ResultLine | undefined, exitCode: number | null): { kind: 'completed' | 'error'; reason?: string } {
  if (result === undefined) {
    const code = Number.isInteger(exitCode) ? `exit code ${String(exitCode)}` : 'no exit code';
    return { kind: 'error', reason: `${OUTCOME_REASONS.noResult} (${code})` };
  }
  if (result.subtype === 'success') return result.isError ? { kind: 'error', reason: OUTCOME_REASONS.resultError } : { kind: 'completed' };
  if (result.subtype === 'error_max_turns') return { kind: 'error', reason: OUTCOME_REASONS.turnLimit };
  if (result.subtype === 'error_during_execution') return { kind: 'error', reason: OUTCOME_REASONS.duringExecution };
  return { kind: 'error', reason: OUTCOME_REASONS.unknownResult };
}

/** When the snapshot was observed: the job's end as reported by the sandbox, else now. */
function observedAtOf(exit: ContainerExit): string {
  const ended = typeof exit.endedAt === 'string' ? Date.parse(exit.endedAt) : Number.NaN;
  return new Date(Number.isNaN(ended) ? Date.now() : ended).toISOString();
}

/** Maps a job's exit and log to an outcome (see the header for the rules). */
export function interpretJob(exit: ContainerExit, logPath: string): RuntimeOutcome {
  const summary = summarizeStream(readLogTail(logPath), observedAtOf(exit));
  const rateLimit = summary.rateLimit?.snapshot;
  const base: RuntimeOutcomeDetail = rateLimit === undefined ? {} : { rateLimit };

  if (exit.stopped === true) return { kind: 'stopped', detail: { ...base, reason: OUTCOME_REASONS.stopped } };
  if (quotaExhausted(summary)) {
    const reset = quotaReset(summary.rateLimit);
    return {
      kind: 'quota_exhausted',
      detail: {
        ...base,
        reason: OUTCOME_REASONS.quota,
        ...(reset === undefined ? {} : { quotaResetsAt: reset.resetsAt, quotaWindow: reset.window }),
      },
    };
  }
  if (exit.timedOut === true) return { kind: 'timeout', detail: { ...base, reason: OUTCOME_REASONS.timeout } };
  const outcome = resultOutcome(summary.result, exit.exitCode);
  if (outcome.kind === 'completed') return { kind: 'completed', detail: base };
  return { kind: 'error', detail: { ...base, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) } };
}
