# 0010. Harness adapter interface in the dispatcher

- Status: Accepted
- Date: 2026-10-29
- Deciders: architect (pending human)

## Context

Spec 001 requires the harness to be a parameter: Claude Code today, and adding another harness must not
change the dispatcher's logic. Constitution principle 6 and ADR 0002 keep agent definitions neutral in
`agents/`.

## Decision

The dispatcher talks to harnesses only through one interface:
`run({ agent, prompt, cwd, resultPath, timeoutMs }) -> { kind: "completed" | "quota_exhausted" | "error" | "timeout", detail }`,
where `agent` is the parsed neutral definition from `agents/<slug>.md` (body, tools, skills).
Adapters live in `dispatcher/src/harness/`, are registered by name, and are chosen with the
`ROSTER_HARNESS` environment variable (default `claude-code`). Each adapter maps neutral tools and
skills to its harness, sanitizes the environment and denies `git push`.

## Considered options

- **Adapter interface reading `agents/` directly:** neutral, testable with a fake adapter; each adapter
  must translate tool names.
- **Run harness-specific copies (`.claude/agents/`) by name:** less code today; ties the dispatcher to
  Claude Code's agent loading and to running the sync script first.

## Consequences

- Adding a harness means a new adapter file and a registry entry; `run.ts` does not change.
- The orchestrator is tested against a fake harness.
- Quota detection is harness-specific and lives inside each adapter.
