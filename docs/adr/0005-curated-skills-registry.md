# 0005. Curated skills registry for specialists

- Status: Accepted
- Date: 2026-10-29
- Deciders: human

## Context

Specialists perform better with domain skills (for example UI polish or animation skills for a
frontend specialist). Skills are third-party code and instructions: they can run scripts and change
agent behavior, so installing them automatically is a supply-chain risk.

## Decision

`hr-director` may assign skills to a specialist only from `skills/registry.md` entries with status
`approved`. Approved skills are pinned to a source and ref and live in `.claude/skills/<name>/`.
When a profile needs a skill that is not approved, `hr-director` adds it as `proposed` and the issue
gets `needs-human`; the human reviews the skill's content before approving it.

## Considered options

- **Agents install skills on their own:** fastest; any agent can pull untrusted code.
- **No skills:** safest; specialists lose domain expertise.

## Consequences

- The first issues of a new domain wait for a human skill review.
- The registry grows into a reusable, reviewed toolkit.
