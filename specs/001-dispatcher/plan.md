# Plan 001 — Async dispatcher

- Spec: `specs/001-dispatcher/spec.md` (approved 2026-10-29)
- Date: 2026-10-29
- Author: architect
- ADRs: 0006, 0007, 0008, 0009, 0010, 0011, 0012, 0013 (all Proposed)

## Summary

A small, deterministic TypeScript program (the **dispatcher**) runs on a GitHub Actions schedule.
Each run picks at most one ready Linear issue from team `ROS`, makes sure it has a specialist
(through `hr-director` when needed), runs that specialist headless through a **harness adapter**
(Claude Code today), and turns the outcome into Linear status changes, comments, a branch and a PR.

The LLM is only used where judgment is needed: choosing/defining the specialist and doing the work.
Selection, status transitions, comments, pushes and PRs are plain code, so they are testable,
cheap on quota, and cannot be skipped or improvised by an agent.

## Components

All code lives in a new top-level folder `dispatcher/`. No runtime dependencies beyond Node.js 24
built-ins (`fetch`, `child_process`, `fs`); dev dependencies are `typescript`, `vitest`, `@types/node`.

| Module | Responsibility |
| --- | --- |
| `src/config.ts` | Reads env vars (`LINEAR_API_KEY`, `GH_TOKEN`, `ROSTER_HARNESS`, `ROSTER_TEAM_KEY=ROS`, state names, timeouts) and `human_language` from `specs/constitution.md`. Fails fast on missing values. |
| `src/linear.ts` | Minimal Linear GraphQL client (ADR 0011): list Todo issues of the team with labels, priority, `createdAt` and "blocked by" relations; update state; add label; create label inside the `agent` group; post comment. |
| `src/select.ts` | Pure function: candidates in, at most one issue out (rules below). |
| `src/agents.ts` | Reads `agents/<slug>.md`, parses frontmatter (`name`, `description`, `tools`, `skills`) and body. Harness-neutral. |
| `src/harness/types.ts` | `Harness` interface and `HarnessOutcome` type (ADR 0010). |
| `src/harness/claude-code.ts` | Claude Code adapter: runs `claude -p` headless, maps exit/output to an outcome, detects quota exhaustion. |
| `src/harness/index.ts` | Registry `name -> adapter`, chosen by `ROSTER_HARNESS` (default `claude-code`). |
| `src/git.ts` | Local git and GitHub operations: prepare/resume branch `agent/ROS-<n>`, WIP commit, push (guarded to `agent/*` refs only), create or reuse PR with `gh`. |
| `src/hire.ts` | Hiring step: runs `hr-director`, reads its result file, decides "reuse approved agent" vs "hire PR needed" (ADR 0012). |
| `src/messages.ts` | Comment templates. Blocked comments in `human_language` (`es` today, `en` fallback); other comments in English. |
| `src/run.ts` | Orchestrator: the state machine below. All side effects come through injected ports so it is unit-testable with fakes. |
| `src/main.ts` | CLI: `run`, `run --dry-run`, `doctor`, `recover`. |
| `.github/workflows/dispatcher.yml` | Schedule, manual trigger, concurrency, permissions, install pinned Claude Code, run, recovery step (ADR 0006). |
| `.github/workflows/dispatcher-ci.yml` | Typecheck and tests on PRs touching `dispatcher/`. |

## Selection rules (spec AC 1-3)

1. Team key `ROS`, workflow state named `Todo`.
2. No label `needs-human`.
3. No open "blocked by" relation: every issue that blocks it has a state of type `completed` or `canceled`.
4. Order by priority Urgent (1), High (2), Medium (3), Low (4), then No priority (0) last — the same
   order Linear uses in its UI. Ties: oldest `createdAt` first. Final tie: lowest issue number.
5. Take the first one. One issue per run, never more.

## Run flow

```
start
 ├─ select issue ─ none ──────────────────────────────► exit 0 ("nothing to do")
 ├─ has label in group `agent`? ── no ─► hiring step (ADR 0012)
 │     ├─ hr-director reused an agent already on main ─► apply label, continue
 │     ├─ hr-director created/changed agents/ or skills/registry.md
 │     │      ─► push branch agent/ROS-<n>-hire, open "hire" PR, issue ─► Blocked (+ comment es)
 │     └─ hr-director failed / invalid result ─► Blocked (+ comment es)
 ├─ issue ─► In Progress, comment "Run <run-url> started with agent <slug>"
 ├─ prepare branch agent/ROS-<n> (resume from origin if it exists, else from main)
 ├─ harness.run(specialist, prompt with full issue + result-file path)
 │     ├─ quota_exhausted ─► WIP commit + push branch, issue ─► Todo (+ comment) (ADR 0013)
 │     ├─ error / timeout / missing or invalid result ─► Blocked (+ comment es with reason)
 │     ├─ result.status = blocked ─► Blocked (+ agent's question, written in es)
 │     └─ result.status = done
 │            ├─ no commits ahead of main ─► Blocked (+ comment es)
 │            └─ push branch, create/reuse PR "ROS-<n>: <title>" against main,
 │               closing comment (what / how verified / PR link), issue ─► In Review
 └─ exit 0
```

