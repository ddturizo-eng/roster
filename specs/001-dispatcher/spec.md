# Spec 001 — Async dispatcher

- Status: Draft (pending human approval)
- Date: 2026-10-29
- Author: human + Claude

## Problem

Today agents only work when the human opens a session and invokes them. Issues in Todo wait even when
nobody is around. Roster's goal is for work to move forward without the human.

## Goal

A dispatcher that, with no human intervention, picks the next ready Linear issue, hands it to the
assigned specialist, and leaves the result as a PR for review.

## User stories

1. As the human, I want to leave issues in Todo before going to sleep and find reviewable PRs in the morning.
2. As the human, I want an issue with no agent assigned to go through `hr-director` first, so I do not define specialists by hand.
3. As the human, I want a blocked or ambiguous issue to land in Blocked with the question written down, instead of a guessed PR.
4. As the human, I want to see on the issue what happened in each run (start, result, error) without opening logs.

## Acceptance criteria

- [ ] Picks only Todo issues from team `ROS` with no open "blocked by" relations and no `needs-human` label.
- [ ] Processes one issue per run (quota constraint from the constitution).
- [ ] Chooses by Linear priority and, at equal priority, the oldest issue.
- [ ] If the issue has no label from the `agent` group, invokes `hr-director` first and applies the resulting label.
- [ ] Moves the issue to In Progress when starting and comments that it started.
- [ ] The specialist works on branch `agent/ROS-<n>` and opens a PR against `main` that mentions `ROS-<n>`.
- [ ] When finished, the issue is in In Review with the closing comment (what it did, how it verified it, PR link).
- [ ] If it fails or gets blocked, the issue is in Blocked with a comment explaining why, written in `human_language`.
- [ ] Never pushes to `main` and uses no credentials other than the harness's and GitHub's.
- [ ] Can be triggered on a schedule without the human's PC turned on.
- [ ] The harness is a parameter: Claude Code today, and adding another one does not change the logic.

## Out of scope

- Several issues in parallel.
- Automatic PR merges.
- Linear webhooks (Phase 3).
- Cost metrics per issue.

## Open questions

- How often does it run? Proposal: every 2 h at night, to respect Claude Pro's 5 h window.
- What happens if the quota runs out mid-issue? Proposal: the issue goes back to Todo with a comment.
- Is a failed issue retried? Proposal: no; it stays in Blocked for human review.
