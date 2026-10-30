# Spec 002 — Local core MVP

- Status: Approved (2026-10-30, PR #2 merged)
- Date: 2026-10-30
- Author: human + Claude
- Supersedes: spec 001
- Inputs: `docs/architecture/vision.md`, ADR 0014

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
   container, and to find the result as a PR on branch `agent/<feature>-<task>`.
5. As the human, I want to leave ready tasks before going to sleep, with my PC on, and find reviewable
   PRs in the morning.
6. As the human, I want a blocked or ambiguous task to stop with its question written in my language,
   instead of a guessed PR.
7. As the human, I want to see the state of a feature, its tasks and their executions from the CLI,
   and to stop a running execution.

## Acceptance criteria

### Projects and lifecycle

- [ ] A project is registered with a name, a local repo path and its GitHub remote. Registration is
      reviewable in git.
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
- [ ] Roster, not the agent, commits, pushes branch `agent/<feature>-<task>` and opens a PR against
      `main` that names the task. It never pushes to `main` and never force-pushes.
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

## Out of scope

- Web dashboard (its own spec, reading the same store).
- Runtimes other than Claude Code (only the adapter interface exists).
- Several tasks in parallel.
- Autonomous merges, deploys and database migrations.
- Configurable autonomy levels L0-L3 (the MVP uses one fixed policy, see Decisions).
- Memory beyond the project's versioned documents and the execution log.
- C4 diagram generation.
- Any Linear integration, and multi-user features.

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
