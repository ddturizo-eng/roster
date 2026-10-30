# 0006. GitHub Actions as the dispatcher's scheduler and runner

- Status: Superseded by 0015
- Date: 2026-10-29
- Deciders: architect (pending human)

## Context

Spec 001 requires the dispatcher to run on a schedule (every 2 h at night) without the human's PC
turned on, one issue per run. The only paid tools are Claude Pro and GitHub Pro (constitution).

## Decision

Run the dispatcher as a scheduled GitHub Actions workflow (`.github/workflows/dispatcher.yml`) on
`ubuntu-latest`, with a `workflow_dispatch` trigger for manual runs, a single `concurrency` group with
`cancel-in-progress: false`, a job timeout shorter than the 2 h interval, and a recovery step that runs
when the job fails or is cancelled.

## Considered options

- **GitHub Actions schedule:** already paid for, no server to maintain, secrets management built in;
  schedules can be delayed, minutes are capped on private repos.
- **Always-on VPS or home server with cron:** full control; new cost or the human's hardware must stay on.
- **Serverless cron (Cloudflare Workers, etc.):** cheap; cannot run a long Claude Code session with git.

## Consequences

- No infrastructure to run; everything is in the repo.
- Runs may start late; the `concurrency` group still guarantees one executing agent at a time.
- Actions minutes must be watched if the repo is private.
- Workflow secrets become the place where credentials live (see ADRs 0007 and 0011).
