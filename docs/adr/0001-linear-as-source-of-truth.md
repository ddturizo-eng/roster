# 0001. Linear as the source of truth for progress

- Status: Superseded by 0011
- Date: 2026-10-29
- Deciders: human

## Context

Agents work asynchronously while the human is away. The human needs one place to see, correct and
prioritize the work, without building a custom tracker.

## Decision

Use Linear (free plan) as the single source of truth for work status, accessed through its official
MCP server. Agents do not talk to each other directly: they communicate through issues and comments.

## Considered options

- **GitHub Issues + Projects:** already included in GitHub Pro; weaker status and dependency workflow.
- **Custom file-based tracker:** zero dependencies; reinvents the wheel and has no UI.

## Consequences

- The human follows everything from Linear, including from a phone.
- The free plan caps the number of issues: archive Done issues.
- If Linear changes its terms, migrating to GitHub Issues requires a new ADR.
