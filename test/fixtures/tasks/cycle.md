# Tasks 999 - Cycle fixture

Free preamble. T03, T07 and T05 depend on each other in a ring.

## Phase A - Ring

## T01. Entry point

- [ ] Done
- Depends on: none
- Acceptance criteria:
  - Starts the work.
- Verification: none needed.

## T03. First of the ring

- [ ] Done
- Depends on: T01, T07
- Acceptance criteria:
  - Depends on T07.
- Verification: none needed.

## T05. Third of the ring

- [ ] Done
- Depends on: T03
- Acceptance criteria:
  - Depends on T03, closing the ring.
- Verification: none needed.

## T07. Second of the ring

- [ ] Done
- Depends on: T05
- Acceptance criteria:
  - Depends on T05.
- Verification: none needed.
