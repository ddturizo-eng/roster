# 0004. English-first artifacts, conversation in the human's language

- Status: Accepted
- Date: 2026-10-29
- Deciders: human

## Context

Models follow instructions and specs more reliably in English, and most libraries, docs and skills
are written in English. The human's working language is Spanish.

## Decision

Everything persisted (specs, plans, ADRs, agent definitions, skills, code, commits, PRs, Linear issue
titles and descriptions) is written in English. Agents talk to the human in `human_language` from
`specs/constitution.md` (currently `es`). Input written by the human in Spanish is translated to
English before work starts.

## Considered options

- **Everything in Spanish:** easier for the human to read; weaker agent performance and mixed-language code.
- **Everything in English:** simplest for agents; harder for the human to review and answer questions.

## Consequences

- The human reviews English specs; agents can provide a Spanish summary on request.
- Adding another human language only means changing `human_language`.
