# 0025. Self-modification protection: protected paths and a pinned orchestrator from `main`

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human

## Context

Roster builds itself: agents edit the same repository that holds Roster's policies, container
definitions, guards and agent definitions. Constitution principle 11 says no agent changes policies,
permission settings, hooks, guards or the constitution without a PR reviewed and merged by the human.
Spec 002: a change that touches a protected path is not pushed; the task stops and asks the human.
Pushing a branch is itself a side effect: GitHub runs the workflows of a pushed commit, so a modified
workflow would run before any review.

## Decision

1. **Protected paths.** `policies/protected-paths.json` lists glob patterns. Defaults for every
   project: `.claude/**`, `.mcp.json`, `.github/workflows/**`, `.devcontainer/**`,
   `specs/constitution.md`. Added for the Roster repo: `policies/**`, `container/**`, `projects/**`,
   `agents/**`, `skills/**`, `scripts/install.ps1`, `scripts/sync-agents.ps1`, `src/core/policy/**`,
   `src/adapters/vcs/push-guard.ts`, `src/adapters/sandbox/docker/isolation.ts`,
   `src/adapters/runtime/claude-code/managed-settings.ts`. A project registration may add patterns,
   never remove defaults. Guard logic is kept in these few files on purpose, so most features do not
   touch them.
2. **Check before every push.** Roster checks the changed paths of the whole range `origin/main..HEAD`
   (including commits from resumed runs). Any match: no push, the commit stays on the local agent
   branch, the task is `blocked`, and an approval request of kind `protected_path` tells the human, in
   `human_language`, which paths matched and where the local branch is. Only the human may push it.
   Two exceptions, each limited to exactly these paths:
   - the hire job may change `agents/**` and `skills/registry.md` and nothing else (ADR 0027);
   - `roster project add`, a command the human runs, not an agent job, may add or change exactly one
     `projects/<name>.json` and nothing else.
3. **Pinned orchestrator.** Roster runs from `%LOCALAPPDATA%\Roster\app`, a clone of the Roster repo
   checked out at a commit of `origin/main`, installed and updated only by the human with
   `scripts/install.ps1` (which also builds the container images from that commit). Roster never runs
   from a working copy or an agent branch. `doctor` fails if the install has local changes or its
   commit is not on `origin/main`, and reports how far behind it is.
4. **Policies and agents from `main`.** Policies, protected paths, registrations and agent definitions
   are read from `origin/main` (ADR 0018), never from the branch an agent is working on.
5. **Known protected tasks.** Tasks that must change protected paths carry `Needs human` in
   `tasks.md`, so they are done in a supervised session and no run is wasted on them.

## Considered options

- **Protected paths + pinned install from `main`:** the agent can propose anything but cannot ship a
  safety change, and a merged change takes effect only when the human updates the install.
- **Allow pushes of protected changes as normal PRs:** less friction; pushing alone can run modified
  workflows, and approval fatigue makes a rubber-stamp merge likely.
- **Run Roster from the working copy:** no install step; an agent branch checked out in the working
  copy would change the orchestrator that supervises it.
- **Separate repository for policies:** clean separation; two repositories to keep in sync for one user.

## Consequences

- Changes to guards, the container or policies always pass through the human, twice: pushing and
  merging, then updating the install.
- Merged Roster improvements reach scheduled runs only after the human reinstalls; `doctor` shows the gap.
- The protected list is itself protected, so it can only grow or shrink through a human PR.
