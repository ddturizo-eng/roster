# 0028. Quota exhaustion keeps the work on the agent branch, returns the task to `todo`, and cools the runtime down

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human
- Supersedes: 0013
- Amended by: 0030; 0032 (decision 1: the pushed branch is the task's agent branch of ADR 0032,
  `agent/<NNN>-<Tnn>` by default)

## Context

ADR 0013 handled a harness that ran out of quota mid-issue: commit the partial work as WIP, push
`agent/ROS-<n>` without a PR, move the issue back to Todo in Linear, resume on the next run. Spec 002
keeps the behavior ("the work is kept on the agent branch and the task returns to ready (as in ADR
0013)") without Linear. Claude Pro limits work in 5 h windows; with several night slots, a run right
after exhaustion would fail again and waste a slot.

## Decision

1. When the runtime adapter reports `quota_exhausted` (agent or review job), Roster runs the policy
   check on the work tree. If it passes, Roster commits any changes as
   `wip(<NNN>-<Tnn>): partial work, quota exhausted` and pushes `agent/<NNN>-<Tnn>` through the push
   guard, without a PR. If it fails, the commit stays local and the task follows the policy stop path
   instead.
2. The execution ends `quota_exhausted`; the task returns to `todo` with no PR.
3. `runtime_state` records `quota_exhausted_at` and `cooldown_until = now + quotaCooldownMinutes`
   (default 300). The router skips that runtime until then, so `roster run` exits 0 with "quota
   cooldown" instead of starting work.
4. The next execution that selects the task checks out the existing remote branch and tells the agent
   it is resuming and must review the WIP commits.
5. Timeouts and other errors end as `failed` and are not retried automatically.

## Considered options

- **WIP push + `todo` + cooldown:** reuses spent quota, does not waste night slots; the cooldown is a
  fixed estimate of the provider window.
- **WIP push + `todo` without cooldown (ADR 0013):** simplest; the next slot fails the same way.
- **Discard the work:** simplest state; spends the quota again.

## Consequences

- Agent branches can contain `wip` commits; the human squash-merges PRs.
- Quota detection relies on the CLI's output (hypothesis H5); a missed detection ends as `failed`,
  which is safe.
- The cooldown length is a setting in `config.json`; the human can tune it once real usage is known (H9).
