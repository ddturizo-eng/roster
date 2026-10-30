# 0012. A merged hire PR is the human approval of a new or changed agent

- Status: Accepted
- Date: 2026-10-29
- Deciders: architect (pending human)

## Context

Spec 001 asks the dispatcher to call `hr-director` when an issue has no `agent` label. Constitution
principle 5 requires the human to approve new agents the first time, and ADR 0005 requires approval of
new skills. In an unattended run there is nobody to approve in the moment.

## Decision

An agent is approved when its `agents/<slug>.md` exists on `main`. After `hr-director` runs, the
dispatcher checks `git status` on `agents/` and `skills/registry.md`:

- No changes (an approved agent was reused): apply the `agent` label `<slug>` and continue the run.
- Any change (new agent, changed agent or proposed skill): commit it on branch `agent/ROS-<n>-hire`,
  open a PR titled `ROS-<n>: hire <slug>`, apply the label, and move the issue to Blocked with a comment
  in `human_language` asking the human to review and merge the PR, then move the issue back to Todo.

## Considered options

- **Hire PR gate:** respects the constitution, uses the normal PR review; first issue of a new profile
  waits one human step.
- **Run new agents immediately:** fully unattended; violates principle 5 and lets an agent define its
  own privileges.
- **Separate `approved` flag in the agent frontmatter:** no PR needed; easy to flip without review.

## Consequences

- Repeated profiles run unattended once approved; new profiles cost one review.
- Merging a hire PR becomes the approval act, so reviewers must check tools and skills, not only text.
- Moving the issue back to Todo after merge is manual in this phase.
