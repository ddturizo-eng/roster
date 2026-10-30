# 0024. Fixed MVP policy by operation class, and where each class is enforced

- Status: Proposed
- Date: 2026-10-30
- Deciders: architect (pending human)

## Context

Spec 002 fixes the MVP policy (Decisions): reading, writing inside the worktree and running tests are
automatic; installing dependencies needs human approval; only Roster commits, pushes and opens PRs; no
deletes outside the worktree, no migrations, no deploys. Configurable autonomy levels are out of scope.
Constitution principle 10 requires enforcement outside the prompt. The vision proposes a policy per
operation class instead of per project, agent and operation.

## Decision

The policy is data in `policies/mvp.json` (protected, ADR 0025), interpreted by `core/policy`.
Each operation class has one value and one or more enforcement points that do not depend on the agent
following instructions:

| Class | Value | Enforcement points |
| --- | --- | --- |
| `read` | allow | Only the work tree and `/roster/in` are mounted (ADR 0023). |
| `write_worktree` | allow | `/workspace` is the only writable mount besides `/roster/out` and tmpfs. After the run, changed paths must match the job kind's allowed paths (specialist: anything not protected; analyst: `specs/<feature>/spec.md`; architect: `specs/<feature>/**`, `docs/adr/**`; hr-director: `agents/**`, `skills/registry.md`; reviewer: nothing). |
| `run_commands` | allow | `shell` capability in the generated managed settings; commands only run inside the container. |
| `install_dependencies` | approve | Agent containers have no route to package registries. The setup job installs only when the project's dependency manifests equal `origin/main` or match an approved content hash. A diff that changes a manifest stops the task with an approval request. Deny rules for install commands are a second line. |
| `vcs_write` (commit, push, PR) | roster_only | No `.git` and no GitHub credentials in the container; Roster commits and pushes through the push guard (only `refs/heads/agent/*`, never force, never `main`). |
| `delete_outside_worktree` | deny | Nothing outside the work tree is mounted. |
| `migrate`, `deploy` | deny | No network except allowlisted hosts and no database or cloud credentials in the container. |
| `change_safety` | deny | Protected-path check before any push (ADR 0025). |

Limits in the same file: per-profile timeouts, maximum `max-turns`, container memory, CPU and PIDs,
`maxRunsPerNight`, egress allowlists (`providerHosts`, `registryHosts`).

**Dependency approval.** When the policy check finds changed manifests (default `package.json`,
`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, plus the project's
`dependencyManifests`), Roster commits the work on the local agent branch, does not push, sets the
task `blocked`, and records an approval request with the manifest diff and the SHA-256 of the
manifests. The human approves with `roster retry <task> --approve-dependencies` (pending open
question 2 in plan 002). The next execution resumes from that branch, the setup job installs from
exactly those manifests, and the agent finishes and verifies. Any further manifest change needs a new
approval.

## Considered options

- **Operation classes with enforcement points outside the prompt:** small table, testable, matches the
  spec; adding autonomy levels later means presets over the same table.
- **Rules per project × agent × operation:** flexible; too many dimensions for one user (vision 4.1.4).
- **Prompt-only rules ("do not install packages"):** zero code; contradicts principle 10.
- **Dependency approval as a draft PR whose merge approves:** no new command; code with uninstalled
  dependencies cannot be verified before the merge.

## Consequences

- An agent that needs a new package stops instead of installing it; the human decides.
- Migrations and deploys are impossible in the MVP by construction, not by instruction.
- Changing any value in this table is a change to a protected file and needs a human PR.
