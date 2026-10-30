# Spike T14 — Claude Code headless in a container on Docker Desktop

- Task: `specs/002-local-core/tasks.md` T14
- Date: 2026-10-30
- Run by: human + Claude, on the human's PC
- Throwaway files: `docs/spikes/container-runtime/` (not product code; T13 builds the real images)

## Environment

| Item | Value |
| --- | --- |
| Host | Windows 11 Pro, Docker Desktop 29.7.2, WSL2 kernel `6.18.33.2-microsoft-standard-WSL2` |
| Base image | `node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c` (Node v24.22.2, npm 11.19.1) |
| Claude Code | 2.1.314, installed with `npm install -g @anthropic-ai/claude-code@2.1.314` |
| Runtime image | 791 MB; first build 4 min 37 s (proxy image: 330 MB, 2 s) |
| Auth | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (Claude Pro), passed with `--env CLAUDE_CODE_OAUTH_TOKEN` by name; value only in the `docker` child environment |

Job container flags used in every run (plan 002 section 9.3): `--user 1000:1000 --read-only --tmpfs /tmp
--tmpfs /home/agent --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2
--network <internal> --dns 0.0.0.0`, plus the environment allowlist of plan section 9.4. The proxy ran
on the default bridge and on an `--internal` network; the job container had only the internal network.

## Results

| Id | Hypothesis | Result | Evidence |
| --- | --- | --- | --- |
| H2 | Headless `claude -p` (no `--bare`) as uid 1000 authenticates with the token alone | **Confirmed** | `result` `success`, text `pong`, 1 turn, 4 s wall time. Fixture `success-pong.jsonl`. |
| H3 | Egress to `api.anthropic.com` only is enough | **Confirmed** | Proxy allowlist `api.anthropic.com:443` only; the proxy saw no other host and nothing was denied. `platform.claude.com` was not needed. |
| H4 | Read-only managed settings with `allowManagedPermissionRulesOnly` and `dontAsk` are honored; no prompt waits | **Confirmed**, with finding F5 | Workspace `.claude/settings.json` asked for `bypassPermissions`, allowed `Bash`/`Write` and declared a `SessionStart` hook. Result: `permissionMode` `dontAsk`; `Bash` and `Write` removed from the tool set ("No such tool available"); the hook did not run (no `HOOK_RAN` file); run finished in 8 s. Fixture `managed-settings-denials.jsonl`. |
| H5 | Quota exhaustion is recognizable in `stream-json` | **Partly confirmed** | Every run emits a `rate_limit_event` with `rate_limit_info.status`, `rateLimitType`, `resetsAt` and `unifiedWindows.five_hour` / `seven_day` utilization. Real exhaustion was not observed. |
| H6 | NTFS bind mount is fast enough for `npm ci && npm test` of a small project | **Confirmed, with a caveat** | Vitest sample (27 MB `node_modules`): bind mount `npm ci` 13.6 s, `npm test` 5.6 s. Same project on container tmpfs: `npm test` 0.5 s (`npm ci` 34.7 s, dominated by network). File-heavy steps are about 10x slower on the bind mount. |
| H7 | `--internal` network gives no route and no external DNS | **Confirmed** | `dns.lookup('example.com')` ─► `EAI_AGAIN`; TCP to `1.1.1.1:443` ─► `ENETUNREACH`; `fetch https://example.com` through the proxy ─► denied (403, logged); `fetch https://api.anthropic.com/` through the proxy ─► HTTP 404 (reachable). |

Also checked: the container runs as `uid=1000(agent)`, the root file system is read-only, and `git` and `gh`
are absent.

## Findings that T13, T15 and T16 must follow

1. **The prompt goes on stdin.** `--mcp-config <configs...>` is variadic: a positional prompt after it
   was read as a config file path (`MCP config file not found: /workspace/<prompt>`). Pass the prompt on
   stdin, as plan section 9.5 already says. This needs `docker run -i`. `--mcp-config '{"mcpServers":{}}'`
   with `--strict-mcp-config` works and gives `mcp_servers: []`.
