# 0021. AgentDefinition v2: capabilities, runtimes and an output contract in flat frontmatter

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human

## Context

Agent definitions in `agents/*.md` list Claude Code tool names (`tools: Read, Write, Bash`), which ties
them to one runtime. The vision proposes that an agent at run time is instructions plus required
capabilities, approved skills, preferred runtimes and a structured output contract, and that runtime
adapters translate it. ADR 0017 keeps zero runtime dependencies, so the frontmatter must parse without
a YAML library. Constitution principle 4 requires least privilege.

## Decision

`agents/<slug>.md` keeps Markdown with frontmatter, now in this flat form:

```markdown
---
schema: roster/agent@2
name: code-reviewer
description: Reviews a diff against the task's acceptance criteria and the project's ADRs.
capabilities: read
skills:
runtimes: claude-code
contract: reviewer
model.claude-code: sonnet
max-turns: 60
timeout-minutes: 20
---
<instructions: role, standards, how to verify, closing rule>
```

| Key | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | `roster/agent@2` |
| `name` | yes | equals the file slug, `^[a-z0-9-]+$` |
| `description` | yes | one line |
| `capabilities` | yes | comma list of `read`, `edit`, `shell`, `web`; `read` is implied |
| `skills` | no | comma list of skills `approved` in `skills/registry.md` (ADR 0005) |
| `runtimes` | yes | preference order, comma list of runtime names |
| `contract` | yes | `specialist`, `hr`, `analyst`, `architect` or `reviewer` (ADR 0026) |
| `model.<runtime>` | no | model hint for that runtime |
| `max-turns`, `timeout-minutes` | no | limits; the policy caps them |

Syntax: one `key: value` per line, comma-separated lists, no nesting, no quotes needed, `#` comments
allowed. Anything else is a parse error naming the line.

Compatibility: a file without `schema` is v1. Its `tools` map to capabilities (`Read`, `Grep`,
`Glob` -> `read`; `Write`, `Edit` -> `edit`; `Bash` -> `shell`; `WebFetch`, `WebSearch` -> `web`),
`runtimes` defaults to `claude-code` and `contract` to `specialist`, with a warning. v1 support is
removed once every file in `agents/` is v2.

Approval is unchanged: a definition is approved when it is on `origin/main` (ADR 0027). Capabilities
are the input of the managed settings and of the runtime router; agents cannot raise the policy.

## Considered options

- **Flat frontmatter with capabilities:** runtime-neutral, parses with built-ins, easy to review in a
  hire PR; no nested structures.
- **Full YAML frontmatter:** expressive; needs a YAML dependency.
- **Keep tool names:** no migration; ties every agent to Claude Code's tool vocabulary.
- **A separate JSON manifest per agent:** strict; two files per agent to keep in sync.

## Consequences

- Existing agents keep working through v1 compatibility; task T31 migrates them.
- `scripts/sync-agents.ps1` must translate capabilities back to Claude Code tool names for interactive
  sessions.
- Reviewers of hire PRs check capabilities and contract, not only the text (ADR 0012 lesson).
