# Roster

Async AI agent orchestration: a PM agent turns specs into Linear tickets, an HR agent hires on-demand
specialists for each one. Spec-driven, ADR-backed, harness-agnostic. Built on Claude Code.

Repository content is in English; agents talk to the human in their own language (Spanish by default).

## Layout

| Path | What it is |
| --- | --- |
| `AGENTS.md` | Rules for every agent (harness-neutral) |
| `CLAUDE.md` | Imports `AGENTS.md` for Claude Code |
| `.mcp.json` | Official Linear MCP server |
| `specs/constitution.md` | Fixed project rules |
| `specs/<feature>/` | `spec.md`, `plan.md`, `tasks.md` per feature |
| `docs/adr/` | Architecture Decision Records (MADR) |
| `agents/` | Neutral agent definitions |
| `skills/registry.md` | Curated list of skills specialists may use |
| `scripts/sync-agents.ps1` | Copies `agents/` to `.claude/agents/` |

## Getting started (Phase 1)

1. Create a free Linear workspace with statuses Backlog, Todo, In Progress, In Review, Blocked, Done,
   the `needs-human` label and an `agent` label group.
2. Open Claude Code in this folder, approve the `linear` server from `.mcp.json`, and sign in with `/mcp`.
3. Run `scripts/sync-agents.ps1` and restart the session to load the agents.
4. Write a spec in `specs/<feature>/spec.md`, approve it, and ask the `architect` agent for the plan.

## License

[MIT](LICENSE)