Any unexpected exception inside the run after the issue reached In Progress moves it to Blocked
with the error summary. If the job is cancelled or times out, the workflow's `recover` step does
the same for the issue recorded in `$RUNNER_TEMP/roster-current.json`.

## Agent contract in headless runs (ADR 0009)

- The dispatcher passes the full issue (title, description, acceptance criteria, comments, spec link)
  in the prompt. The agent does not need Linear access.
- The agent writes one JSON file at a path outside the repo, given in the prompt:
  - Specialist: `{ "status": "done" | "blocked", "summary": string, "verification": string, "question"?: string }`.
    `question` is required when `status` is `blocked` and is written in `human_language`.
  - hr-director: `{ "slug": string, "skills": string[], "reason": string, "needsHuman": boolean }`.
- The agent commits on the current branch but never pushes; `git push` is denied by the adapter.
- The dispatcher posts every Linear comment and performs every status change, push and PR.
  This fulfills `AGENTS.md` rule 7 on the agent's behalf; `AGENTS.md` gets a short note about it.

## Stack

- Runtime: Node.js 24 LTS, TypeScript run directly via Node type stripping (no build step);
  `tsc --noEmit` for typechecking; Vitest for tests (ADR 0008).
- Scheduler and runner: GitHub Actions, `ubuntu-latest` (ADR 0006).
- Harness: Claude Code CLI, version pinned in the workflow, authenticated with a subscription OAuth
  token from `claude setup-token` (ADR 0007).
- Linear: GraphQL API `https://api.linear.app/graphql` with a personal API key (ADR 0011).
- GitHub: `gh` CLI (preinstalled on runners) with the workflow's `GITHUB_TOKEN`.

## Credentials and least privilege

| Secret | Used by | Exposed to agent process? |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Harness adapter | Yes (the harness needs it) |
| `GITHUB_TOKEN` (automatic) | `git.ts` for push and PR | No |
| `LINEAR_API_KEY` | `linear.ts` | No |

- The adapter spawns the harness with an allow-listed environment (`PATH`, `HOME`, the harness token,
  locale). `GH_TOKEN`, `GITHUB_TOKEN` and `LINEAR_API_KEY` are stripped.
- `actions/checkout` runs with `persist-credentials: false`; the dispatcher passes the token to
  `git push` explicitly only after the agent process has exited.
- Workflow permissions: `contents: write`, `pull-requests: write`, nothing else.
- Push guard in code: refuses any refspec whose destination is not `refs/heads/agent/*`.
- Branch protection on `main` (human task) is the second line of defense.

## Schedule (spec decision "every 2 h at night")

- Window (resolved question 3): 22:00-06:00 America/Bogota (UTC-5), i.e.
  cron `0 3,5,7,9,11 * * *` (UTC). Five runs per night, 2 h apart.
- `workflow_dispatch` for manual runs. `concurrency: { group: roster-dispatcher, cancel-in-progress: false }`.
- Job `timeout-minutes: 100` so a run ends before the next slot; adapter timeout 90 min.

## Risks

| Risk | Mitigation |
| --- | --- |
| Quota-limit message format of Claude Code changes, so quota is reported as a generic error. | Detection patterns isolated in the adapter with tests; misdetection lands in Blocked (safe), never in a wrong PR. |
| Anthropic changes terms for subscription tokens in CI. | Harness is a parameter (ADR 0010); a new ADR would switch auth or harness. |
| Prompt injection through issue text makes the agent leak the harness token. | Only workspace members write ROS issues; other secrets are not in the agent environment; token can be revoked and regenerated. |
| GitHub scheduled workflows run late or are skipped under load; disabled after 60 days without repo activity on public repos. | Accept the delay; `doctor` and the README mention re-enabling. |
| PRs opened with `GITHUB_TOKEN` do not trigger other workflows (no CI on agent PRs). | Documented; human can re-run checks. A GitHub App token is a later ADR. |
| `GITHUB_TOKEN` cannot push changes under `.github/workflows/`. | Push fails, issue goes to Blocked with that reason. |
| Linear's GitHub integration (if enabled) also moves issue states on PR events. | PR mentions `ROS-<n>` without closing magic words; documented. |
| Actions minutes on a private repo (3,000/month with GitHub Pro). | Empty runs take about 1 min; see resolved question 4. |
| A crash leaves an issue In Progress. | `recover` step with `if: cancelled() || failure()`; residual risk if the runner itself dies. |

## Resolved questions

The human accepted the proposed answers on 2026-10-29.

1. **Linear credential.** A personal Linear API key stored as the `LINEAR_API_KEY` secret is accepted as
   the one credential beyond the harness's and GitHub's (ADR 0011).
2. **New agents need human approval.** Confirmed: the hire PR (ADR 0012) is the approval gate, and it
   applies to new agents, changes to existing agents and proposed skills alike.
3. **Time zone and night window.** 22:00-06:00 America/Bogota, five runs: cron `0 3,5,7,9,11 * * *` (UTC).
4. **Repository visibility.** Keep job `timeout-minutes: 100` and adapter timeout 90 min. Revisit if
   Actions minutes approach the monthly cap.
5. **Comment language.** Blocked comments in `human_language`; start, quota and closing comments in
   English (ADR 0004).
6. **Blocked label.** The Blocked status is enough; the dispatcher does not add `needs-human`.
