# 0002. Claude Code as the initial harness, harness-neutral design

- Status: Accepted
- Date: 2026-10-29
- Deciders: human

## Context

The only AI subscription available is Claude Pro. Anthropic does not allow Pro/Max sign-in in
third-party harnesses such as OpenCode, which only works with Claude through an API key.
Other harnesses and subscriptions may be added later.

## Decision

Run every agent in Claude Code with the Claude Pro subscription. Keep instructions in `AGENTS.md`
and agent definitions in `agents/`, with a script that copies them to each harness's format
(`.claude/agents/` today).

## Considered options

- **OpenCode + API key:** more flexible; variable per-token cost, outside the current budget.
- **OpenCode + Copilot:** Copilot Pro is not available; Copilot Free is not enough.

## Consequences

- Limited quota: one executing agent at a time.
- Adding a harness means writing its adapter in `scripts/sync-agents.ps1`, without touching the agents.
