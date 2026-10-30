# 0007. Claude Code headless in CI, authenticated with a subscription OAuth token

- Status: Superseded by 0016
- Date: 2026-10-29
- Deciders: architect (pending human)

## Context

ADR 0002 runs every agent in Claude Code with the Claude Pro subscription, and the constitution forbids
API keys. The dispatcher runs unattended on a GitHub runner, so it cannot sign in interactively.

## Decision

Run Claude Code non-interactively (`claude -p`, JSON output) with a long-lived OAuth token generated
once by the human with `claude setup-token` and stored as the `CLAUDE_CODE_OAUTH_TOKEN` repository
secret. Pin the Claude Code CLI version in the workflow and upgrade it through a PR.

## Considered options

- **Subscription OAuth token:** uses Claude Pro as required; token must be rotated by the human when it
  expires or leaks.
- **Anthropic API key:** simplest in CI; forbidden by the constitution and outside the budget.
- **Self-hosted runner on a logged-in PC:** reuses the interactive login; requires the PC to be on.

## Consequences

- Runs share the human's Pro quota and 5 h window; the schedule is spaced 2 h apart.
- Generating and storing the token is a `needs-human` task.
- If Anthropic changes the terms for subscription use in automation, a new ADR is needed.
