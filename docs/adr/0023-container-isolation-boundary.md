# 0023. Container isolation boundary for agent, setup and verification jobs

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human

## Context

Constitution principle 9: agent work that edits code or runs commands runs in an isolated container,
and Roster's store, policies and credentials are never inside it. Spec 002: a fresh Docker container
per execution with only the task's worktree mounted; no store, policies or GitHub credentials inside;
network egress only to the provider's API; the human accepts that the agent can read the Claude token.
Repository content, task text and dependencies may carry prompt injection. A working tree that
contains `.git` lets an agent plant hooks or config (`core.fsmonitor`) that would run on the host the
next time Roster calls git there.

## Decision

1. **One fresh container per job**, `docker run --rm`, named `roster-<execution-id>-<job>`, from an
   image built from the pinned install (`container/`), running as non-root uid 1000, with a read-only
   root file system, tmpfs `/tmp` and home, `--cap-drop ALL`, `--security-opt no-new-privileges`,
   and memory, CPU and PID limits from the policy.
2. **Mounts, and nothing else:** the job's work tree at `/workspace` (read-only for review),
   `/roster/in` read-only (prompt, agent body, inputs), `/roster/out` read-write for the result file,
   and the generated managed settings file read-only at `/etc/claude-code/managed-settings.json`.
   Never the store, config, secrets, logs, the pinned install, the human's repo, the user profile or
   the Docker socket.
3. **No `.git` in the work tree.** Each execution clones into a separate git dir and work tree;
   Roster runs git on the host with `--git-dir`/`--work-tree`, hooks pointed to an empty directory and
   `core.fsmonitor=false`. The agent has no git and cannot commit.
4. **Network.** Per execution, an `--internal` Docker network with no route out, and an egress proxy
   container (Roster's own zero-dependency CONNECT proxy) attached to it and to the default bridge.
   The proxy forwards only allowlisted `host:443` pairs and logs every decision. Allowlists by job
   profile: agent and review = provider API hosts; setup = package registry hosts; verify = no network
   at all (`--network none`). Job containers get `--dns 0.0.0.0`.
5. **Environment by allowlist**, passed by name (values never on a command line): for agent and
   review, the Claude token, home and config dir, proxy variables and the variables that disable
   non-essential traffic, auto-update and claude.ai connectors. No GitHub token, ever.
6. **Profiles** `agent`, `review`, `setup`, `verify` are all defined in one protected file
   (`src/adapters/sandbox/docker/isolation.ts`), so later features use them without touching it.

## Considered options

- **Internal network + egress proxy outside the job container:** domain-based allowlist, no extra
  capabilities in the agent container, enforcement the agent cannot switch off; one more container
  per execution.
- **In-container iptables firewall (Claude Code reference devcontainer):** proven pattern; needs
  `NET_ADMIN` and `NET_RAW` and a root entrypoint in the agent container, and IP allowlists drift when
  provider IPs change.
- **Claude Code's built-in Bash sandbox only:** no Docker; does not isolate the file system from
  `~/.ssh`, other repos or the store, and is configured from inside the run.
- **A VM per execution:** strongest isolation; too slow and heavy for the human's PC.
- **Worktree with `.git` mounted:** lets the agent use git; opens host code execution through hooks
  and config, and lets the agent commit.

## Consequences

- An agent cannot push, cannot reach GitHub, cannot install packages and cannot delete anything
  outside its work tree, regardless of its instructions.
- The agent cannot use `git` or `WebFetch`; prompts tell it so. `WebSearch` is expected to keep
  working because the provider runs it; the spike confirms this.
- DNS and route behavior of `--internal` networks on Docker Desktop is hypothesis H7; the spike
  validates it.
- The token remains readable inside the container; the allowlist is the only limit on its use.
