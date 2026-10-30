# 0009. The dispatcher owns side effects; headless agents report through a result file

- Status: Accepted
- Date: 2026-10-29
- Deciders: architect (pending human)

## Context

Constitution principle 4 (least privilege) and the spec ("never pushes to `main`", "uses no credentials
other than the harness's and GitHub's") apply to an unattended agent that has shell access and reads
issue text written by people. If the agent held Linear and GitHub credentials, a bad prompt could push
to `main`, change unrelated issues or leak tokens. `AGENTS.md` rule 7 asks agents to comment and move
the issue themselves.

## Decision

In dispatcher runs, the agent receives the full issue in its prompt, commits locally and writes a JSON
result file at a path given by the dispatcher. It gets no Linear or GitHub credentials and cannot run
`git push`. The dispatcher performs every Linear comment, status change, push and PR, using the agent's
result. This fulfills `AGENTS.md` rule 7 on the agent's behalf.

## Considered options

- **Dispatcher owns side effects:** least privilege, predictable statuses, testable; the agent cannot
  read other issues or comments during the run.
- **Agent uses the Linear MCP server and pushes itself:** matches interactive sessions; needs more
  credentials in the agent environment and trusts the agent to follow every rule.

## Consequences

- The result-file schema is a contract between dispatcher and agents; changing it needs a PR to both.
- Missing or invalid result files are treated as failures (issue goes to Blocked).
- `AGENTS.md` gains a note that, in dispatcher runs, rule 7 is done through the result file.
