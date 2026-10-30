# Plan 002 — Local core MVP

- Spec: `specs/002-local-core/spec.md` (approved 2026-10-30, PR #2)
- Date: 2026-10-30
- Author: architect
- ADRs: 0015-0029 (all Proposed). Superseded by them: 0006, 0007, 0009, 0012, 0013.
  Kept: 0002, 0003, 0004, 0005, 0008 (amended by 0017), 0010 (extended by 0022), 0014.
- Status: Proposed. The ADRs must be Accepted before T01 starts.

## 1. Summary

`roster` is a local TypeScript CLI (Node 24, no build step) that runs on the human's Windows 11 PC.
It is a modular monolith: a dependency-free **core** (domain, lifecycle, task DAG, orchestrator,
policy, agent registry, runtime router) talks to the outside world only through **ports**, and
**adapters** implement them (Claude Code runtime, Docker sandbox, git, GitHub through `gh`, SQLite
store, Windows DPAPI secrets, Windows Task Scheduler).

Git holds intent (specs, plans, `tasks.md`, ADRs, agents, policies, project registrations). A local
SQLite store holds progress (feature stages, task states, executions, events, approvals).

Every agent job (analyst, architect, hr-director, specialist, code reviewer) runs headless through the
official `claude` binary inside a fresh Docker container. Only the job's working tree is mounted. The
container reaches only the provider API through an egress proxy. It holds no GitHub credentials and no
`.git` directory. Roster itself, outside the container, validates the agent's result, checks the
diff against the policy and protected paths, runs the project's verification commands in a second
container without network, runs the code reviewer, commits, pushes `agent/<feature>-<task>` and opens
the PR. Human approval at every gate is the merge of a PR, which Roster detects.

The plan is ordered as a walking skeleton (see `tasks.md`): first a minimal `roster run` that executes
one imported task in a container and opens a PR, so Roster can execute the rest of its own tasks; then
verification, dependencies, hiring and scheduling; then the feature lifecycle and grilling; then code
review; then status and stop.

## 2. What is reused from spec 001

Spec 001 is superseded, but its core design still fits. Reused, with the changes noted:

| Spec 001 design | Reused as | Change |
| --- | --- | --- |
| Deterministic TS dispatcher, Node 24 type stripping, Vitest, zero runtime deps (ADR 0008) | Whole stack | Code moves from `dispatcher/` to the `roster` package at the repo root (ADR 0017). |
| Selection rules (`select.ts`) | `core/dag` readiness + selection | Source is the store, not Linear. Ready = not `needs-human` and every dependency has a merged PR. Order = `tasks.md` order, oldest feature first. |
| Neutral agent reader (`agents.ts`) | `core/agents` | AgentDefinition v2 with capabilities instead of tool names; v1 files still parse (ADR 0021). |
| Harness interface + registry + Claude Code adapter (ADR 0010) | `ports/runtime` + `adapters/runtime/claude-code` | Adapter builds a container invocation; Docker runs it; router picks the runtime by capabilities (ADR 0022). |
| Git ops with push guard (`git.ts`) | `adapters/vcs/git` + `push-guard.ts` | Takes a target repo; uses a separate git dir so no `.git` reaches the container; guard unchanged (only `refs/heads/agent/*`, no force). |
| Hiring step (`hire.ts`, ADR 0012) | `core/orchestrator/hire` | State lives in the store; hire PR goes to the Roster repo (ADR 0027). |
| Orchestrator state machine with injected ports, ordered side-effect tests (`run.ts`) | `core/orchestrator/run` | More steps (policy check, verification, review); outcomes go to the store, not Linear (ADR 0026). |
| Quota handling: WIP commit, push branch, back to Todo (ADR 0013) | Same behavior | Back to `todo` in the store, plus a runtime cooldown (ADR 0028). |
| `messages.ts` with `human_language` templates | `core/messages` | Same. Questions and stop reasons in `es`; other text in English. |
| CLI `run`, `--dry-run`, `doctor`, `recover` | `roster run`, `doctor` | `recover` becomes automatic interrupted-execution recovery at the start of `run`. |
| Night schedule 22:00-06:00 America/Bogota, 5 runs, 2 h apart | Windows Task Scheduler triggers | Local time, no UTC cron (ADR 0015). |
| Agent timeout 90 min | Specialist job timeout | Same default. |

Not reused: GitHub Actions workflow, Linear GraphQL client, Linear labels and states, `RUNNER_TEMP`
current-issue file.

## 3. Decisions and hypotheses

Decisions are recorded in ADRs 0015-0029. The following are **hypotheses** the plan depends on.
The spike task T14 (`needs-human`) validates H2-H7 before the adapters that depend on them are
finished. T06 validates H1. T24, T29 and T40 (real runs) validate H8-H10.

| Id | Hypothesis | If false |
| --- | --- | --- |
| H1 | `node:sqlite` on Node 24 (stability 1.2, release candidate since v24.15.0, no flag) is stable enough and its warning, if any, can be silenced. | Switch the store adapter to `better-sqlite3` behind the same port (ADR 0017 option B). |
| H2 | The official `claude` CLI, run headless (`-p`, not `--bare`) as a non-root user in a Linux container on Docker Desktop (WSL2 backend), authenticates with `CLAUDE_CODE_OAUTH_TOKEN` alone. | Stop and ask the human; no workaround that reads credential files is allowed. |
| H3 | With egress limited to `api.anthropic.com` through an HTTPS proxy, a run completes. `platform.claude.com` may also be needed for OAuth token checks. | Add the minimum extra Anthropic host to the policy allowlist through a human PR. |
| H4 | A managed settings file bind-mounted read-only at `/etc/claude-code/managed-settings.json` is honored, and `allowManagedPermissionRulesOnly` + `dontAsk` mode give unattended runs that never wait on a prompt. | Fall back to `--settings` + `--allowedTools` + `--disallowedTools`; isolation still holds. |
| H5 | Quota exhaustion on Pro is recognizable in `--output-format stream-json` output (`api_retry` with `rate_limit`, or a usage-limit result text). | Misdetection ends as `failed`, which is safe (ADR 0028). |
| H6 | Bind-mounting an NTFS directory into a Linux container is fast enough for `npm ci` and `npm test` of a small project. | Move workspaces into a WSL2 path; this changes only the workspace root setting. |
| H7 | A Docker `--internal` network gives the agent container no route and no external DNS on Docker Desktop. | Add an in-proxy check and record the gap as a risk; consider the in-container firewall option of ADR 0023. |
| H8 | A Task Scheduler task set to "run only when the user is logged on" starts `roster run` with Docker Desktop available and DPAPI usable while the screen is locked. | The human keeps a session open; documented in the runbook. |
| H9 | Claude Pro quota allows at least one 2 h task per 5 h window. | Lower `maxRunsPerNight`; the DAG still orders the work. |
| H10 | `git push` with `gh auth git-credential` as the credential helper uses `GH_TOKEN` from the child environment. | Use a one-shot `GIT_ASKPASS` helper that reads the token from the environment. |

## 4. Architecture

### 4.1 Modules and the dependency rule

```
src/
  cli/        composition root and commands (only place that wires adapters)
  adapters/   runtime/claude-code · sandbox/docker · vcs/git · forge/github · store/sqlite
              secrets/dpapi · scheduler/windows · console/tty
  ports/      RuntimePort · SandboxPort · VcsPort · ForgePort · StorePort · SecretsPort
              ClockPort · ConsolePort · FileSystemPort
  core/       domain · dag · lifecycle · agents · router · policy · messages · orchestrator
```

- `core` imports only `core` and `ports` (types). No Node built-ins with side effects, no adapters.
- `ports` imports only `core/domain` types.
- `adapters` import `ports` and `core/domain`. They never import each other or `cli`.
- `cli` imports everything and wires real adapters.
- A test (`test/architecture.test.ts`, task T01) parses imports and fails on any violation.
- Every port has a fake in `test/fakes/`. The orchestrator is tested only with fakes and asserts the
  exact ordered list of side effects (spec 001 practice).

### 4.2 Core modules

| Module | Responsibility |
| --- | --- |
| `core/domain` | Types and ids: Project, Feature, Stage, Task, TaskStatus, Execution, JobKind, AgentDefinition, Capability, result contracts and their validators, ApprovalRequest, typed errors. |
| `core/dag` | Parse `tasks.md` (ADR 0019), validate ids and references, detect cycles (names the cycle), compute readiness, select the next task, compute re-import changes. Pure. |
| `core/lifecycle` | Feature state machine (ADR 0020). Pure transition function that refuses skipped stages. |
| `core/agents` | Parse and validate AgentDefinition v2 frontmatter (flat subset) and v1 compatibility (ADR 0021). Pure. |
| `core/router` | Choose a runtime: first preferred runtime of the agent that is enabled, offers the required capabilities and is not in quota cooldown (ADR 0022). Pure. |
| `core/policy` | Fixed MVP policy (ADR 0024): operation classes, protected-path matcher, allowed paths per job kind, dependency-manifest detection, egress allowlists per job profile, limits. Interprets `policies/*.json` content given to it. Pure. Protected path. |
| `core/messages` | Templates for stop reasons and console text in `human_language` (`es`, `en` fallback). |
| `core/orchestrator` | The `run` pipeline (section 8), hiring step, stage jobs (analysis, architect), review step, sync of PR states, import, retry, stop. Talks only to ports. |

### 4.3 Adapters

| Adapter | Implements | Notes |
| --- | --- | --- |
| `runtime/claude-code` | RuntimePort | Builds the container invocation for `claude -p`, generates the managed settings file from capabilities and policy (`managed-settings.ts`, protected), parses stream-json, maps outcomes, detects quota. Never `--bare`. |
| `sandbox/docker` | SandboxPort | Docker CLI through `execFile`. Creates the per-execution internal network, starts the egress proxy, runs job containers, streams logs to a file with secret redaction, enforces timeouts, kills by name. Isolation flags live in `isolation.ts` (protected) and cover every job profile from the start. |
| `vcs/git` | VcsPort | Workspaces with a separate git dir, safe git config on every call, branch prepare/resume, commit, changed paths over a range, `git show` of `origin/main` blobs, push through `push-guard.ts` (protected). |
| `forge/github` | ForgePort | `gh` CLI with `GH_TOKEN` passed only to its child process: create or reuse PR, PR state and `mergedAt`, read `main` protection for `doctor`. |
| `store/sqlite` | StorePort | `node:sqlite`, schema migrations, one database file (ADR 0018). |
| `secrets/dpapi` | SecretsPort | Secrets encrypted with Windows DPAPI (current user) in files under `%LOCALAPPDATA%\Roster\secrets\`, through `powershell.exe -NoProfile` (ADR 0016, 0029). |
| `scheduler/windows` | used by `roster schedule` | Registers and removes the Task Scheduler task through PowerShell `ScheduledTasks` cmdlets (ADR 0015). |
| `console/tty` | ConsolePort | Prints questions and reads answers for grilling; reads secrets from stdin without echo. |

### 4.4 Repository layout (Roster repo)

| Path | Content | Protected (ADR 0025) |
| --- | --- | --- |
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Package `roster`, `"type": "module"`, Node >= 24 | no |
| `src/`, `test/` | Code and tests | only the files listed in section 11 |
| `container/runtime-claude/` | Dockerfile for agent, setup and verify jobs | yes |
| `container/egress-proxy/` | Dockerfile and zero-dependency Node CONNECT proxy | yes |
| `policies/mvp.json`, `policies/protected-paths.json` | Fixed policy data | yes |
| `projects/<name>.json` | Project registrations (ADR 0018) | yes |
| `agents/`, `skills/`, `.claude/` | Agent definitions, skills registry, harness copies | yes (changed only by the hire flow or the human) |
| `scripts/install.ps1` | Pinned install from `main` (ADR 0025) | yes |
| `scripts/sync-agents.ps1` | Copies agents to `.claude/agents/` | yes |
| `specs/`, `docs/` | Intent and decisions | `specs/constitution.md` only |

### 4.5 Machine layout (outside every workspace and outside git)

```
%LOCALAPPDATA%\Roster\
  app\                 pinned install: clone of origin/main at a commit (ADR 0025)
  bin\roster.cmd       shim: node "%LOCALAPPDATA%\Roster\app\src\cli\main.ts" %*
  config.json          machine config (ADR 0018): Roster repo path, workspace root, limits
  data\roster.db       SQLite store
  secrets\             claude-oauth-token.dpapi, github-token.dpapi
  logs\<execution-id>\ agent.jsonl, setup.log, verify.log, review.jsonl, proxy.log
  workspaces\<project>\<execution-id>\{git\, tree\, in\, out\}
  run.lock             global lock: PID + execution id
```

The pinned install is a plain directory, not `node_modules`: Node refuses type stripping for files
under `node_modules`, so a global `npm install` of the package would not run.

## 5. Local store

One SQLite file, `data\roster.db`, owned by `adapters/store/sqlite`. Migrations are numbered and
applied at startup inside a transaction; `schema_migrations` records them. Times are ISO 8601 UTC.
Execution ids are time-ordered: `<yyyymmddhhmmss>-<6 hex>`.

| Table | Columns (main) | Notes |
| --- | --- | --- |
| `schema_migrations` | `version`, `applied_at` | |
| `projects` | `name` PK, `repo_path`, `remote_url`, `owner_repo`, `registration_commit`, `synced_at` | Cache of `projects/<name>.json` read from `origin/main` of the Roster repo. |
| `features` | `id` PK (`<project>:<NNN>`), `project`, `number` (`NNN`), `slug`, `stage`, `step`, `idea_text`, `created_at`, `updated_at` | `stage` and `step` as in ADR 0020. |
| `feature_events` | `id`, `feature_id`, `from_stage`, `to_stage`, `step`, `at`, `pr_url`, `merged_at`, `evidence_commit`, `reason` | Every transition; gates record the PR and its merge date. |
| `grilling` | `id`, `feature_id`, `round`, `question_human`, `question_en`, `answer_human`, `asked_at`, `answered_at` | Answers recorded as typed. |
| `tasks` | `id` PK (`<project>:<NNN>-<Tnn>`), `feature_id`, `key` (`Tnn`), `ord`, `title`, `status`, `needs_human`, `agent_slug`, `profile`, `body_md`, `source_commit`, `branch`, `pr_number`, `pr_url`, `merged_at`, `stop_reason`, `retry_note`, `updated_at` | `status` as in ADR 0020. `body_md` is the task text given to the agent. |
| `task_dependencies` | `task_id`, `depends_on_id` | Edges of the DAG. |
| `executions` | `id` PK, `task_id` (nullable), `feature_id`, `job_kind`, `agent_slug`, `runtime`, `status`, `started_at`, `ended_at`, `base_commit`, `head_commit`, `branch`, `pr_url`, `log_dir`, `container_name`, `result_json`, `reason`, `stop_requested_at`, `pid` | Spec fields: task, agent, runtime, start, end, status, log location, PR link. |
| `execution_steps` | `execution_id`, `step` (`workspace`, `setup`, `agent`, `policy`, `commit`, `verify`, `review`, `push`, `pr`), `status`, `started_at`, `ended_at`, `detail` | One row per pipeline step. |
| `execution_events` | `id`, `execution_id`, `at`, `type`, `payload_json` | Key events (outcome, denied egress, policy violations). The full stream is in the log file. |
| `approval_requests` | `id`, `task_id`, `kind` (`dependencies`, `protected_path`), `detail_json`, `content_hash`, `created_at`, `resolved_at`, `resolution` | `content_hash` ties a dependency approval to exact manifest contents. |
| `runtime_state` | `runtime` PK, `quota_exhausted_at`, `cooldown_until` | Router input (ADR 0028). |

## 6. Git-side formats

- **Project registration** `projects/<name>.json` in the Roster repo (ADR 0018):
  `{ "name", "repoPath", "remote": "https://github.com/<owner>/<repo>", "defaultBranch": "main",
  "setup": ["npm ci --ignore-scripts"], "verify": ["npm run typecheck", "npm test"],
  "dependencyManifests": [...], "protectedPaths": [...], "image": "roster/runtime-claude" }`.
  `protectedPaths` and `dependencyManifests` only add to the defaults. JSON, not YAML, so it parses
  with built-ins.
- **Policy** `policies/mvp.json` and `policies/protected-paths.json` (ADR 0024, 0025).
- **AgentDefinition v2** in `agents/<slug>.md` (ADR 0021).
- **`tasks.md`** machine-readable format (ADR 0019). This plan's `tasks.md` uses it.
- Roster reads registrations, policies and agent definitions from `origin/main` of the Roster repo
  (`git show origin/main:<path>` after a fetch), never from a working copy. Approved means merged.

## 7. CLI commands and data flow

All commands load `config.json`, open the store and apply migrations. Commands that start agent
jobs take the global lock first and refuse to start while another process holds it.

### 7.1 `roster project add <name> --path <repo>`

1. Validate: path is a git repo, `origin` is `https://github.com/<owner>/<repo>`, the GitHub token can
   read it, `main` is protected (PR required, no force push).
2. Write `projects/<name>.json` in a fresh workspace of the Roster repo, commit, push
   `agent/project-<name>`, open PR `project: register <name>`. This is the only code path allowed to
   push a change under `projects/**`.
3. The project is usable once the file is on `origin/main` (next sync). Registration is reviewable in git.

During bootstrap the human writes `projects/roster.json` by hand (task T24).

### 7.2 `roster feature new <project> <slug> [--idea-file <file>]` (grilling, ADR 0020)

1. Read the idea (file or multi-line stdin). Allocate the next free `NNN` from `specs/` on `origin/main`.
   Create the feature in stage `idea` and store the idea text.
2. Move to `analysis`. Run job `analysis` (agent `analyst`) in a container on a fresh workspace of the
   project, with the idea and the project's `AGENTS.md` and constitution paths. Result: questions.
3. Print each question in `human_language`, read the answer, store question and answer (`grilling`).
4. Run job `spec-draft` (agent `analyst`) with idea + Q&A. Allowed paths: `specs/<NNN-slug>/spec.md`
   only. If it returns new questions, repeat 3-4 (at most 3 rounds, then stop with a reason).
5. Roster commits the draft, pushes `agent/<NNN>-spec`, opens PR `spec(<NNN-slug>): <title>`.
   Step = `spec_pr_open`. The human reviews; merging is the approval.

### 7.3 `roster feature import <project> <NNN-slug>` (adopt an existing feature)

For features whose spec and plan were approved before the store existed (spec 002 itself).
Requires `spec.md`, `plan.md` and `tasks.md` on `origin/main`. Records the stages in order with the
commits that brought each file to `main` as evidence, then imports `tasks.md` (ADR 0019).
Boxes checked `[x]` import as `done` with that evidence. Each recorded transition names its evidence,
so no stage is skipped.

### 7.4 `roster run [--dry-run]` (ADR 0015)

```
start
 ├─ take lock (exit 0 "busy" if held) ── recover interrupted executions
 ├─ executions started in this night window >= maxRunsPerNight ─► exit 0
 ├─ docker unavailable ─► record, exit 2
 ├─ sync: fetch Roster repo + projects; PR states of open gate, hire and task PRs (section 7.9)
 ├─ pick one unit of work, in this order:
 │    1. a stage job: feature in spec_approved with step plan_job_pending ─► architect job
 │    2. a ready task (oldest feature in execution, then tasks.md order)
 │    none ─► exit 0 "nothing to do"
 ├─ task has no approved agent ─► hiring step (ADR 0027)
 │    reuse approved agent ─► continue │ hire PR ─► task waiting_hire, exit │ failure ─► blocked
 ├─ router picks runtime (ADR 0022) ── none (cooldown) ─► exit 0
 ├─ pipeline (section 8)
 └─ release lock, exit 0
```

`--dry-run` prints the sync result, the selected unit and the planned steps, and writes nothing
except the sync cache. One unit per invocation: hiring plus the specialist run of the same task count
as one unit.

### 7.5 `roster status [<project>[/<NNN>]]`

Read-only. Shows each feature's stage and step, each task with its state (ready is computed),
open PR links, pending questions and approval requests in `human_language`, and the latest
executions (id, task, agent, runtime, start, end, status, log directory, PR). Shows the last sync
time; it does not sync.

### 7.6 `roster stop [<execution-id>]`

Default: the running execution. Sets `stop_requested_at`, kills the job container and the proxy
through the sandbox adapter, then waits up to 30 s for the `run` process to finalize. The pipeline
checks the flag after every step and finalizes as `stopped` (task `stopped`, nothing pushed,
workspace kept). If the `run` process is gone, `stop` finalizes the execution itself.

### 7.7 `roster retry <task> [--note <text>] [--approve-dependencies]` (proposed, open question 1)

Moves a `blocked`, `failed`, `stopped` or `rejected` task back to `todo`. `--note` stores the human's
answer; the next prompt includes it and tells the agent it is resuming. `--approve-dependencies`
resolves the task's pending dependency approval for the recorded manifest hash (ADR 0024). A
protected-path request cannot be resolved here: only the human pushes that branch.

### 7.8 `roster doctor`

Checks and prints pass/fail: Node >= 24; pinned install clean and its commit on `origin/main` (and
how far behind); Docker reachable; images present for the pinned commit; Claude token and GitHub
token present (never printed); `gh` reachable with the token; every registered project's `main`
protection; Task Scheduler task registered; free disk space for workspaces.

### 7.9 `roster sync`

Explicit form of the sync step: fetch, refresh registrations, read PR states. Effects:

- Task PR merged ─► task `done` with `merged_at`; dependents may become ready.
- Task PR closed unmerged ─► task `rejected` with a reason (open question 6).
- Hire PR merged ─► tasks in `waiting_hire` for that slug ─► `todo`.
- Spec PR merged ─► feature `spec_approved`, step `plan_job_pending`, records the merge date.
- Plan PR merged ─► feature `plan_approved`, import `tasks.md`; success ─► `execution`; a cycle or
  format error keeps `plan_approved` with the error, step `import_failed`.
- All tasks of a feature in execution are `done` or `cancelled` ─► `delivered`.

### 7.10 `roster auth set claude|github`

Reads the secret from stdin without echo and stores it with DPAPI (ADR 0016, 0029). Prints only the
last 4 characters.

### 7.11 `roster schedule install|remove|show`

Registers the Task Scheduler task that runs `%LOCALAPPDATA%\Roster\bin\roster.cmd run` at the night
slots (ADR 0015).

## 8. The execution pipeline (one task)

Each step is recorded in `execution_steps`. Any exception after the execution starts finalizes it as
`failed` with the reason, and the task as `failed`, unless stated otherwise.

1. **Workspace.** Clone the project from its local path into
   `workspaces\<project>\<execution-id>\` with a separate git dir (`git\`) and work tree (`tree\`),
   set `origin` to the GitHub remote, fetch. Branch `agent/<NNN>-<Tnn>`: if it exists on `origin`,
   check it out and mark the run as resuming; else create it from `origin/main`. The work tree has no
   `.git` entry. Every git call passes `--git-dir`, `--work-tree` and safe config
   (`core.hooksPath` to an empty dir, `core.fsmonitor=false`, `core.autocrlf=false`, no credential
   helper except for push).
2. **Setup** (if the project declares `setup`). Allowed when the dependency manifests equal
   `origin/main` or an approval exists for their current hash; otherwise skipped and the agent is
   told dependencies are not installed. Runs in a `setup` container (section 9) with egress to the
   package registry only, no token.
3. **Agent.** Write the `in\` files: `prompt.md` (task body, acceptance criteria, spec and plan paths,
   resume note, retry note, result contract, and the fact that git and network are unavailable),
   `agent.md` (definition body) and the managed settings. Run the `agent` container. Outcome from the
   runtime adapter: `completed`, `quota_exhausted`, `timeout`, `error`, or `stopped`.
   - `quota_exhausted` ─► WIP flow (ADR 0028), task `todo`, runtime cooldown, end.
   - `timeout`/`error` ─► `failed` with reason in `human_language`, end. Nothing pushed.
4. **Result.** Read `out\result.json` and validate it against the job contract (ADR 0026).
   Missing or invalid ─► `failed`. `blocked` ─► task `blocked` with the agent's questions (already in
   `human_language`), nothing pushed, end.
5. **Policy check** on the work tree changes against the branch base: protected paths, allowed paths
   for the job kind, dependency manifests (ADR 0024, 0025).
   - Protected path or path outside the allowed ones ─► commit kept locally, task `blocked`, approval
     request `protected_path`, nothing pushed. The message says which paths matched, where the local
     branch is, and that only the human may push it.
   - Dependency manifests changed without approval ─► commit kept locally, task `blocked`, approval
     request `dependencies` with the manifest diff and hash, nothing pushed.
   - No changes at all ─► `failed` ("no changes").
6. **Commit.** Roster commits all changes as `<NNN>-<Tnn>: <title>` with the Roster identity from
   `config.json`. The message body names the agent and the execution id.
7. **Verify.** Run each `verify` command in a `verify` container (no network, no token). Record exit
   codes and log tails. Any failure ─► task `failed` with the failing command and tail in the reason;
   the branch is pushed through the range check and guard of step 9 so the work survives; no PR
   (open question 5).
8. **Review.** Run job `review` (agent `code-reviewer`) with the work tree mounted read-only and the
   diff, the task's acceptance criteria and the ADR list in `in\`. Result: verdict and findings.
   A review error or invalid result does not block: the PR body says the review is missing and why.
   Review `quota_exhausted` ─► WIP flow as in step 3.
9. **Push.** Re-run the policy check over the whole range `origin/main..HEAD` (covers commits from
   earlier resumed runs), then push through the guard: only `refs/heads/agent/*`, never `--force`,
   never `main`.
10. **PR.** Create or reuse the PR against `main`, title `<NNN>-<Tnn>: <title>`, body: task id, review
    verdict and findings, agent summary, agent's verification, Roster's verification results, notes,
    execution id. Task `in_review`.
11. **Record.** Execution `succeeded` with head commit and PR link. The workspace is removed when the
    task is `done`; it is kept for stopped, blocked and failed tasks and cleaned after
    `workspaceRetentionDays`.

## 9. Container execution design (ADR 0023)

### 9.1 Images

- `roster/runtime-claude:<roster-commit>`: base `node:24-bookworm-slim` pinned by digest, non-root
  user `agent` (uid 1000), the official Claude Code CLI installed at a pinned version, auto-update
  disabled, common tools (`ripgrep`, `ca-certificates`). Used by agent, setup and verify jobs.
  No `git`, no `gh`, no credentials.
- `roster/egress-proxy:<roster-commit>`: same base, runs `container/egress-proxy/proxy.ts`, an HTTP
  CONNECT proxy that allows only `host:443` pairs from its allowlist argument and logs every decision.
- Built by `scripts/install.ps1` from the pinned install and tagged with its commit. `doctor` checks them.

### 9.2 Job profiles

| Profile | Used by | Work tree mount | Network | Claude token | Default timeout |
| --- | --- | --- | --- | --- | --- |
| `agent` | specialist, hr-director, analyst, architect | `/workspace` rw | proxy, allowlist = provider API | yes | 90 min specialist, 20 min hr-director and analyst, 60 min architect |
| `review` | code-reviewer | `/workspace` ro | proxy, allowlist = provider API | yes | 20 min |
| `setup` | project `setup` commands | `/workspace` rw | proxy, allowlist = package registry | no | 15 min |
| `verify` | project `verify` commands | `/workspace` rw | `none` | no | 20 min |

Verification artifacts written into the work tree are never committed: Roster commits before
verification, pushes commits only, and every execution starts from a fresh workspace.

### 9.3 Flags common to every job container

`docker run --rm --name roster-<execution-id>-<job>`, `--user 1000:1000`, `--read-only` root file
system, `--tmpfs /tmp` and `--tmpfs /home/agent`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, `--pids-limit 512`, `--memory 4g`, `--cpus 2` (values from the
policy), `--network <per-execution internal network>` or `none`, `--dns 0.0.0.0`, and `--env` by name
only (values come from the environment of the `docker` child process, never from the command line).
Mounts, and nothing else:

| Container path | Host path | Mode |
| --- | --- | --- |
| `/workspace` | `workspaces\<p>\<id>\tree` | rw (ro for review) |
| `/roster/in` | `workspaces\<p>\<id>\in` | ro |
| `/roster/out` | `workspaces\<p>\<id>\out` | rw (agent and review only) |
| `/etc/claude-code/managed-settings.json` | `workspaces\<p>\<id>\in\managed-settings.json` | ro (agent and review only) |

Never mounted: the store, `config.json`, `secrets\`, logs, the pinned install, the human's repo,
`%USERPROFILE%`, the Docker socket.

### 9.4 Environment allowlist

Agent and review: `CLAUDE_CODE_OAUTH_TOKEN`, `HOME=/home/agent`,
`CLAUDE_CONFIG_DIR=/home/agent/.claude` (tmpfs, fresh each run), `HTTPS_PROXY` and `HTTP_PROXY` set to
the proxy, empty `NO_PROXY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`,
`ENABLE_CLAUDEAI_MCP_SERVERS=false`, `LANG=C.UTF-8`. Setup and verify get only `HOME`, `LANG`, `CI=1`
and, for setup, the proxy variables. `GH_TOKEN`, `GITHUB_TOKEN` and anything else are never passed.

### 9.5 Claude Code invocation and managed settings

```
claude -p --output-format stream-json --verbose
       --append-system-prompt-file /roster/in/agent.md
       --max-turns <n> --no-session-persistence
       --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       [--model <alias>]  < /roster/in/prompt.md
```

Never `--bare` (it ignores `CLAUDE_CODE_OAUTH_TOKEN`). Without `--bare`, a `-p` run loads the work
tree's `CLAUDE.md` and the hooks in its `.claude/settings.json`; the managed settings neutralize the
risky parts, and the container contains whatever remains. Managed settings generated per job
(`managed-settings.ts`, protected):

- `allowManagedPermissionRulesOnly: true`, `allowManagedHooksOnly: true`,
  `permissions.defaultMode: "dontAsk"`, `permissions.disableBypassPermissionsMode: "disable"`,
  `disableClaudeAiConnectors: true`.
- Allow rules from capabilities: `read` ─► `Read`, `Grep`, `Glob`; `edit` ─► `Edit`, `Write`;
  `shell` ─► `Bash`; `web` ─► `WebSearch`. `WebFetch` is denied in the MVP (egress allows only the
  provider API).
- Deny rules (defense in depth, not the boundary): `Bash(git push *)`, `Bash(npm install *)`,
  `Bash(npm i *)`, `Bash(pnpm add *)`, `Bash(yarn add *)`.

Exact flags are confirmed or corrected by the spike (T14) before T16 is finished.

### 9.6 Egress

Per execution Roster creates `roster-net-<execution-id>` with `docker network create --internal`,
starts the proxy attached to it and to the default bridge, and gives the job container only the
internal network. The job container has no route out; only the proxy can reach the internet, and it
forwards only allowlisted `host:443` CONNECT requests. Allowlists come from `policies/mvp.json`:
`providerHosts` (`api.anthropic.com`; H3 may add one Anthropic host) and `registryHosts`
(`registry.npmjs.org`). Denied requests are logged and recorded as events. The network and the proxy
are removed when the execution ends.

## 10. Policy enforcement points (ADR 0024)

| Operation class | MVP policy | Enforcement point (outside the prompt) |
| --- | --- | --- |
| Read | automatic | Mount set: only the work tree and `/roster/in` exist in the container. |
| Write in work tree | automatic | `/workspace` rw mount; read-only root FS; tmpfs elsewhere. Allowed paths per job kind checked after the run (step 5). |
| Run commands and tests | automatic | `shell` capability in managed settings; commands run inside the container only. |
| Install dependencies | human approval | No registry egress for agent jobs; setup runs only from unchanged or approved manifests; changed manifests stop the task with an approval request; deny rules as second line. |
| Commit, push, PR | Roster only | No `.git` and no GitHub credentials in the container; Roster commits and pushes through `push-guard.ts`. |
| Delete outside work tree | never | Nothing outside the work tree is mounted. |
| Migrations, deploys | never | No network except allowlisted hosts; no database or cloud credentials exist in the container. |
| Change safety (policies, settings, hooks, guards, constitution) | never unattended | Protected-path check before any push (steps 5 and 9); the pinned orchestrator runs from `main` (ADR 0025). |
| Resource use | bounded | Container timeout, `--max-turns`, memory, CPU and PID limits, `maxRunsPerNight`, quota cooldown. |

## 11. Protected paths (ADR 0025)

Defaults for every project (`policies/protected-paths.json`): `.claude/**`, `.mcp.json`,
`.github/workflows/**`, `.devcontainer/**`, `specs/constitution.md`.

Added for the Roster repo: `policies/**`, `container/**`, `projects/**`, `agents/**`, `skills/**`,
`scripts/install.ps1`, `scripts/sync-agents.ps1`, `src/core/policy/**`,
`src/adapters/vcs/push-guard.ts`, `src/adapters/sandbox/docker/isolation.ts`,
`src/adapters/runtime/claude-code/managed-settings.ts`.

Exceptions: the hire job may change `agents/**` and `skills/registry.md` and nothing else (ADR 0027);
`roster project add` may change one file under `projects/**`. Projects may add paths in their
registration; they cannot remove defaults. Guard files are written once in the walking skeleton and
cover every job profile, so later tasks do not need to touch them. Tasks known to touch protected
paths carry `Needs human` in `tasks.md`.

## 12. Credentials

| Secret | Where it lives | Who reads it | In the agent container? |
| --- | --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) | `%LOCALAPPDATA%\Roster\secrets\claude-oauth-token.dpapi` | `secrets/dpapi` ─► environment of the `docker` child ─► agent and review containers | Yes, accepted by the human (spec Decisions) |
| GitHub fine-grained PAT (ADR 0029) | `%LOCALAPPDATA%\Roster\secrets\github-token.dpapi` | `secrets/dpapi` ─► `GH_TOKEN` of `gh` and of `git push` (through `gh auth git-credential`) | No |
| Claude credential files (`.credentials.json`, keychain) | Wherever Claude Code keeps them | Nobody: Roster never reads them | No |

Roster redacts both token values from every log line it writes. Tokens never appear in command-line
arguments, error messages, the store or git.

## 13. Windows 11 + Docker Desktop specifics

- Docker Desktop with the WSL2 backend must be running; the human enables "Start Docker Desktop when
  you sign in". `run` checks `docker info` with a 20 s timeout; if unavailable it records the reason
  and exits with code 2.
- The scheduled task runs only when the user is logged on: Docker Desktop and DPAPI need the user
  session, and tasks that run without a stored logon cannot decrypt DPAPI secrets. The PC must not
  sleep during the night window; the task has "wake the computer" enabled (H8).
- Paths: Docker on Windows accepts `C:\...` bind sources; the adapter passes arguments with `execFile`
  arrays and never through a shell.
- Line endings: workspace clones use `core.autocrlf=false` so Linux tools in the container see the
  repository's bytes.
- NTFS bind mounts are slower than WSL2 paths (H6). The workspace root is a config value, so it can
  move to a WSL2 path without code changes.
- Node type stripping does not run under `node_modules`, hence the plain-directory pinned install.
- Stopping uses `docker kill` of the named containers; Roster does not rely on Windows process-tree
  signals.

## 14. Agent contracts (ADR 0026)

Every agent job writes `/roster/out/result.json`. Roster validates it with hand-written validators in
`core/domain` before anything else. Contracts: `specialist`, `hr`, `analyst`, `architect`, `reviewer`.
The specialist contract is `{ status: "done" | "blocked", summary, verification, questions?: [{ text }],
notes? }`; `questions` is required when blocked and is written in `human_language`.

## 15. Agents needed at run time (hires for `hr-director`)

- `analyst`: grilling and spec drafting; capabilities `read`, `edit`; contract `analyst`.
- `code-reviewer`: reviews a diff against acceptance criteria and ADRs; capability `read`;
  contract `reviewer`.
- Existing base agents `architect` and `hr-director` are migrated to v2 with contracts `architect` and
  `hr` (task T31). The hires happen in task T32.

Task profiles noted in `tasks.md` (`Profile:` field): TS core, TS adapters (trust boundaries),
container/devops, Windows/PowerShell, docs. `hr-director` assigns the specialists afterwards.

## 16. Risks

| Risk | Mitigation |
| --- | --- |
| The agent reads `CLAUDE_CODE_OAUTH_TOKEN` and tries to exfiltrate it. | Egress only to the provider API; no other route; token redacted from logs; the human can revoke and regenerate it. Accepted by the human. |
| Prompt injection in repo content, tasks or agent output. | Treated as untrusted; Roster validates results, owns side effects, checks paths before push; PR text is data only. |
| A hostile work tree plants git hooks or `core.fsmonitor` to run code on the host when Roster commits. | No `.git` in the work tree; separate git dir; hooks path forced to an empty dir; fsmonitor off. |
| Agent edits project `.claude/settings.json` or `.mcp.json` to widen its own permissions mid-run. | Managed settings with managed-only rules and hooks; `--strict-mcp-config`; protected paths stop the push. |
| Pushing a branch with modified workflows runs them on GitHub with secrets. | `.github/workflows/**` is protected; the PAT has no Workflows permission. |
| Guard code is weakened by a merged PR the human did not read carefully. | Guard files are protected, so only the human pushes them; the pinned install updates only when the human runs the install script. |
| `node:sqlite` changes behavior (H1). | Store behind a port; migration tests; fallback option in ADR 0017. |
| Claude Code CLI changes flags or output format. | Version pinned in the image; upgrades go through a PR; adapter tests with recorded streams. |
| Quota exhaustion not detected (H5). | Ends as `failed`, which is safe; patterns in one constant with tests. |
| Docker Desktop not running or PC asleep at night. | `run` records and exits; `doctor` and runbook; Task Scheduler "wake" and "start when available". |
| A crash leaves an execution `running`. | Lock file with PID; the next `run` marks it `interrupted` (task `failed`), kills leftover containers and removes the network. |
| Disk fills with workspaces and logs. | Retention setting; `doctor` checks free space. |
| Re-import of a changed `tasks.md` conflicts with running work. | Import rules in ADR 0019: done tasks keep status; removed unstarted tasks are cancelled; a removed task in progress blocks the import. |
| Approval fatigue. | Whole plans are approved in one merge; hires once per profile. |
| Merged Roster improvements do not reach scheduled runs until reinstall. | Intended (ADR 0025); `doctor` shows how far behind the pinned install is. |

## 17. Open questions for the human

1. **Unblocking a task.** The spec says a blocked task stops with its question but not how the human
   answers. Proposed: `roster retry <task> [--note <answer>]` (section 7.7). Accept?
2. **Dependency approval.** Proposed: a changed manifest stops the task with an approval request; the
   human approves with `roster retry <task> --approve-dependencies`, which lets the next run install
   from those exact manifests in the setup container (ADR 0024). Alternative: push the change as a
   draft PR and treat the merge as the approval, without installing before the merge.
3. **Code review verdict.** Proposed: the review never blocks the PR; its verdict and findings go at
   the top of the PR description. Should `request_changes` instead stop the task?
4. **Toolchains of the other projects.** The runtime image ships Node 24. Which stacks do your 1-2 apps
   use? A project can name its own image later; building other images is not in this spec.
5. **Verification failure.** Proposed: no PR; the branch is pushed so the work survives; the task is
   `failed` with the failing command. Accept?
6. **PR closed without merge.** Proposed: task `rejected`; it waits for `roster retry`. Accept?
7. **Night window.** Reuse 22:00-06:00 America/Bogota, 5 runs 2 h apart, `maxRunsPerNight = 5`?
8. **Grilling rounds.** Proposed: at most 3 rounds of questions before the spec draft must be written.
