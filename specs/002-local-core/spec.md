# Spec 002 — Local core MVP

- Status: Draft (pending human approval)
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
- [ ] Every gate (spec, plan) requires an explicit human approval that is recorded with its date.

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
- Configurable autonomy levels L0-L3 (the MVP uses one fixed policy, see open question 3).
- Memory beyond the project's versioned documents and the execution log.
- C4 diagram generation.
- Any Linear integration, and multi-user features.

## Open questions (to answer before approval)

1. **Status UI in the MVP.** Is `roster status` in the terminal enough while the dashboard does not
   exist, or do you want a minimal read-only web page in this spec?
2. **Runtime credentials inside the container.** Claude Code needs its login inside the container, and
   the agent could read it. Proposal: a token from `claude setup-token` passed as an environment
   variable, plus a network egress allowlist that only reaches the provider's API. Do you accept this
   risk, or prefer another option?
3. **Fixed policy for the MVP.** Proposal: automatic read, write inside the worktree and run tests;
   installing dependencies needs approval; commit, push and PR done only by Roster; no deletes outside
   the worktree, no migrations, no deploys. Is this right?
4. **Where approvals happen.** Option A: `roster approve <feature>` in the CLI. Option B: merging the
   PR that contains the spec or the plan counts as approval (like ADR 0012). Which one?
5. **Grilling answers.** Answered interactively in the terminal, or by editing a questions file?
6. **Code review step.** Should a code-reviewer agent review each diff before the PR in this MVP, or
   later?
7. **Provider terms (hypothesis).** Unattended, scheduled use of the Claude Pro subscription through
   the official Claude Code CLI must be checked against Anthropic's current terms before the first
   night run.
