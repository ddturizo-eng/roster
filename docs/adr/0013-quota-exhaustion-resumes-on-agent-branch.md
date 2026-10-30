# 0013. Quota exhaustion saves work on the agent branch and returns the issue to Todo

- Status: Superseded by 0028
- Date: 2026-10-29
- Deciders: architect (pending human)

## Context

Spec 001 decides that an issue whose run hits the Claude Pro quota goes back to Todo with a comment,
while real failures go to Blocked and are not retried. Discarding partial work wastes the quota already
spent.

## Decision

When the harness adapter reports `quota_exhausted`, the dispatcher commits any uncommitted changes as
`wip(ROS-<n>): partial work, quota exhausted`, pushes branch `agent/ROS-<n>` without opening a PR, moves
the issue to Todo and comments with the run link. The next run that picks the issue checks out the
existing remote branch and tells the specialist in the prompt that it is resuming. Timeouts and all
other errors move the issue to Blocked and are not retried.

## Considered options

- **Push WIP and resume:** reuses spent quota; the branch may contain half-done commits that the
  specialist must review.
- **Discard local work:** simplest; the next run starts from zero and spends the quota again.

## Consequences

- Agent branches can contain `wip` commits; PRs are squash-merged by the human.
- Quota detection relies on the harness output format; a missed detection lands in Blocked, which is safe.
