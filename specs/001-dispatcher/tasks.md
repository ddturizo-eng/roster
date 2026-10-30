# Tasks 001 — Async dispatcher

- Spec: `specs/001-dispatcher/spec.md`
- Plan: `specs/001-dispatcher/plan.md`
- ADRs: 0006-0013 (must be Accepted before T01 starts)
- Status: Superseded with spec 001 (2026-10-30). Do not execute. Linear issues ROS-5 to ROS-19 are frozen.

Each task is about 2 h of agent work, verifiable on its own, and ends with a PR against `main`.
All code lives in `dispatcher/` unless stated. Tasks marked `needs-human` require the human
(credentials, repository settings or real Linear data); agents must not perform them.

Suggested order (one executing agent at a time): T01, T02, T03, T05, T07, T04, T06, T08, T09, T10,
T11, T12, T14, T15. T13 (`needs-human`) can be done by the human at any time before T15.
Each task's "Depends on" line is the authoritative "blocked by" list.

---

## T01. Scaffold the dispatcher package and its CI

- Depends on: none
- Areas: `dispatcher/package.json`, `dispatcher/tsconfig.json`, `dispatcher/src/`, `dispatcher/test/`,
  `.github/workflows/dispatcher-ci.yml`
- Acceptance criteria:
  - `package.json` declares `"type": "module"`, `"engines": { "node": ">=24" }`, no runtime
    dependencies, and dev dependencies `typescript`, `vitest`, `@types/node` with a lockfile.
  - Scripts: `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `start` (`node src/main.ts`).
  - `tsconfig.json` is strict and enables `erasableSyntaxOnly` (or equivalent) so code stays runnable
    with Node type stripping.
  - A placeholder `src/main.ts` prints usage; one sample test passes.
  - `dispatcher-ci.yml` runs `npm ci`, `typecheck` and `test` on PRs that touch `dispatcher/**`.
- Verification: `npm run typecheck && npm test` pass locally; the CI workflow passes on the PR.

## T02. Config loader and comment templates

- Depends on: T01
- Areas: `dispatcher/src/config.ts`, `dispatcher/src/messages.ts`, tests
- Acceptance criteria:
  - `loadConfig()` reads `LINEAR_API_KEY`, `GH_TOKEN`, `ROSTER_HARNESS` (default `claude-code`),
    `ROSTER_TEAM_KEY` (default `ROS`), state names (defaults `Todo`, `In Progress`, `In Review`,
    `Blocked`), `ROSTER_AGENT_TIMEOUT_MIN` (default 90) and fails with a clear error listing every
    missing required variable.
  - `human_language` is parsed from `specs/constitution.md`; unknown or missing value falls back to `en`.
  - `messages.ts` exposes templates for: started, quota returned to Todo, closing (what / how verified /
    PR link), blocked (agent question), blocked (failure reason), blocked (hire PR to review).
    Blocked templates exist in `es` and `en`; the others are English (see plan, resolved question 5).
  - No secret value is ever included in an error message.
- Verification: unit tests cover defaults, missing variables, `es` and fallback rendering.

## T03. Linear GraphQL client

- Depends on: T01
- Areas: `dispatcher/src/linear.ts`, `dispatcher/test/fixtures/linear/`, tests
- Acceptance criteria:
  - Uses `fetch` against `https://api.linear.app/graphql` with the API key header; no SDK.
  - `listTodoIssues(teamKey, stateName)` paginates and returns id, identifier, number, title,
    description, priority, createdAt, url, label names with their parent group name, and for each
    "blocked by" relation the blocking issue's state type.
  - `getIssueComments(id)`, `setState(id, stateName)` (resolves the state id by name within the team),
    `addLabel(id, labelName)`, `ensureAgentLabel(teamId, slug)` (creates the label under the `agent`
    group when missing), `comment(id, body)`.
  - GraphQL errors and HTTP errors raise typed errors with the operation name.
- Verification: unit tests with mocked `fetch` and recorded JSON fixtures, including pagination and an
  error response.

## T04. Issue selection

- Depends on: T03
- Areas: `dispatcher/src/select.ts`, tests
- Acceptance criteria:
  - Pure function `selectIssue(candidates)` returns one issue or `null`.
  - Excludes issues with label `needs-human` and issues with any blocker whose state type is not
    `completed` or `canceled`.
  - Orders by priority 1, 2, 3, 4, then 0 (no priority); ties by oldest `createdAt`; then lowest number.
- Verification: table-driven tests covering every rule and each tie-breaker.

## T05. Neutral agent definition reader

- Depends on: T01
- Areas: `dispatcher/src/agents.ts`, tests
- Acceptance criteria:
  - `readAgent(repoRoot, slug)` parses `agents/<slug>.md` frontmatter (`name`, `description`,
    `tools` as list, `skills` as list, optional) and returns the body.
  - Rejects slugs that are not `^[a-z0-9-]+$` (prevents path traversal).
  - Missing file or malformed frontmatter raises a typed error.
- Verification: unit tests with the real `agents/hr-director.md` and invalid samples.

## T06. Harness interface, registry and Claude Code adapter

- Depends on: T05
- Areas: `dispatcher/src/harness/types.ts`, `index.ts`, `claude-code.ts`, `dispatcher/test/fakes/`, tests
- Acceptance criteria:
  - Interface and outcome kinds as in ADR 0010; registry selects by `ROSTER_HARNESS` and fails on unknown names.
  - A `FakeHarness` for tests can script any outcome and write a result file.
  - Claude Code adapter runs `claude -p` with JSON output, the agent body as appended system prompt,
    its `tools` as allowed tools, its skills named in the prompt, and `Bash(git push:*)` denied.
  - The child process environment is allow-listed: `GH_TOKEN`, `GITHUB_TOKEN` and `LINEAR_API_KEY`
    are never passed.
  - Maps exit code and output to `completed`, `quota_exhausted` (usage-limit patterns kept in one
    constant), `timeout` (kills the process after the configured time) or `error`.
- Verification: unit tests with a stubbed spawn: argument list, sanitized env, each outcome mapping.

## T07. Git and GitHub operations with push guard

- Depends on: T01
- Areas: `dispatcher/src/git.ts`, tests
- Acceptance criteria:
  - `prepareBranch(n)`: checks out `agent/ROS-<n>` from `origin` when it exists (reports `resumed: true`),
    otherwise creates it from `origin/main`.
  - `commitAll(message)`, `hasCommitsAhead(base)`, `changedPaths(paths)`.
  - `push(branch, token)` refuses any destination outside `refs/heads/agent/` and never uses `--force`
    or pushes `main`; the token is passed per command and not written to git config.
  - `ensurePr({ branch, title, body })` reuses an open PR for the branch or creates one against `main`
    with `gh`; returns the PR URL.
- Verification: tests against a temporary local repo with a bare `origin`, including push to `main`
  rejected by the guard; `gh` calls tested with a stubbed runner.

## T08. Hiring step

- Depends on: T03, T06, T07
- Areas: `dispatcher/src/hire.ts`, tests
- Acceptance criteria:
  - Builds the `hr-director` prompt with the full issue and the result-file path; runs it through the harness.
  - Validates the result (`slug`, `skills`, `reason`, `needsHuman`) and that `agents/<slug>.md` exists.
  - No changes in `agents/` or `skills/registry.md`: ensures and applies the `agent` label, returns
    `continue` with the slug.
  - Changes present: commits on `agent/ROS-<n>-hire`, pushes, opens PR `ROS-<n>: hire <slug>`, applies
    the label, returns `blocked` with the PR URL (ADR 0012).
  - Harness error or invalid result returns `failed` with a reason.
- Verification: unit tests with `FakeHarness`, fake Linear and a temporary repo for the three outcomes.

## T09. Orchestrator: happy path

- Depends on: T02, T04, T08
- Areas: `dispatcher/src/run.ts`, tests
- Acceptance criteria:
  - With injected ports (Linear, git, harness, clock), runs: select, hire if needed, In Progress +
    started comment (with run URL and agent slug), prepare branch, run specialist, read result,
    push, ensure PR titled `ROS-<n>: <title>` whose body mentions `ROS-<n>` without closing keywords,
    closing comment, In Review.
  - Writes `$RUNNER_TEMP/roster-current.json` with the issue id once it is In Progress and removes it at the end.
  - No candidate: exits without side effects.
  - Never processes more than one issue.
- Verification: unit test asserting the exact ordered list of side effects for the happy path and for
  an empty queue.

## T10. Orchestrator: blocked, failure and quota paths

- Depends on: T09
- Areas: `dispatcher/src/run.ts`, tests
- Acceptance criteria:
  - Result `blocked`: Blocked + comment with the agent's question.
  - Harness `error`/`timeout`, missing or invalid result, no commits ahead of `main`, push or PR
    failure, or any unexpected exception after In Progress: Blocked + comment in `human_language`
    with the reason; no PR.
  - Hire `blocked`: Blocked + hire-PR comment; specialist not run. Hire `failed`: Blocked + reason.
  - `quota_exhausted`: WIP commit, push branch without PR, Todo + comment (ADR 0013).
  - Resumed branches add a resume note to the specialist prompt.
  - Failed issues are never retried by the dispatcher.
- Verification: one unit test per path asserting final state, comment template and absence of PR when expected.

## T11. CLI: run, dry-run, doctor, recover

- Depends on: T10
- Areas: `dispatcher/src/main.ts`, tests
- Acceptance criteria:
  - `run` wires real adapters; exit code 0 on handled outcomes, non-zero only on dispatcher bugs.
  - `run --dry-run` prints the selected issue and the planned steps, with no writes to Linear or git.
  - `doctor` checks that required variables are set, the team, the four states, the `agent` group and
    `needs-human` label exist in Linear, and that the harness CLI is installed; prints a pass/fail list.
  - `recover` reads `roster-current.json` and, if present, moves that issue to Blocked with a
    "run interrupted" comment.
- Verification: unit tests with fakes for each command; `--dry-run` output covered by a snapshot test.

## T12. Scheduled workflow

- Depends on: T11
- Areas: `.github/workflows/dispatcher.yml`
- Acceptance criteria:
  - Triggers: `schedule` with cron `0 3,5,7,9,11 * * *` and `workflow_dispatch`
    with a `dry_run` input.
  - `concurrency: { group: roster-dispatcher, cancel-in-progress: false }`, `timeout-minutes: 100`.
  - `permissions: { contents: write, pull-requests: write }` only.
  - `actions/checkout` with `fetch-depth: 0` and `persist-credentials: false`; Node 24 setup;
    `npm ci` in `dispatcher/`; Claude Code installed at a pinned version.
  - Secrets `CLAUDE_CODE_OAUTH_TOKEN` and `LINEAR_API_KEY` passed as env; `GH_TOKEN` from `github.token`.
  - Runs `doctor`, then `run`; a final step with `if: cancelled() || failure()` runs `recover`.
  - Git author set to a bot identity (`roster-dispatcher`).
- Verification: `actionlint` passes; a PR description lists each criterion with the matching line.

## T13. Credentials and repository settings — `needs-human`

- Depends on: ADRs 0007 and 0011 accepted
- Areas: GitHub repository settings, Linear workspace settings
- Acceptance criteria:
  - The human runs `claude setup-token` and stores the token as secret `CLAUDE_CODE_OAUTH_TOKEN`.
  - The human creates a Linear personal API key and stores it as secret `LINEAR_API_KEY`.
  - Branch protection on `main`: PR required, no direct pushes, no force pushes, applies to admins
    and to GitHub Actions.
  - Linear team `ROS` has states Todo, In Progress, In Review, Blocked, the `needs-human` label and an
    `agent` label group.
- Verification: the human confirms in the issue (without pasting any secret); the `doctor` step of the
  first T15 run passes.

## T14. Documentation

- Depends on: T12
- Areas: `README.md`, `AGENTS.md`, `dispatcher/README.md`
- Acceptance criteria:
  - `dispatcher/README.md`: what it does, run flow, env vars, commands, how to add a harness adapter,
    how to rotate secrets, troubleshooting (late schedules, workflow disabled after inactivity,
    agent PRs not triggering CI, workflow-file pushes rejected).
  - `AGENTS.md`: note that in dispatcher runs rule 7 is fulfilled through the result file (ADR 0009)
    and agents must not push.
  - Root `README.md`: Phase 2 section pointing to the dispatcher and its setup steps.
- Verification: links resolve; content matches plan and ADRs (reviewer checklist in the PR).

## T15. End-to-end smoke test — `needs-human`

- Depends on: T12, T13, T14
- Areas: GitHub Actions, Linear team `ROS` (real data)
- Acceptance criteria:
  - With one trivial test issue in Todo (for example "add a line to a sandbox file") labeled with an
    existing agent, a manual `workflow_dispatch` run with `dry_run: true` selects it and writes nothing.
  - A real manual run moves it to In Progress, then In Review, with started and closing comments, and a
    PR from `agent/ROS-<n>` against `main` that mentions `ROS-<n>`.
  - A second test issue with no `agent` label ends in either a reused-agent run or a hire PR + Blocked
    with a Spanish comment.
  - A third test issue with ambiguous text ends in Blocked with a Spanish question and no PR.
  - The scheduled trigger fires at least once on its own.
- Verification: the human records run URLs, PR links and final statuses in the issue.
