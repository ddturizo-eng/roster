# Tasks 999 - Valid fixture

Preamble text. It may mention `## T99. not a task` in prose and in a fence:

```md
## T98. also not a task
- [ ] Done
```

## Phase A - Skeleton

## T01. Scaffold the package

- [x] Done
- Depends on: none (runs first)
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `package.json`, `src/`, tests
- Acceptance criteria:
  - `package.json` exists.
  - Continued on a second line
    that is indented deeper.
- Verification: `npm test` passes.

Some prose between the fields is ignored.

## T02. Domain types

- [ ] Done
- Depends on: T01
- Needs human: needs a real token
- Colour: blue
- Acceptance criteria:
  - Types exist.
- Verification: unit tests,
  and a review.

## Phase B - Later

## T103. Three digit id

- [ ] Done
- Depends on: T01, T02
- Acceptance criteria:
  - Works.
- Verification: manual.

### Notes inside the task

A level-3 heading does not end a task.
