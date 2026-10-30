# 0003. Spec-Driven Development with ADRs

- Status: Accepted
- Date: 2026-10-29
- Deciders: human

## Context

Specialists are "hired for minutes" and do not know the project's history. Without a written record,
each one reopens past decisions and the work drifts from the intent.

## Decision

Follow the flow constitution → spec → plan + ADRs → tasks → issues → implementation.
Specs live in `specs/<feature>/`; technical decisions in `docs/adr/` using the MADR format.
No issue is implemented without a spec approved by the human.

## Considered options

- **Issues without specs:** faster at first; agents guess the intent.
- **GitHub Spec Kit or OpenSpec as tooling:** compatible; can be adopted later without changing the layout.

## Consequences

- More documentation work at the start of each feature.
- Any new agent gets the full context by reading the repo.
