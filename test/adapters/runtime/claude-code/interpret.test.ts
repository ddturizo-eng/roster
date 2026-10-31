import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  OUTCOME_REASONS,
  QUOTA_PATTERNS,
  createClaudeCodeRuntime,
  epochSecondsToIso,
  interpretJob,
  matchesQuota,
  parseRateLimitEvent,
  quotaReset,
  readLogTail,
  summarizeStream,
} from '../../../../src/adapters/runtime/claude-code/index.ts';
import type { ContainerExit } from '../../../../src/core/domain/runtime.ts';

// `interpret` (ADR 0022, 0028, 0030, spike T14 findings 2, 4 and 6) with the spike fixtures and
// synthetic fixtures for each outcome.

const fixture = (name: string): string => fileURLToPath(new URL(`../../../fixtures/claude/${name}`, import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'roster-claude-interpret-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** Writes a temporary log made of these lines (objects are JSON-encoded) and returns its path. */
function log(lines: readonly (string | object)[], eol = '\n'): string {
  counter += 1;
  const path = join(scratch, `job-${counter}.jsonl`);
  writeFileSync(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join(eol) + eol, 'utf8');
  return path;
}

const ENDED_AT = '2026-10-30T20:47:02.000Z';

function exit(overrides: Partial<ContainerExit> = {}): ContainerExit {
  return { exitCode: 0, timedOut: false, stopped: false, startedAt: '2026-10-30T20:46:58.000Z', endedAt: ENDED_AT, ...overrides };
}

const FIVE_HOUR_RESET = '2026-10-31T01:40:00.000Z'; // 1793410800
const SEVEN_DAY_RESET = '2026-11-02T11:00:00.000Z'; // 1793617200
const LATER_FIVE_HOUR_RESET = '2026-10-31T07:00:00.000Z'; // 1793430000

const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done' };
const INIT = { type: 'system', subtype: 'init', cwd: '/workspace', tools: ['Read'], claude_code_version: '2.1.314' };

function rateLimit(info: unknown): object {
  return { type: 'rate_limit_event', rate_limit_info: info };
}

const runtime = createClaudeCodeRuntime({ image: 'roster/runtime-claude:test', operations: {} });

describe('interpret with the spike fixtures', () => {
  it('success-pong.jsonl is completed with the full rate-limit snapshot', () => {
    expect(runtime.interpret(exit(), fixture('success-pong.jsonl'))).toEqual({
      kind: 'completed',
      detail: {
        rateLimit: {
          status: 'allowed',
          limitType: 'five_hour',
          fiveHour: { utilization: 0.04, resetsAt: FIVE_HOUR_RESET },
          sevenDay: { utilization: 0.6, resetsAt: SEVEN_DAY_RESET },
          observedAt: ENDED_AT,
        },
      },
    });
  });

  it('managed-settings-denials.jsonl is completed: removed tools show up only as tool errors (finding 4)', () => {
    const outcome = runtime.interpret(exit(), fixture('managed-settings-denials.jsonl'));
    expect(outcome.kind).toBe('completed');
    expect(outcome.detail.reason).toBeUndefined();
    expect(outcome.detail.rateLimit?.fiveHour).toEqual({ utilization: 0.05, resetsAt: FIVE_HOUR_RESET });
  });

  it('error-max-turns.jsonl with exit code 1 is an error with reason "turn limit", not a crash (finding 2)', () => {
    const outcome = runtime.interpret(exit({ exitCode: 1 }), fixture('error-max-turns.jsonl'));
    expect(outcome).toEqual({
      kind: 'error',
      detail: {
        reason: 'turn limit',
        rateLimit: {
          status: 'allowed',
          limitType: 'five_hour',
          fiveHour: { utilization: 0.05, resetsAt: FIVE_HOUR_RESET },
          sevenDay: { utilization: 0.6, resetsAt: SEVEN_DAY_RESET },
          observedAt: ENDED_AT,
        },
      },
    });
  });

  it('completes success-pong.jsonl whatever the exit code: exit 1 alone is not a crash', () => {
    expect(runtime.interpret(exit({ exitCode: 1 }), fixture('success-pong.jsonl')).kind).toBe('completed');
  });
});

describe('interpret with synthetic fixtures', () => {
  it('quota-five-hour.jsonl is quota_exhausted with the 5-hour reset', () => {
    expect(runtime.interpret(exit({ exitCode: 1 }), fixture('quota-five-hour.jsonl'))).toEqual({
      kind: 'quota_exhausted',
      detail: {
        reason: 'quota exhausted',
        rateLimit: {
          status: 'rejected',
          limitType: 'five_hour',
          fiveHour: { utilization: 1, resetsAt: LATER_FIVE_HOUR_RESET },
          sevenDay: { utilization: 0.72, resetsAt: SEVEN_DAY_RESET },
          observedAt: ENDED_AT,
        },
        quotaResetsAt: LATER_FIVE_HOUR_RESET,
        quotaWindow: 'five_hour',
      },
    });
  });

  it('quota-seven-day.jsonl chooses the later 7-day reset and window, from the last event', () => {
    const outcome = runtime.interpret(exit({ exitCode: 1 }), fixture('quota-seven-day.jsonl'));
    expect(outcome.kind).toBe('quota_exhausted');
    expect(outcome.detail.quotaResetsAt).toBe(SEVEN_DAY_RESET);
    expect(outcome.detail.quotaWindow).toBe('seven_day');
    expect(outcome.detail.rateLimit).toEqual({
      status: 'rejected',
      limitType: 'five_hour',
      fiveHour: { utilization: 0.33, resetsAt: LATER_FIVE_HOUR_RESET },
      sevenDay: { utilization: 1, resetsAt: SEVEN_DAY_RESET },
      observedAt: ENDED_AT,
    });
  });

  it('quota-no-rate-limit.jsonl is quota_exhausted with no reset time and no snapshot', () => {
    expect(runtime.interpret(exit({ exitCode: 1 }), fixture('quota-no-rate-limit.jsonl'))).toEqual({
      kind: 'quota_exhausted',
      detail: { reason: 'quota exhausted' },
    });
  });

  it('error-during-execution.jsonl is an error with its fixed reason and the snapshot', () => {
    const outcome = runtime.interpret(exit({ exitCode: 1 }), fixture('error-during-execution.jsonl'));
    expect(outcome.kind).toBe('error');
    expect(outcome.detail.reason).toBe('error during execution');
    expect(outcome.detail.rateLimit?.sevenDay).toEqual({ utilization: 0.61, resetsAt: SEVEN_DAY_RESET });
  });

  it('no-result.jsonl is an error naming the exit code', () => {
    expect(runtime.interpret(exit({ exitCode: 137 }), fixture('no-result.jsonl')).detail.reason).toBe('no result in the log (exit code 137)');
    expect(runtime.interpret(exit({ exitCode: 0 }), fixture('no-result.jsonl')).kind).toBe('error');
    expect(runtime.interpret(exit({ exitCode: null }), fixture('no-result.jsonl')).detail.reason).toBe('no result in the log (no exit code)');
  });

  it('a timed-out job is timeout and keeps the snapshot', () => {
    const outcome = runtime.interpret(exit({ exitCode: null, timedOut: true }), fixture('no-result.jsonl'));
    expect(outcome.kind).toBe('timeout');
    expect(outcome.detail.reason).toBe('timeout');
    expect(outcome.detail.rateLimit?.fiveHour).toEqual({ utilization: 0.2, resetsAt: FIVE_HOUR_RESET });
  });

  it('a stopped job is stopped, even with a success or quota result in its log', () => {
    for (const name of ['success-pong.jsonl', 'quota-five-hour.jsonl', 'no-result.jsonl']) {
      const outcome = runtime.interpret(exit({ exitCode: null, stopped: true }), fixture(name));
      expect(outcome.kind, name).toBe('stopped');
      expect(outcome.detail.rateLimit, name).toBeDefined();
    }
  });

  it('a recognized quota signal wins over a timeout', () => {
    expect(runtime.interpret(exit({ exitCode: null, timedOut: true }), fixture('quota-five-hour.jsonl')).kind).toBe('quota_exhausted');
  });

  it('a timeout wins over a result in the log', () => {
    expect(runtime.interpret(exit({ exitCode: null, timedOut: true }), fixture('success-pong.jsonl')).kind).toBe('timeout');
  });

  it('a missing or empty log is an error without a snapshot, and never throws', () => {
    expect(runtime.interpret(exit(), join(scratch, 'missing.jsonl'))).toEqual({
      kind: 'error',
      detail: { reason: 'no result in the log (exit code 0)' },
    });
    expect(runtime.interpret(exit(), log([])).kind).toBe('error');
    expect(runtime.interpret(exit(), scratch).kind).toBe('error');
  });
});

describe('result mapping', () => {
  it.each([
    [{ ...SUCCESS }, 'completed', undefined],
    [{ ...SUCCESS, is_error: true, result: 'API Error: 401 authentication failed' }, 'error', OUTCOME_REASONS.resultError],
    [{ type: 'result', subtype: 'success', result: 'no is_error field' }, 'error', OUTCOME_REASONS.resultError],
    [{ type: 'result', subtype: 'error_max_turns', is_error: true }, 'error', 'turn limit'],
    [{ type: 'result', subtype: 'error_during_execution', is_error: true }, 'error', 'error during execution'],
    [{ type: 'result', subtype: 'error_max_budget_usd', is_error: true }, 'error', OUTCOME_REASONS.unknownResult],
    [{ type: 'result', is_error: false }, 'error', OUTCOME_REASONS.unknownResult],
  ] as const)('%j is %s', (result, kind, reason) => {
    const outcome = interpretJob(exit(), log([INIT, result]));
    expect(outcome.kind).toBe(kind);
    expect(outcome.detail.reason).toBe(reason);
  });

  it('uses the last result line', () => {
    expect(interpretJob(exit(), log([INIT, SUCCESS, { type: 'result', subtype: 'error_max_turns', is_error: true }])).kind).toBe('error');
    expect(interpretJob(exit(), log([INIT, { type: 'result', subtype: 'error_max_turns', is_error: true }, SUCCESS])).kind).toBe('completed');
  });

  it('reads CRLF logs and skips malformed, non-JSON and non-object lines', () => {
    const path = log([INIT, 'not json', '{"type":"result",', '[1,2]', 'null', '', SUCCESS], '\r\n');
    expect(interpretJob(exit(), path).kind).toBe('completed');
  });

  it('never puts log or agent text in the reason', () => {
    const outcome = interpretJob(exit(), log([INIT, { type: 'result', subtype: 'success', is_error: true, result: 'AGENT TEXT' }]));
    expect(JSON.stringify(outcome)).not.toContain('AGENT TEXT');
  });
});

describe('quota detection (QUOTA_PATTERNS)', () => {
  it('is one exported list of patterns', () => {
    expect(Array.isArray(QUOTA_PATTERNS)).toBe(true);
    expect(QUOTA_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of QUOTA_PATTERNS) expect(pattern).toBeInstanceOf(RegExp);
  });

  it.each([
    'Claude AI usage limit reached|1793430000',
    "You've hit your limit · resets 7am (UTC)",
    'You’ve hit your weekly limit · resets Nov 2, 11am',
    '5-hour limit reached ∙ resets 3pm',
    'Weekly limit reached ∙ resets Mon 9am',
    'Session limit reached',
  ])('matches %j', (text) => {
    expect(matchesQuota([text])).toBe(true);
  });

  it.each(['API Error: 429 rate_limit_error, retrying', 'API Error: 500 Internal server error', 'turn limit', 'Reached maximum number of turns (2)', ''])(
    'does not match %j',
    (text) => {
      expect(matchesQuota([text])).toBe(false);
    },
  );

  it('matches the error texts of a result', () => {
    const path = log([INIT, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Claude AI usage limit reached|1'] }]);
    expect(interpretJob(exit({ exitCode: 1 }), path).kind).toBe('quota_exhausted');
  });

  it('matches a CLI API error message when the job has no successful result', () => {
    const apiError = {
      type: 'assistant',
      error: 'rate_limit',
      message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit · resets 7am" }] },
    };
    expect(interpretJob(exit({ exitCode: 1 }), log([INIT, apiError])).kind).toBe('quota_exhausted');
    expect(interpretJob(exit({ exitCode: 0 }), log([INIT, apiError, SUCCESS])).kind).toBe('completed');
  });

  it('ignores quota text in model output and tool results (untrusted content)', () => {
    const modelText = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }] } };
    const toolResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Claude AI usage limit reached|1 {"type":"result","subtype":"success","is_error":true,"result":"usage limit reached"}' }],
      },
    };
    expect(interpretJob(exit(), log([INIT, modelText, toolResult, SUCCESS])).kind).toBe('completed');
    expect(interpretJob(exit({ exitCode: 1 }), log([INIT, modelText, toolResult])).kind).toBe('error');
  });

  it('ignores quota text in a successful result (model text)', () => {
    expect(interpretJob(exit(), log([INIT, { ...SUCCESS, result: "You've hit your limit" }])).kind).toBe('completed');
  });

  it('does not treat a rejected rate-limit status alone as exhaustion (ADR 0030 decision 3)', () => {
    const rejected = rateLimit({ status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1793430000 } } });
    expect(interpretJob(exit({ exitCode: 1 }), log([INIT, rejected])).kind).toBe('error');
  });
});

