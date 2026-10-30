# 0016. Subscription authentication for local and containerized Claude Code runs

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human
- Supersedes: 0007

## Context

ADR 0007 authenticated a CI runner with a `claude setup-token` token stored as a GitHub secret.
Execution is now local and every agent job runs in a Docker container (ADR 0015, 0023). Spec 002
records the human's decision that the token reaches the container as `CLAUDE_CODE_OAUTH_TOKEN`, and
its provider-terms constraints:

- run the official, unmodified `claude` binary; never call the API or the Agent SDK with the
  subscription token;
- never read Claude credential files; only pass on the token the human provides, stored outside every
  workspace and outside git;
- never use `--bare`, which ignores `CLAUDE_CODE_OAUTH_TOKEN`;
- usage stays individual and bounded.

## Decision

1. **Token source.** The human runs `claude setup-token` and gives the token to
   `roster auth set claude` (stdin, no echo). Roster stores it encrypted with Windows DPAPI for the
   current user in `%LOCALAPPDATA%\Roster\secrets\claude-oauth-token.dpapi`. Roster never opens
   `~/.claude`, `.credentials.json`, the keychain or any file Claude Code writes.
2. **Delivery.** For each agent or review container, Roster decrypts the token into the environment of
   the `docker` child process only and passes `--env CLAUDE_CODE_OAUTH_TOKEN` by name, so the value is
   never on a command line, in a file inside a workspace, in the store or in a log (logs are redacted).
3. **Binary.** The runtime image installs the official Claude Code CLI at a version pinned in
   `container/runtime-claude/Dockerfile`, with auto-update disabled. Upgrades go through a PR.
4. **Invocation.** Always `claude -p` with `--output-format stream-json`; never `--bare`. The
   container's `CLAUDE_CONFIG_DIR` is a fresh tmpfs, so no login state persists between runs.
5. **Local interactive use.** Roster never starts an interactive Claude Code session. The human's own
   sessions keep using their normal login, which Roster does not touch.
6. **Bounds.** One execution at a time (ADR 0015 lock) and `maxRunsPerNight`. If anyone other than the
   human ever uses Roster, a new ADR is required (each user brings their own credentials, or API keys).

## Considered options

- **DPAPI-encrypted file read by Roster:** built into Windows, tied to the user account, no new
  dependency (decrypted through `powershell.exe -NoProfile`); unusable from tasks that run without the
  user's logon session.
- **User-level environment variable (`setx`):** simplest; visible to every process of the user,
  including every interactive Claude Code session and every tool the human runs.
- **Windows Credential Manager:** good UX; reading generic credentials back from Node needs a native
  module or extra PowerShell modules.
- **Mount the human's `~/.claude` into the container:** reuses the login; forbidden by the spec
  (reading credential files) and exposes session history.

## Consequences

- The agent can read the token inside its container; the human accepted this. The egress allowlist
  (ADR 0023) is what limits exfiltration.
- Rotating the token is a `needs-human` step: `claude setup-token`, then `roster auth set claude`.
- Whether the token alone authenticates a headless run in a Linux container, and which Anthropic hosts
  it needs, are hypotheses H2 and H3 in plan 002, validated by the spike task.
