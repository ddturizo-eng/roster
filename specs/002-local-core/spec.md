# Spec 002 — Local core MVP

- Status: Approved (2026-10-30, PR #2 merged)
- Date: 2026-10-30
- Author: human + Claude
- Supersedes: spec 001
- Inputs: `docs/architecture/vision.md`, ADR 0014
- Amended: 2026-10-30, live activity view `roster watch` (user story 8), added by the human; merging
  its PR is the approval.
- Amended: 2026-10-30, base branch and agent branch prefix per project (ADR 0032), requested by the
  human for gitflow projects; merging its PR is the approval.

## Problem

Today the Roster flow works only by hand: the human opens a Claude Code session and invokes the
architect, the HR Director and each specialist one by one, and tracks the work in an external tool.
Nothing moves when the human is away, nothing records what each run did, and the process depends on
Linear, which Roster no longer uses (ADR 0014).

## Goal

A local CLI, `roster`, that drives one feature of a registered project from an idea to reviewable PRs,
with human approval at each gate, executing tasks in isolated containers through Claude Code on the
human's subscription, and recording every execution in Roster's local store.

Roster's own repository is a registered project like any other, so Roster can build itself.

## User stories

1. As the human, I want to register a project (a local repo with a GitHub remote) once, so Roster knows
   where to work.
2. As the human, I want to write an idea and get questions back before any spec is written, so wrong
   assumptions surface early (grilling).
3. As the human, I want to approve the spec and then the plan, and nothing to be implemented before
   both are approved.
4. As the human, I want each task of an approved plan executed by a fitting specialist in an isolated
   container, and to find the result as a PR on the task's agent branch: `agent/<feature>-<task>` by
   default, or `<prefix>/agent-<feature>-<task>` when the project uses another branch prefix.
5. As the human, I want to leave ready tasks before going to sleep, with my PC on, and find reviewable
   PRs in the morning.
6. As the human, I want a blocked or ambiguous task to stop with its question written in my language,
   instead of a guessed PR.
7. As the human, I want to see the state of a feature, its tasks and their executions from the CLI,
   and to stop a running execution.
8. As the human, I want to watch live in the terminal which agent is running, on which task, and what
   it is doing right now, step by step, so I can follow an execution of any project without opening
   its log files.
9. As the human, I want a project that uses gitflow to get agent branches from its base branch (for
   example `develop`), PRs against that branch, and branch names under its own prefix (for example
   `feature/`), so Roster fits the project's conventions.

## Acceptance criteria

### Projects and lifecycle

- [ ] A project is registered with a name, a local repo path and its GitHub remote. Registration is
      reviewable in git.
- [ ] A registration may name the project's base branch (default `main`) and agent branch prefix
      (default `agent`). The Roster repo itself always uses `main` and `agent` (ADR 0032).
- [ ] A feature moves through these stages, in order: idea, analysis, spec approved, plan approved,
      execution, delivered. It never skips a stage.
- [ ] From an idea, an analyst agent produces open questions and, after the human's answers, a spec
      draft in `specs/<feature>/spec.md` of the project repo.
- [ ] From an approved spec, the `architect` produces `plan.md`, `tasks.md` and the ADRs.
- [ ] Every gate (spec, plan) requires an explicit human approval: the human merges the PR that
      contains the spec or the plan. Roster detects the merge and records its date.

### Tasks

- [ ] Tasks are imported from the approved `tasks.md`. An import with a dependency cycle is rejected
      and names the cycle.
- [ ] A task is ready when it is not `needs-human` and every task it depends on has a merged PR.
- [ ] A task with no agent assigned goes through `hr-director` first; a new or changed agent follows
      the hire PR gate (ADR 0012).

### Execution

- [ ] `roster run` executes at most one ready task per invocation (constitution constraint).
- [ ] Each execution runs in a fresh Docker container where only the task's worktree is mounted.
      Roster's store, policies and GitHub credentials are not inside it.
- [ ] The agent runs headless through the Claude Code runtime with the human's subscription login.
      The runtime is a parameter: adding another runtime does not change the orchestration logic.
- [ ] The agent returns a structured result (status, summary, verification, questions) that Roster
      validates before doing anything else.
- [ ] After the agent finishes, Roster runs the project's verification commands itself and records
      their outcome.
- [ ] Roster, not the agent, commits, pushes the task's agent branch (created from the project's base
      branch) and opens a PR against the base branch that names the task. It never pushes to `main`
      or to the base branch, never pushes a branch without the agent marker, and never force-pushes.
- [ ] A change that touches a protected path (policies, permission settings, hooks, guards,
      constitution) is not pushed; the task stops and asks the human.
- [ ] A failed or ambiguous task stops with its reason or question written in `human_language`.
- [ ] If the quota runs out mid-task, the work is kept on the agent branch and the task returns to
      ready (as in ADR 0013).
- [ ] `roster run` can be started by the local scheduler (Windows Task Scheduler) with nobody present.

### Visibility and control

- [ ] Every execution is recorded in the local store: task, agent, runtime, start, end, status, log
      location and PR link.