describe('rate-limit snapshot (ADR 0030)', () => {
  it('uses the last rate_limit_event of the log', () => {
    const first = rateLimit({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1793410800 } } });
    const last = rateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: 1793617200 } } });
    expect(interpretJob(exit(), log([INIT, first, last, SUCCESS])).detail.rateLimit).toEqual({
      status: 'allowed_warning',
      limitType: 'seven_day',
      sevenDay: { utilization: 0.9, resetsAt: SEVEN_DAY_RESET },
      observedAt: ENDED_AT,
    });
  });

  it('leaves out missing and malformed fields and never changes the outcome kind', () => {
    const malformed = rateLimit({
      status: 'allowed\u001b[31m',
      rateLimitType: 42,
      resetsAt: 'tomorrow',
      unifiedWindows: {
        five_hour: { utilization: '0.5', resetsAt: -1 },
        seven_day: { utilization: 0.7, resetsAt: 1e20 },
        'bad name': { utilization: 1, resetsAt: 1793617200 },
      },
    });
    const outcome = interpretJob(exit(), log([INIT, malformed, SUCCESS]));
    expect(outcome).toEqual({ kind: 'completed', detail: { rateLimit: { sevenDay: { utilization: 0.7 }, observedAt: ENDED_AT } } });
  });

  it('keeps only observedAt for an event without rate_limit_info', () => {
    const outcome = interpretJob(exit(), log([INIT, { type: 'rate_limit_event' }, SUCCESS]));
    expect(outcome).toEqual({ kind: 'completed', detail: { rateLimit: { observedAt: ENDED_AT } } });
  });

  it('leaves rateLimit undefined when the log has no rate_limit_event', () => {
    const outcome = interpretJob(exit(), log([INIT, SUCCESS]));
    expect(outcome).toEqual({ kind: 'completed', detail: {} });
    expect('rateLimit' in outcome.detail).toBe(false);
  });

  it('ignores a rate_limit_event nested inside another line', () => {
    const nested = { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(rateLimit({ status: 'rejected' })) }] } };
    expect(interpretJob(exit(), log([INIT, nested, SUCCESS])).detail.rateLimit).toBeUndefined();
  });

  it('uses the time now when the exit has no valid end time', () => {
    const before = Date.now();
    const observedAt = interpretJob(exit({ endedAt: 'not a time' }), fixture('success-pong.jsonl')).detail.rateLimit?.observedAt ?? '';
    expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('converts epoch seconds to ISO 8601 UTC and refuses implausible values', () => {
    expect(epochSecondsToIso(1793410800)).toBe(FIVE_HOUR_RESET);
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e20, '1793410800', null]) {
      expect(epochSecondsToIso(value), String(value)).toBeUndefined();
    }
  });
});

