# 0014. Roster's local store replaces Linear; constitution amended for local-first

- Status: Accepted
- Date: 2026-10-30
- Deciders: human (direction approved in conversation on 2026-10-30; merging this ADR's PR is the final approval)
- Supersedes: 0011 (and 0001 through it)

## Context

ADR 0001, kept by ADR 0011, made Linear the single source of truth for work status, and constitution
principle 2 says the same. On 2026-10-30 the human set Roster's foundational vision
(`docs/architecture/vision.md`): a personal, local-first, single-user platform, independent from
external services, with its own tailored UI. The human chose to stop using Linear, to run agents on
their own machine, and to isolate executions in Docker containers.

Roster's own store does not exist yet, so its construction needs a tracker in the meantime.

## Decision

1. Git is the source of truth for intent: specs, plans, `tasks.md`, ADRs, agent definitions, skills
   and policies. Roster's local store (to be designed by spec 002) is the source of truth for progress:
   task status and execution history.
2. Until that store exists (bootstrap), work status is `specs/<feature>/tasks.md` plus PRs. A task is
   done when its PR is merged and its box in `tasks.md` is checked.
3. Linear is frozen. No new issues are created there. The existing project `001-dispatcher`
   (ROS-5 to ROS-19) is cancelled once spec 002 is approved, with the human's permission.
4. The constitution is amended: principle 2 is replaced, and principles for local-first execution,
   isolation, enforcement outside the prompt, protection of safety mechanisms and no
   over-architecture are added (all stated by the human in the vision).

## Considered options

- **Keep Linear:** working tooling and a mobile UI today; keeps an external dependency at the center
  and a UI Roster cannot tailor.
- **GitHub Issues:** already paid for; still external, and Roster would still need its own state for
  executions.
- **Local store + own UI, with `tasks.md` + PRs during bootstrap:** independent and tailored; Roster
  has no status UI until spec 002 delivers `roster status`.

## Consequences

- Specs, plans and tasks stay reviewable in git; the store only holds operational state, so the plan
  format (`tasks.md`) becomes the import format of the store.
- During bootstrap, status is read from `tasks.md` and open PRs, not from a board. There is no phone UI.
- `AGENTS.md`, `agents/project-manager.md` and the specialists' rules still mention Linear. `AGENTS.md`
  is updated with this ADR; the agent definitions are updated when spec 002 is planned.
- ADRs 0006, 0007, 0009, 0012 and 0013 describe Linear interactions; they are reviewed by the
  architect when spec 002 is planned.
