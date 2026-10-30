# Roster — agent instructions

Personal, local-first agent orchestration. An architect turns an approved spec into a plan and tasks,
an HR Director hires on-demand specialists, and each specialist executes and reports on its own task.
Vision and architecture: `docs/architecture/vision.md`.

This file is harness-neutral. Claude Code reads it through `CLAUDE.md`; OpenCode reads it directly.

## Sources of truth

- **Work status:** Roster's local store. Until it exists (bootstrap, ADR 0014): `specs/<feature>/tasks.md`
  plus PRs. Linear is frozen; do not create or update issues there.
- **What to build:** `specs/<feature>/spec.md`, approved by the human.
- **How and why:** `specs/<feature>/plan.md` and `docs/adr/`.
- **Fixed rules:** `specs/constitution.md`.

## Language

- Everything persisted is written in **English**: specs, plans, ADRs, agent definitions, skills,
  code, comments, commits, PRs and task text.
- Talk to the human in **their language** (`human_language` in `specs/constitution.md`): chat replies,
  questions when blocked, and progress summaries addressed to them.
- The human may write specs, tasks or comments in their language. Translate them to English before
  work starts, keep the meaning, and ask about anything ambiguous instead of guessing.

## Rules for every agent

1. Before working, read `specs/constitution.md`, the ADRs in `docs/adr/`, and your full task with its spec and plan.
2. Do not contradict an accepted ADR. To change one, ask the `architect` agent for a new ADR that supersedes it.
3. Stay within your task's scope. Anything you find outside it becomes a note in your PR or a proposed new task.
4. Never push to `main`. Work on a branch `agent/<feature>-<task>` (for example `agent/002-T01`) and open a PR.
5. Never use production credentials, payments or personal data. Those tasks are marked `needs-human` in `tasks.md`.
6. If the task is ambiguous, stop and ask the human. Do not guess.
7. When done, the PR description says what you did and how you verified it, and the PR checks the task's box in `tasks.md`.

## SDD flow

constitution → spec (approved) → plan + ADRs → tasks (approved) → implementation → PR → human review.

## Base roles

| Agent | File | Does | Never does |
| --- | --- | --- | --- |
| project-manager | `agents/project-manager.md` | Tracks progress of `tasks.md` (role being redefined by spec 002; its Linear steps are frozen) | Write code |
| hr-director | `agents/hr-director.md` | Picks and defines the specialist for each task, with its skills | Execute the task |
| architect | `agents/architect.md` | Writes `plan.md`, `tasks.md` and the ADRs | Implement |

## Hired agents

- The neutral definition lives in `agents/<slug>.md`. It is the only copy edited by hand or by agents.
- After `hr-director` creates or changes an agent, run `scripts/sync-agents.ps1` to copy it to `.claude/agents/`.
- Claude Code loads new agents at session start. In the same session, use the `.md` content as the prompt of a general subagent.

## Skills

- A specialist preloads skills through the `skills:` field of its frontmatter.
- Only skills with status `approved` in `skills/registry.md` may be listed. Approved skills live in `.claude/skills/<name>/`.
- Need a skill that is not approved? Add it to the registry as `proposed` and mark the task `needs-human`.
- Never download or install a skill on your own: skills can run scripts, so a human reviews each one first.
