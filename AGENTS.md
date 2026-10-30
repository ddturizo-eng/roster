# Roster — agent instructions

Async agent orchestration. A Project Manager splits goals into Linear issues, an HR Director hires
on-demand specialists, and each specialist executes and reports on its own issue.

This file is harness-neutral. Claude Code reads it through `CLAUDE.md`; OpenCode reads it directly.

## Sources of truth

- **Work status:** Linear (MCP server `linear`). Nothing is assumed unless it is in an issue.
- **What to build:** `specs/<feature>/spec.md`, approved by the human.
- **How and why:** `specs/<feature>/plan.md` and `docs/adr/`.
- **Fixed rules:** `specs/constitution.md`.

## Language

- Everything persisted is written in **English**: specs, plans, ADRs, agent definitions, skills,
  code, comments, commits, PRs, and Linear issue titles and descriptions.
- Talk to the human in **their language** (`human_language` in `specs/constitution.md`): chat replies,
  questions in Blocked comments, and progress summaries addressed to them.
- The human may write specs, issues or comments in their language. Translate them to English before
  work starts, keep the meaning, and ask about anything ambiguous instead of guessing.

## Rules for every agent

1. Before working, read `specs/constitution.md`, the ADRs in `docs/adr/`, and your full issue.
2. Do not contradict an accepted ADR. To change one, ask the `architect` agent for a new ADR that supersedes it.
3. Stay within your issue's scope. Anything you find outside it becomes a comment or a new issue.
4. Never push to `main`. Work on a branch `agent/<issue-id>` and open a PR.
5. Never use production credentials, payments or personal data. Those issues carry `needs-human`.
6. If the issue is ambiguous, ask in a comment and move it to Blocked. Do not guess.
7. When done, comment on the issue: what you did, how you verified it, the PR link. Move it to In Review.

## SDD flow

constitution → spec (approved) → plan + ADRs → tasks → Linear issues → implementation → PR → human review.

## Base roles

| Agent | File | Does | Never does |
| --- | --- | --- | --- |
| project-manager | `agents/project-manager.md` | Turns `tasks.md` into issues and tracks progress | Write code |
| hr-director | `agents/hr-director.md` | Picks and defines the specialist for each issue, with its skills | Execute the issue |
| architect | `agents/architect.md` | Writes `plan.md`, `tasks.md` and the ADRs | Implement |

## Hired agents

- The neutral definition lives in `agents/<slug>.md`. It is the only copy edited by hand or by agents.
- After `hr-director` creates or changes an agent, run `scripts/sync-agents.ps1` to copy it to `.claude/agents/`.
- Claude Code loads new agents at session start. In the same session, use the `.md` content as the prompt of a general subagent.

## Skills

- A specialist preloads skills through the `skills:` field of its frontmatter.
- Only skills with status `approved` in `skills/registry.md` may be listed. Approved skills live in `.claude/skills/<name>/`.
- Need a skill that is not approved? Add it to the registry as `proposed` and label the issue `needs-human`.
- Never download or install a skill on your own: skills can run scripts, so a human reviews each one first.
