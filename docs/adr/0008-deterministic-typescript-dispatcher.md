# 0008. Deterministic dispatcher in TypeScript on Node.js 24

- Status: Accepted
- Date: 2026-10-29
- Deciders: architect (pending human)

## Context

The dispatcher must apply exact rules (selection order, status transitions, branch names, never push
to `main`) and save quota. An LLM session doing orchestration through prompts would spend quota and
could improvise. Claude Code is distributed through npm, so Node.js is already required on the runner.

## Decision

Write the dispatcher as plain code in `dispatcher/`, in TypeScript executed directly by Node.js 24 LTS
(native type stripping, no build step), typechecked with `tsc --noEmit` and tested with Vitest.
Use no runtime dependencies beyond Node built-ins. The LLM is invoked only for `hr-director` and the
specialist, through the harness adapter (ADR 0010).

## Considered options

- **TypeScript on Node 24:** same runtime as Claude Code, typed, no build step; type stripping only
  supports erasable syntax (no enums, no namespaces).
- **Python:** good for scripting; adds a second runtime to the runner and the repo.
- **PowerShell (like `sync-agents.ps1`):** already used; weaker testing and typing for a state machine.
- **A Claude Code session that orchestrates through prompts and MCP:** no code to write; non-deterministic
  and costs quota on every run, even when there is nothing to do.

## Consequences

- Rules are unit-tested and an empty run costs no quota.
- Contributors need Node.js 24 locally to run tests.
- Avoid TypeScript features that type stripping does not support.
