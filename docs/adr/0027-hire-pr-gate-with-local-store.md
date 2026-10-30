# 0027. A merged hire PR approves a new or changed agent; hire state lives in the store

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human
- Supersedes: 0012

## Context

ADR 0012 made the merge of a hire PR the human approval of a new or changed agent, using Linear labels
and statuses to track it. Spec 002 keeps the gate ("a new or changed agent follows the hire PR gate")
but Linear is gone, agent definitions live in the Roster repo while tasks may belong to another
project, and every agent job runs in a container without `.git` (ADR 0023).

## Decision

1. An agent is approved when `agents/<slug>.md` exists on `origin/main` of the Roster repo.
2. When the selected task has no agent, Roster runs `hr-director` (contract `hr`) in a container on a
   fresh workspace of the **Roster repo**, with the task text, the target project's stack files copied
   into `/roster/in`, and the registry of approved skills. Allowed paths: `agents/**` and
   `skills/registry.md` only.
3. After validating the result:
   - **No changes** and `agents/<slug>.md` is on `origin/main`: the store records the assignment and the
     same `roster run` continues with the specialist.
   - **Changes** (new agent, changed agent or proposed skill): Roster commits them on
     `agent/hire-<slug>`, pushes, opens PR `hire: <slug>` in the Roster repo, sets the task
     `waiting_hire` with the PR, and ends the run. When sync sees the PR merged, every task waiting for
     that slug returns to `todo` with the assignment recorded.
   - **Invalid result, `needsHuman`, or a path outside the allowed ones:** task `blocked` with the
     reason in `human_language`; nothing pushed.
4. An `Agent:` field in `tasks.md` is an assignment made in advance; it still requires the agent to be
   on `origin/main`, otherwise the task waits for its hire PR.

## Considered options

- **Hire PR gate with state in the store:** keeps ADR 0012's approval act; automatic return to `todo`
  removes ADR 0012's manual step.
- **Run new agents immediately:** fully unattended; lets an agent define its own privileges.
- **Hire PRs in the target project's repo:** keeps a project self-contained; agents are shared across
  projects and approved once, in Roster.

## Consequences

- Reused profiles run unattended; a new profile costs one human review, then all waiting tasks resume.
- Reviewers must check capabilities, runtimes and contract in the frontmatter (ADR 0021), not only text.
- The hire job is the only job allowed to push changes under `agents/**` (ADR 0025).
