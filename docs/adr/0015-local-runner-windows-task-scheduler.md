# 0015. Local runner on the human's PC, triggered by Windows Task Scheduler

- Status: Proposed
- Date: 2026-10-30
- Deciders: architect (pending human)
- Supersedes: 0006

## Context

ADR 0006 ran the dispatcher on a GitHub Actions schedule so it could work with the PC turned off.
On 2026-10-30 the human chose local execution, including unattended night runs with the PC on
(vision section 3, constitution principle 8). Spec 002 requires `roster run` to execute at most one
ready task per invocation and to be startable by the local scheduler with nobody present. The provider
terms check in the spec adds "one execution at a time and a bounded number of runs per night".
The machine is Windows 11 with Docker Desktop.

## Decision

`roster run` runs on the human's PC from the pinned install (ADR 0025). A Windows Task Scheduler task,
registered by `roster schedule install`, starts it at fixed local times (default 22:00, 00:00, 02:00,
04:00 and 06:00, America/Bogota), only when the user is logged on, with "wake the computer to run this
task", "run as soon as possible after a missed start" and a 110 minute execution limit. Each invocation:

1. takes a global lock file (`%LOCALAPPDATA%\Roster\run.lock`, PID + execution id) and exits 0 if it
   is held by a live process;
2. recovers executions left `running` by a dead process (marks them `interrupted`, kills their
   containers and networks);
3. exits 0 if `maxRunsPerNight` (default 5) executions already started in the current night window;
4. exits 2 if Docker is not reachable, after recording the reason;
5. performs one unit of work: one stage job, or one task including its hiring step.

`roster feature new` and other interactive commands take the same lock, so the human and the
scheduler never run two agents at once.

## Considered options

- **Windows Task Scheduler + `roster run`:** built into Windows, local time, wake support, no new
  dependency; the task needs the user session for Docker Desktop and DPAPI.
- **A long-running Roster daemon with its own timer:** one process to watch; must be kept alive,
  restarted after crashes and updates, and adds a service to maintain.
- **GitHub Actions schedule (ADR 0006):** works with the PC off; contradicts the local-first decision
  and keeps credentials in a cloud runner.
- **Self-hosted Actions runner on the PC:** reuses workflow syntax; adds GitHub as a scheduler
  dependency and a runner service for no gain.

## Consequences

- Night runs need the PC on, the user logged on (screen may be locked), and Docker Desktop started at
  sign-in. `doctor` and the runbook check these.
- No cloud minutes and no workflow secrets are needed for execution.
- The runner is the same CLI the human uses, so a manual `roster run` behaves exactly like a scheduled one.
- Validating that a locked session still runs Docker and DPAPI is hypothesis H8 in plan 002.
