# 0018. Persistence split: git for reviewed intent, a local SQLite store for operational state

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human

## Context

ADR 0014 and constitution principle 2 say git holds intent and Roster's local store holds progress,
and leave the store's design to spec 002. Spec 002 requires: project registration reviewable in git,
tasks imported from the approved `tasks.md`, every execution recorded in the store, and the store
never inside a container. Something must also hold machine-specific settings (paths, limits) that are
neither reviewed intent nor progress.

## Decision

| What | Where | Read from |
| --- | --- | --- |
| Specs, plans, `tasks.md`, ADRs | Project repo, `specs/` and `docs/adr/` | `origin/main` of the project |
| Agent definitions, skills registry | Roster repo, `agents/`, `skills/registry.md` | `origin/main` of the Roster repo |
| Project registrations | Roster repo, `projects/<name>.json` | `origin/main` of the Roster repo |
| Policies, protected paths | Roster repo, `policies/*.json` | `origin/main` of the Roster repo |
| Machine settings (Roster repo path, workspace root, limits, commit identity, enabled runtimes) | `%LOCALAPPDATA%\Roster\config.json` | local file |
| Feature stages, tasks and their states, dependencies, executions, steps, events, grilling Q&A, approval requests, runtime cooldowns | `%LOCALAPPDATA%\Roster\data\roster.db` (SQLite) | local store |
| Execution logs | `%LOCALAPPDATA%\Roster\logs\<execution-id>\` | files referenced from the store |
| Secrets | `%LOCALAPPDATA%\Roster\secrets\` (ADR 0016, 0029) | DPAPI |

Rules:

1. Roster reads git-side data only from `origin/main` after a fetch (`git show origin/main:<path>`),
   never from a working copy or an agent branch. Something is approved when it is on `main`.
2. The store keeps references to git (commit ids, PR numbers and URLs, merge dates), never copies of
   reviewed documents, except the task text captured at import (`body_md`) so an execution can always
   say exactly what the agent was given.
3. The store is owned by the `store/sqlite` adapter; its schema is versioned by numbered migrations
   applied at startup in a transaction.
4. Nothing under `%LOCALAPPDATA%\Roster\` except a job's own workspace directories is ever mounted
   into a container.

## Considered options

- **Split as above:** reviewed things get PR review; operational state is fast and private; two places
  to look.
- **Everything in git (status in `tasks.md`, executions as files):** one source; every status change
  is a commit, the agent branch and `main` would race on the same file, and agents could edit state.
- **Everything in the store (including registrations and policies):** simple to query; registrations
  and policies would escape human review, against principles 5 and 11.

## Consequences

- `roster status` reads only the store; `roster sync` refreshes it from git and GitHub.
- Losing `roster.db` loses execution history but no intent; tasks can be re-imported from git.
- Machine-specific data in registrations (the local repo path) is visible in git; accepted for a
  personal tool.
- The store schema is in plan 002 section 5.