2. **`--max-turns` works but is hidden.** It is missing from `claude --help` in 2.1.314. When the limit
   is reached, the result has `subtype` `error_max_turns`, `is_error` true, `stop_reason` `tool_use`, and
   the process exits 1. `num_turns` reported 3 with `--max-turns 2`. `interpret` (T16) must map
   `error_max_turns` explicitly (for example to `error` with the reason "turn limit") and must not treat
   exit 1 alone as a crash.
3. **`apiKeySource` is `none` with the OAuth token.** `doctor` must not use that field to check auth.
   Use a trivial run's `result` instead.
4. **A deny rule on a bare tool name removes the tool.** The tool disappears from the tool set and calls
   fail with `No such tool available`. `result.permission_denials` stays empty, so blocked actions show
   up only as `tool_result` errors.
5. **Unlisted tools stay available under `dontAsk`.** The init listed `Task`, `CronCreate`, `CronDelete`,
   `CronList`, `EnterWorktree`, `ExitWorktree`, `ListAgents`, `NotebookEdit`, `RemoteTrigger`,
   `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`, `TaskStop`, `ToolSearch`, `WebSearch` and
   `Workflow`, although only `Read`, `Grep` and `Glob` were allowed. `managed-settings.ts` (T16) must
   generate a deny list of every tool not mapped from the agent's capabilities. The tool list
   differs between CLI versions, so T16 tests it against the init's `tools` of the pinned version.
6. **Quota signal for T16, T21 and ADR 0028.** `rate_limit_event.rate_limit_info` gives `status`,
   `rateLimitType` (`five_hour`), `resetsAt` (epoch seconds) and the utilization of the 5-hour and 7-day
   windows. Two proposals that need the human's decision before T21:
   - set `cooldown_until` from `resetsAt` instead of a fixed 300 minutes;
   - record the 7-day utilization per execution. It was already 0.6 during this spike, so the weekly
     limit, not only the 5-hour window, may bound night runs (H9).
7. **Hosts.** With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, a run needs only
   `api.anthropic.com:443`. `providerHosts` in `policies/mvp.json` stays as planned.
8. **DNS inside the internal network.** With `--dns 0.0.0.0`, `/etc/resolv.conf` still points to
   Docker's embedded DNS (`127.0.0.11`). Container names resolve (the proxy is reachable as
   `http://<proxy-name>:3128`) and external names do not. T15 may address the proxy by name.
9. **Node's own `fetch` ignores `HTTPS_PROXY`** unless `NODE_USE_ENV_PROXY=1`. Claude Code and npm honor
   the proxy variables. Setup jobs that run Node scripts needing the network must set
   `NODE_USE_ENV_PROXY=1`.
10. **npm 11 blocks install scripts by default.** In the image (npm 11.19.1), `npm install` warned that
    package install scripts did not run (`npm install-scripts approve <pkg>`). This helps ADR 0024.
    Projects that need install scripts (native modules) will fail in `setup` until the human approves
    them.
11. **Image details for T13.** `node:24-bookworm-slim` already has user `node` with uid 1000; rename it
    with `usermod -l agent -d /home/agent node` and `groupmod -n agent node`. Installing the CLI from
    npm at a pinned version works; the native installer was not tested. Expect a large image (791 MB)
    and a slow first build.
12. **`--tmpfs /tmp` is `noexec` by default** (`rw,nosuid,nodev,noexec`). Binaries must run from the
    `/workspace` bind mount, never from `/tmp`. The tmpfs timing above used `/tmp:exec` only for the
    comparison.
13. **The proxy works as planned.** The throwaway CONNECT proxy, about 40 lines on Node built-ins,
    handled Claude Code and npm traffic and logged every decision. T13 can follow the same design.

## Not covered

- Real quota exhaustion (H5), scheduled runs with a locked session (H8), quota per night (H9) and
  `gh` credentials (H10): T24, T29 and T40 cover them.
- Larger projects on the bind mount: if `verify` times grow, apply the H6 fallback (workspaces in a
  WSL2 path).

## Cleanup

- Spike containers, network and images are removed after this note. The workspaces and outputs under
  `%LOCALAPPDATA%\Roster\spike\` are deleted, except the token file. The human keeps the token for T24
  (ADR 0016 stores it with DPAPI), then deletes `claude-token.txt`.
- Fixtures in `docs/spikes/container-runtime/fixtures/` were checked: they contain no token, no email
  and no account fields (only session and message UUIDs).
