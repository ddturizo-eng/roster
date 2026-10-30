# 0026. Roster owns every side effect; agents return a validated result file

- Status: Proposed
- Date: 2026-10-30
- Deciders: architect (pending human)
- Supersedes: 0009

## Context

ADR 0009 kept Linear and GitHub credentials away from headless agents: the agent committed locally
and wrote a JSON result file, and the dispatcher performed every Linear comment, status change, push
and PR. Linear is gone (ADR 0014) and status now lives in the store. Spec 002 adds: the agent returns
a structured result (status, summary, verification, questions) that Roster validates before doing
anything else; Roster, not the agent, commits, pushes and opens the PR; Roster runs verification
itself; a code reviewer's findings go in the PR description. ADR 0023 removes `.git` from the
container, so the agent can no longer commit at all.

## Decision

1. The agent receives everything it needs in `/roster/in` (task text with acceptance criteria, spec
   and plan paths, resume and retry notes, the result contract) and writes exactly one file,
   `/roster/out/result.json`. It has no git, no GitHub access and no access to the store.
2. Roster validates the file against the job's contract with hand-written validators in `core/domain`.
   Missing, unparsable or invalid results end the execution as `failed`; nothing else happens.
3. Only after validation does Roster act: policy check, commit, verification, review, push, PR, and
   every store update. This fulfills `AGENTS.md` rule 7 on the agent's behalf.
4. Contracts (all text in English unless stated):

| Contract | Shape |
| --- | --- |
| `specialist` | `{ "status": "done" \| "blocked", "summary", "verification", "questions"?: [{ "text" }], "notes"? }` — `questions` required and non-empty when `blocked`, written in `human_language`. |
| `hr` | `{ "slug", "skills": [], "reason", "needsHuman": boolean }` |
| `analyst` | `{ "status": "questions" \| "done", "questions"?: [{ "id", "text", "textEn" }], "summary"? }` — `text` in `human_language`. |
| `architect` | `{ "status": "done" \| "blocked", "summary", "adrs": [], "questions"?: [{ "text" }] }` |
| `reviewer` | `{ "verdict": "approve" \| "comment" \| "request_changes", "summary", "findings": [{ "severity": "blocker" \| "major" \| "minor" \| "info", "path"?, "line"?, "text" }] }` |

5. Free text from results (summary, notes, findings) is treated as untrusted data: it is placed in the
   PR body and the store as text, length-limited, and never interpreted as commands or paths.

## Considered options

- **Result file in an output mount:** works for any runtime, inspectable after the run, matches ADR
  0009; needs one extra writable mount.
- **Claude Code `--json-schema` structured output on stdout:** validated by the CLI; specific to one
  runtime and mixed with the stream used for logs and quota detection.
- **Agent performs side effects with scoped credentials:** fewer moving parts; puts credentials in the
  untrusted container, against principles 9 and 10.

## Consequences

- Contracts are shared between Roster and agent definitions; changing one needs a PR to both.
- The agent cannot "forget" to open a PR or move a task; it also cannot do anything Roster did not plan.
- Agent definitions' closing rules must describe the result file, not Linear comments (task T31).
