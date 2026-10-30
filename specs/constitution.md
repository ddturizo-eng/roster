# Project constitution

Rules no spec, plan or agent may skip. Changing them requires an ADR.

## Settings

- `human_language`: `es` (Spanish). Agents talk to the human in this language.

## Principles

1. **Document before executing.** No issue is implemented without a spec approved by the human.
2. **Linear is the source of truth for progress.** The repo is the source of truth for specs, decisions and code.
3. **On-demand specialists.** Each issue is executed by the most specific profile possible, defined by `hr-director`.
4. **Least privilege.** Each agent gets only the tools and skills its issue needs.
5. **Human at the gates.** The human approves specs, new agents (the first time), new skills and merges to `main`.
6. **Harness-neutral.** Nothing depends on a single harness; instructions live in `AGENTS.md` and `agents/`.
7. **English-first.** Everything persisted is in English; conversation with the human is in `human_language`.

## Current constraints

- AI subscription: Claude Pro only, used from Claude Code. No API keys.
- One executing agent at a time, to avoid exhausting the quota.
- Paid tools: Claude Pro and GitHub Pro only. Linear on the free plan.

## Definition of done (every issue)

- Meets the issue's acceptance criteria.
- Describes its verification (test, command or screenshot).
- Has a PR open against `main` and a closing comment in Linear.
