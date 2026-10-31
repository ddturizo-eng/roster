# 0029. GitHub access for Roster through a fine-grained PAT limited to registered repos

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human
- Amended by: 0032 (the optional Administration read verifies protection of the base branch and of
  `main`; Roster pushes the project's agent branches, not only `agent/*`)

## Context

Outside the container, Roster pushes `agent/*` branches, opens PRs and reads PR states to detect merges
(spec 002, ADR 0020) in the Roster repo and in every registered project. The handoff of 2026-10-29
asked that the token used by automation must not hold `Administration`, because it could delete repos
or change branch protection, and that repo creation always uses the human's own `gh` login. Constitution
principle 4 asks for least privilege.

## Decision

Roster uses one fine-grained personal access token, created by the human, with:

- Repository access: only the selected repos that are registered with Roster (Roster's own repo
  included).
- Permissions: Contents read and write, Pull requests read and write, Metadata read (mandatory).
  Optional Administration **read-only**, only so `doctor` can verify `main` protection.
  No Administration write, no Workflows, no Secrets, no Actions write, no account permissions.
- Expiration: at most 90 days; rotation is a `needs-human` step.

The token is stored with DPAPI in `%LOCALAPPDATA%\Roster\secrets\github-token.dpapi` (set with
`roster auth set github`) and given only to Roster's own `gh` and `git push` child processes as
`GH_TOKEN`; `git push` uses `gh auth git-credential` as its credential helper for that one command.
It is never written to git config, never passed to a container, never logged.

Registering a project requires the human to add the repo to the token's access list; repo creation
and branch protection stay with the human's own `gh` login, outside Roster.

## Considered options

- **Fine-grained PAT scoped to registered repos:** least privilege, cannot delete repos, cannot push
  workflow files (a second line behind protected paths); must be rotated and its repo list maintained.
- **The human's `gh` login (`gh auth token`):** no setup; classic OAuth scopes (`repo`, `workflow`) let
  any Roster bug change settings or workflows in every repo of the account.
- **GitHub App installed on the selected repos:** short-lived tokens and fine permissions; needs a
  private key on disk, JWT signing and an app registration, too much for one user now.
- **Classic PAT:** simple; `repo` scope is all-or-nothing across repos.

## Consequences

- A leaked token can push `agent/*` branches and open PRs in registered repos, but cannot merge into a
  protected `main`, delete repos or change protection.
- Pushes of `.github/workflows/**` are rejected by GitHub, consistent with ADR 0025.
- Adding a project is two human steps: the registration PR and the token's repo list.
- PRs opened with a PAT trigger CI workflows normally (unlike `GITHUB_TOKEN`).
