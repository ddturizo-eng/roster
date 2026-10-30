# Project constitution

Rules no spec, plan or agent may skip. Changing them requires an ADR.
Last amended: 2026-10-30 (ADR 0014).

## Settings

- `human_language`: `es` (Spanish). Agents talk to the human in this language.

## Principles

1. **Document before executing.** No task is implemented without a spec approved by the human.
2. **Git holds intent; Roster's store holds progress.** Specs, plans, tasks, decisions, agent
   definitions and policies live in git. Task status and execution history live in Roster's local
   store. Until that store exists, status is `specs/<feature>/tasks.md` plus PRs (ADR 0014).
3. **On-demand specialists.** Each task is executed by the most specific profile possible, defined by `hr-director`.
4. **Least privilege.** Each agent gets only the tools and skills its task needs.
5. **Human at the gates.** The human approves specs, plans, new agents (the first time), new skills,
   changes to policies and merges to `main`.
6. **Provider-neutral.** Nothing depends on a single provider, model or runtime; instructions live in
   `AGENTS.md` and `agents/`.
7. **English-first.** Everything persisted is in English; conversation with the human is in `human_language`.
8. **Personal and local-first.** Roster serves one human and runs on their machine. No multi-tenancy
   and no SaaS features.
9. **Isolated execution.** Agent work that edits code or runs commands runs in an isolated container.
   Roster's store, policies and credentials are never inside it.
10. **Enforcement outside the prompt.** Safety relies on runtime configuration, isolation and Roster
    performing irreversible side effects itself (commit, push, PR, deletes, migrations, deploys), not
    on agent instructions.
11. **Safety is not self-modifiable.** No agent changes policies, permission settings, hooks, guards or
    this constitution without a PR reviewed and merged by the human.
12. **No over-architecture.** No microservices and no abstraction without a current use case.

## Current constraints

- AI subscription: Claude Pro only, used from Claude Code. No API keys.
- One executing agent at a time, to avoid exhausting the quota.
- Paid tools: Claude Pro and GitHub Pro only. Linear is no longer used (ADR 0014).
- Human's machine: Windows 11 with Docker Desktop.

## Definition of done (every task)

- Meets the task's acceptance criteria.
- Describes its verification (test, command or screenshot).
- Has a PR open against `main` whose description says what was done and how it was verified.
- During bootstrap, the task's box in `tasks.md` is checked in the same PR.
