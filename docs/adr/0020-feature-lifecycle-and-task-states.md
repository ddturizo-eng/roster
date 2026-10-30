# 0020. Feature lifecycle state machine, task states, and gates approved by detected PR merges

- Status: Proposed
- Date: 2026-10-30
- Deciders: architect (pending human)

## Context

Spec 002 requires a feature to move through idea, analysis, spec approved, plan approved, execution
and delivered, in order, never skipping a stage. Each gate (spec, plan) is approved by the human
merging the PR that contains it; Roster detects the merge and records its date. Grilling is
interactive in the terminal with recorded answers. The vision proposes two levels of orchestration:
a lifecycle with human gates and a deterministic task DAG inside an approved plan.

## Decision

### Feature stages and steps

| Stage | Steps inside the stage | Leaves when |
| --- | --- | --- |
| `idea` | `recorded` | `roster feature new` starts the analysis |
| `analysis` | `questions_pending`, `answers_recorded`, `drafting`, `spec_pr_open` | spec PR merged |
| `spec_approved` | `plan_job_pending`, `plan_running`, `plan_pr_open` | plan PR merged |
| `plan_approved` | `importing`, `import_failed` | `tasks.md` imported without errors |
| `execution` | `running` | every task of the feature is `done` or `cancelled` |
| `delivered` | `done` | final |

- The transition function in `core/lifecycle` accepts only the next stage and refuses anything else.
  Every transition writes a `feature_events` row with its evidence: the PR URL and `mergedAt` for
  gates, or the `main` commit for features adopted with `roster feature import`.
- A closed, unmerged spec or plan PR keeps the stage and sets the step back (`answers_recorded` or
  `plan_job_pending`) with a recorded reason.
- The architect job is a stage job that `roster run` picks before tasks (ADR 0015).

### Task states

`todo`, `waiting_hire`, `running`, `in_review`, `done`, `blocked`, `failed`, `stopped`, `rejected`,
`cancelled`. "Ready" is computed, not stored (ADR 0019).

```
todo ─► running ─► in_review ─► done            (PR merged, detected by sync)
            │           └──────► rejected        (PR closed without merge)
            ├─► todo                             (quota exhausted, ADR 0028)
            ├─► blocked | failed | stopped
todo ─► waiting_hire ─► todo                     (hire PR merged, ADR 0027)
blocked | failed | stopped | rejected ─► todo    (human retry)
```

### Gate detection

The sync step (start of `roster run`, `roster sync`) asks GitHub for the state of every PR Roster
opened and has not seen closed: gate PRs, hire PRs and task PRs. A merged PR updates the store with
`mergedAt`. Roster never merges.

## Considered options

- **Explicit stages with sub-steps, merge detection by polling at run start:** deterministic,
  testable, no webhooks or servers; detection waits until the next run or `roster sync`.
- **Webhooks from GitHub:** instant; needs a public endpoint, against local-first.
- **A separate approval command:** explicit; the spec decided merge is the approval and there is no
  separate command.
- **A workflow engine (Temporal or similar):** durable; far too heavy for one user and concurrency 1.

## Consequences

- The human approves a whole spec or plan in one merge.
- State is advanced only by Roster code from verifiable evidence, never by agent output.
- A feature cannot reach execution without both merges recorded, which `roster status` shows.