- [ ] `roster status` shows the feature's stage, each task with its state, and the latest executions.
- [ ] `roster stop` ends a running execution: the container is killed and the task is marked stopped.
- [ ] `roster watch` shows, live in the terminal, the running execution: its agent, its task and
      feature, the elapsed time, the current job (agent, review, setup or verify) and the latest
      rate-limit snapshot (ADR 0030).
- [ ] While an agent job runs, `roster watch` prints one line per step the agent takes, translated
      from the runtime's output (for example `Read src/x.ts`, `Edit src/y.ts`, `Bash: npm test`,
      `denied: Bash (not allowed)`), and then the job's final result.
- [ ] When nothing is running, `roster watch` says so and shows the outcome of the last execution;
      it follows the next execution as soon as one starts.
- [ ] `roster watch` is read-only: it never sends input to the agent, never takes the run lock and
      never changes the store. It works from a second terminal while `roster run` runs, including a
      run started by Windows Task Scheduler.
- [ ] `roster watch` never shows a secret: it reads only the store and the redacted execution logs,
      and it does not show tool output or file contents.

## Out of scope

- Web dashboard (its own spec, reading the same store and execution logs).
- Runtimes other than Claude Code (only the adapter interface exists).
- Several tasks in parallel.
- Autonomous merges, deploys and database migrations.
- Configurable autonomy levels L0-L3 (the MVP uses one fixed policy, see Decisions).
- Memory beyond the project's versioned documents and the execution log.
- C4 diagram generation.
- Any Linear integration, and multi-user features.
- A different branch prefix per task (for example `fix/` for some tasks and `feature/` for others):
  one prefix per project (ADR 0032).

### Decisions (answered by the human on 2026-10-30)

- **Interface:** CLI only in this spec. The web UI comes later in its own spec.
- **Runtime credentials:** a token from `claude setup-token` reaches the container as the
  `CLAUDE_CODE_OAUTH_TOKEN` environment variable. The container's network egress only allows the
  provider's API. The human accepts that the agent could read this token.
- **Fixed MVP policy:** reading, writing inside the worktree and running tests are automatic.
  Installing dependencies needs human approval. Only Roster commits, pushes and opens PRs. No deletes
  outside the worktree, no migrations, no deploys.
- **Grilling:** questions are asked interactively in the terminal and the answers are recorded.
- **Code review:** in scope (see the criterion below).
- **Approvals:** merging the PR that contains a spec or a plan is its approval, the same mechanism as
  ADR 0012. There is no separate approval command.
- **Live activity view (added by the human on 2026-10-30):** `roster watch` is in scope (user story 8
  and its criteria under "Visibility and control"). Roster will build other projects, and the human
  wants one place to see which agent is running and what it is doing right now. Concurrency stays 1,
  so there is at most one running agent. A later web dashboard will read the same data; its design
  is out of scope here.
- **Base branch and branch prefix (requested by the human on 2026-10-30):** many target projects use
  gitflow. Each registration may set `baseBranch` and `branchPrefix` (user story 9, ADR 0032). The
  human protects `main` and the base branch on GitHub and reviews every PR; Roster only opens PRs and
  never merges. For a project with base `develop`, "approved" means merged into `develop`.

### Code review

- [ ] Before the PR is opened, a code-reviewer agent reviews the diff against the task's acceptance
      criteria and the project's ADRs, and its findings are included in the PR description.

### Provider terms (checked 2026-10-30)

Sources: Anthropic Consumer Terms (effective 2025-10-08), Claude Code "Legal and compliance" and
"Authentication" docs.

- The Consumer Terms forbid automated access "except when you are accessing our Services via an
  Anthropic API Key or where we otherwise explicitly permit it".
- The Claude Code docs explicitly offer `claude setup-token` "for CI pipelines, scripts, or other
  environments where interactive browser login isn't available", on Pro, Max, Team or Enterprise plans.
- Subscription OAuth is meant for "ordinary use of Claude Code"; Pro and Max limits "assume ordinary,
  individual usage". Developers building products or services for others must use API keys, and may
  not offer Claude.ai login or route requests through subscription credentials on behalf of users.

Reading (not legal advice): Roster fits the permitted case because it is personal, has one user, and
runs the unmodified Claude Code CLI with the human's own token. These constraints follow:

- [ ] Roster runs the official, unmodified `claude` binary. It does not call the API with the
      subscription token, and it does not use the Agent SDK with subscription credentials.
- [ ] Roster never reads Claude credential files (for example `.credentials.json`). It only passes on
      the `CLAUDE_CODE_OAUTH_TOKEN` the human provides, stored outside every workspace and outside git.
- [ ] Roster does not run Claude Code in `--bare` mode, which ignores `CLAUDE_CODE_OAUTH_TOKEN`.
- [ ] Usage stays individual: one execution at a time and a bounded number of runs per night.
- [ ] If Roster is ever used by anyone other than the human, a new ADR is needed: each user brings
      their own credentials, or Roster switches to API keys.
