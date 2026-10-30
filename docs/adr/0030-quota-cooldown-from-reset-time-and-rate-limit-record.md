# 0030. Quota cooldown ends at the reset time reported by Claude Code, and every execution records rate-limit usage

- Status: Accepted
- Date: 2026-10-30
- Deciders: human (approved in conversation 2026-10-30; merging this PR is the final approval)
- Amends: 0028

## Context

ADR 0028 cools a runtime down for a fixed `quotaCooldownMinutes` (default 300) after quota
exhaustion, as an estimate of the Claude Pro 5-hour window. Spike T14
(`docs/spikes/2026-11-container-runtime.md`, finding 6) showed that every `claude -p` run with
`--output-format stream-json` emits a `rate_limit_event` line with the provider's own view of the
limits (fixture `docs/spikes/container-runtime/fixtures/success-pong.jsonl`):

```
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793410800,
 "rateLimitType":"five_hour", ...,"unifiedWindows":{
   "five_hour":{"utilization":0.04,"resetsAt":1793410800,"status":"allowed"},
   "seven_day":{"utilization":0.6,"resetsAt":1793617200,"status":"allowed"}}}}
```

`resetsAt` is in epoch seconds; `utilization` is a fraction (0.6 means 60 %). A fixed 300 minutes is
too long when the window resets sooner and far too short when the 7-day window is the one exhausted:
every night slot would then start, fail on quota and push another WIP commit until the weekly reset.
The 7-day utilization was already 0.6 during the spike, so the weekly limit, not only the 5-hour
window, may bound night runs (hypothesis H9 of plan 002). Only the `allowed` status was observed;
real exhaustion was not (H5 partly confirmed).

## Decision

ADR 0028 stands (WIP commit and guarded push without PR, task back to `todo`, cooldown that the
router honors, resume from the agent branch, no automatic retry of other errors). This ADR changes
only how long the cooldown lasts (0028 decision 3) and adds a record of rate-limit usage.

1. **Cooldown end from `resetsAt`.** When the Claude Code adapter reports `quota_exhausted`, it also
   returns `quotaResetsAt` and `quotaWindow`, taken from the last `rate_limit_event` in the job's
   stream: the latest `resetsAt` among (a) the window named by `rate_limit_info.rateLimitType` (its
   `unifiedWindows.<type>.resetsAt`, else the top-level `resetsAt`) and (b) every window in
   `unifiedWindows` with `utilization >= 1`; `quotaWindow` names the window that reset time belongs
   to. So when the 7-day window is exhausted, the 7-day `resetsAt` applies, even if it is days away
   and the 5-hour window resets sooner: work cannot succeed before the weekly reset.
2. **Fallback.** Roster sets `runtime_state.cooldown_until = quotaResetsAt` when it is present, later
   than now and at most 8 days after now. Otherwise (no `rate_limit_event`, missing or out-of-range
   `resetsAt`) it uses `now + quotaCooldownMinutes` from `config.json` (default 300), as in ADR 0028.
   `runtime_state` also records `cooldown_source` (`resets_at` or `fallback`) and `cooldown_window`
   (`quotaWindow`, for example `five_hour` or `seven_day`; null for the fallback).
3. **Detection is unchanged.** Recognizing exhaustion stays in the adapter's pattern constant (ADR
   0022, plan 002 H5). This ADR does not decide which `status` value means "exhausted"; the
   `rate_limit_event` status may join the patterns once a real exhaustion is observed (T24, T29, T40).
4. **Per-execution record.** After every runtime job (agent, review, hr-director, analyst, architect),
   whatever its outcome, the adapter returns the last observed rate-limit snapshot in
   `RuntimeOutcome.detail.rateLimit`, and Roster stores it on the execution row: status, limit type,
   5-hour utilization and reset time, 7-day utilization and reset time, and when it was observed.
   Reset times are stored as ISO 8601 UTC. When an execution runs several jobs, the latest snapshot
   overwrites the earlier one. A run with no `rate_limit_event` leaves the columns null.
5. **Visibility only.** `roster status` shows the latest snapshot and any active cooldown with its
   source and window. The record changes no other behavior: selection, `maxRunsPerNight` and the
   router ignore utilization.

**Non-decision (open question).** Whether `roster run` should skip or defer work when the 7-day
utilization is high (for example above 0.9) is not decided here. Today a run that exhausts the quota
mid-task follows the safe WIP path of ADR 0028, then cools down until the reset. The human revisits
the question with the recorded utilization after real night runs (H9, T29 and T40); any skip rule
needs a new ADR.

## Considered options

- **Cooldown until the reported `resetsAt`, latest exhausted window, fixed fallback (chosen):** uses
  the provider's own reset time; covers the 7-day window; still safe when the event is missing.
- **Fixed `quotaCooldownMinutes` only (ADR 0028):** simplest; wastes night slots after a short
  window and retries every slot for days after a weekly exhaustion.
- **Always the 5-hour `resetsAt`:** simple; wrong when the 7-day window is the exhausted one.
- **Record usage in `execution_events` only:** no schema change; `roster status` would have to parse
  JSON payloads to show the latest utilization.
- **Skip work above a 7-day utilization threshold now:** protects the weekly quota; no data yet to set
  the threshold, and it adds behavior the human did not approve.

## Consequences

- A weekly exhaustion can pause all runs for several days. `roster status` shows the cooldown end and
  its window, so the pause is visible; the runbook explains it (T39).
- The adapter must parse `rate_limit_event`, an output line of a pinned CLI version; a format change
  falls back to the fixed cooldown and leaves the usage columns null, which is safe.
- The human gets per-execution 5-hour and 7-day utilization to tune `maxRunsPerNight` (H9).
- `quotaCooldownMinutes` stays in `config.json`, now only as the fallback.
- Other runtimes may leave the snapshot empty; the columns use the 5-hour and 7-day names because
  Claude Code is the only runtime today (constitution principle 12).
