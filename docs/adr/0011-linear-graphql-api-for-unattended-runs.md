# 0011. Linear as the source of truth; GraphQL API for unattended runs

- Status: Accepted
- Date: 2026-10-29
- Deciders: architect (pending human)
- Supersedes: 0001

## Context

ADR 0001 makes Linear the single source of truth and says it is accessed through the official MCP
server. The MCP server is built for LLM sessions with interactive OAuth sign-in. The dispatcher
(ADR 0008) is deterministic code running in CI: it needs exact filters (blocked-by relations, priority,
labels), stable response shapes and non-interactive authentication.

## Decision

Keep everything ADR 0001 decided: Linear (free plan) is the single source of truth for work status, and
agents communicate only through issues and comments. Change only the access method:

- Interactive agent sessions keep using the official Linear MCP server (`.mcp.json`).
- The dispatcher uses the Linear GraphQL API (`https://api.linear.app/graphql`) with a personal API key
  stored as the `LINEAR_API_KEY` repository secret, through a minimal client without dependencies.

## Considered options

- **GraphQL API for the dispatcher:** precise queries, typed, testable with fixtures; one more secret.
- **Linear MCP server called from code:** keeps one access path; tool schemas are designed for LLMs,
  may change without notice and may not expose relations in the needed shape.
- **`@linear/sdk`:** typed client; large dependency for a handful of queries.

## Consequences

- Two access paths to Linear must stay consistent with the same statuses and labels.
- The API key is a credential the human creates and rotates (`needs-human`).
- The considerations of ADR 0001 (free plan issue cap, migration needs a new ADR) still apply.
