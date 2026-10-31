# 0019. Machine-readable `tasks.md` format and import rules

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human
- Amended by: 0032 (import step 1 reads `origin/<baseBranch>` of the project)

## Context

ADR 0014 makes `tasks.md` the import format of the store and, during bootstrap, the tracker itself
(checked boxes plus PRs). Spec 002 requires that an import with a dependency cycle is rejected and
names the cycle, that a task is ready when it is not `needs-human` and all its dependencies have a
merged PR, and that agents never edit the DAG (vision 4.1.8). Spec 001's `tasks.md` was readable by
humans but had no strict structure.

## Decision

### Format

- A task starts at a level-2 heading `## T<nn>. <title>` (`nn` = two or three digits) and ends at the
  next level-2 heading or the end of the file. Any other level-2 heading (for example a phase title)
  only ends the previous task. Text before the first task is a free preamble.
- Inside a task, fields are top-level list items `- <Key>: <value>`, in any order:

| Key | Required | Value |
| --- | --- | --- |
| `[ ] Done` / `[x] Done` | yes | checkbox; during bootstrap, checked in the task's own PR |
| `Depends on` | yes | `none`, or comma-separated task ids of the same file (`T01, T03`) |
| `Needs human` | no | free text reason; its presence marks the task `needs-human` |
| `Agent` | no | slug in `agents/`, set by `hr-director` |
| `Profile` | no | informational profile kind (for example `TS core`) |
| `Areas` | no | comma-separated paths in backticks |
| `Acceptance criteria` | yes | nested list (two-space indent) with at least one item |
| `Verification` | yes | free text |

- Unknown keys are a warning, not an error. Task ids are unique; titles are one line.

### Import

1. Parse the file from `origin/main`. Errors name the line and the task id.
2. Reject the whole import, writing nothing, if: an id repeats, a dependency names a missing id, a
   task depends on itself, or the graph has a cycle. A cycle error names one cycle in order, for
   example `T03 -> T07 -> T05 -> T03`.
3. Create a task per entry with id `<project>:<NNN>-<Tnn>`, its order in the file, the full task text
   (`body_md`), `needs_human`, agent and the source commit. Edges go to `task_dependencies`.
4. `[x] Done` imports the task as `done` with the commit that checked it as evidence, only on the first
   import of that task.

### Re-import (a later plan PR merged)

- Matched by task id. Text, agent, `Needs human` and dependencies are updated for tasks not yet
  started (`todo`, `blocked`, `failed`, `stopped`, `rejected`).
- Tasks `done`, `in_review` or `running` keep their state; changed text is recorded as an event.
- A task removed from the file is `cancelled` if it never started. If it is `running` or `in_review`,
  the re-import is rejected with that reason.

### Readiness and selection

- Ready = status `todo`, no `Needs human`, and every dependency has status `done` (its PR merged).
- Selection: oldest feature in stage `execution` first, then file order.
- Agents never write `tasks.md` after bootstrap: the architect proposes changes in a plan PR and the
  human merges it.

## Considered options

- **Strict Markdown as above:** stays readable and reviewable in PRs, renders checkboxes on GitHub,
  parses with a small hand-written parser.
- **YAML or JSON task file:** trivial to parse; poor to read and review, needs a YAML parser or loses
  comments and prose.
- **Markdown with YAML front blocks per task:** structured; mixes two syntaxes and needs a YAML parser.

## Consequences

- The architect must follow the format; the parser gives exact errors when it does not.
- During bootstrap, the checkbox is the status; after the first import, the store is the status and
  checkboxes are ignored for existing tasks.
- Plan 002's `tasks.md` uses this format and is the first file Roster imports.