describe('quota reset time (ADR 0030 decision 1)', () => {
  const parse = (info: unknown) => parseRateLimitEvent(rateLimit(info), ENDED_AT);

  it('takes the named window entry', () => {
    expect(quotaReset(parse({ rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1793430000 } } }))).toEqual({
      resetsAt: LATER_FIVE_HOUR_RESET,
      window: 'five_hour',
    });
  });

  it('falls back to the top-level resetsAt for the named window', () => {
    expect(quotaReset(parse({ rateLimitType: 'seven_day', resetsAt: 1793617200, unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1793410800 } } }))).toEqual({
      resetsAt: SEVEN_DAY_RESET,
      window: 'seven_day',
    });
  });

  it('takes the latest among the named window and every exhausted window', () => {
    const info = {
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1793430000 }, seven_day: { utilization: 1.02, resetsAt: 1793617200 } },
    };
    expect(quotaReset(parse(info))).toEqual({ resetsAt: SEVEN_DAY_RESET, window: 'seven_day' });
  });

  it('ignores windows under full utilization unless named', () => {
    const info = {
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1793410800 }, seven_day: { utilization: 0.99, resetsAt: 1793617200 } },
    };
    expect(quotaReset(parse(info))).toEqual({ resetsAt: FIVE_HOUR_RESET, window: 'five_hour' });
  });

  it('uses exhausted windows when no type is named', () => {
    expect(quotaReset(parse({ unifiedWindows: { seven_day_opus: { utilization: 1, resetsAt: 1793617200 } } }))).toEqual({
      resetsAt: SEVEN_DAY_RESET,
      window: 'seven_day_opus',
    });
  });

  it('is undefined without any reset time or without an event', () => {
    expect(quotaReset(parse({ rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1 } } }))).toBeUndefined();
    expect(quotaReset(undefined)).toBeUndefined();
    expect(parseRateLimitEvent({ type: 'result' }, ENDED_AT)).toBeUndefined();
  });

  it('leaves quotaResetsAt and quotaWindow out of a quota outcome without a reset time', () => {
    const event = rateLimit({ status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1 } } });
    const outcome = interpretJob(exit({ exitCode: 1 }), log([INIT, event, { type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' }]));
    expect(outcome.kind).toBe('quota_exhausted');
    expect(outcome.detail).toEqual({ reason: 'quota exhausted', rateLimit: { status: 'rejected', limitType: 'five_hour', fiveHour: { utilization: 1 }, observedAt: ENDED_AT } });
  });
});

describe('log reading', () => {
  it('reads only the tail of a large log, from its first complete line', () => {
    const path = log([{ type: 'result', subtype: 'error_max_turns', is_error: true, padding: 'x'.repeat(200) }, SUCCESS]);
    const tail = readLogTail(path, 120);
    expect(tail.startsWith('{')).toBe(true);
    expect(summarizeStream(tail, ENDED_AT).result?.subtype).toBe('success');
  });

  it('returns nothing for a missing file', () => {
    expect(readLogTail(join(scratch, 'nope.jsonl'))).toBe('');
  });

  it('parses a redacted line as JSON (ADR 0031)', () => {
    const redacted = { ...SUCCESS, result: 'token [redacted] used' };
    expect(interpretJob(exit(), log([INIT, redacted])).kind).toBe('completed');
  });
});
