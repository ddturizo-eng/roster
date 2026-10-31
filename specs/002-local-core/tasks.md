# Tasks 002 — Local core MVP

- Spec: `specs/002-local-core/spec.md`
- Plan: `specs/002-local-core/plan.md`
- ADRs: 0015-0029 (Accepted 2026-10-30, PR #3), 0030 (Accepted 2026-10-30), 0031 (Proposed 2026-10-30),
  0032 (Proposed 2026-10-30)
- Format: machine-readable, ADR 0019. Roster imports this file with `roster feature import`.
- Status: Approved (2026-10-30, PR #3). Amended 2026-10-30: T41 (`roster watch`) added, with hooks
  in T04, T15, T39 and T40. Amended 2026-10-30: T42, T43 and T44 (base branch and branch prefix per
  project, ADR 0032) added as follow-ups of the done tasks T09, T10 and T11, with criteria changed in
  T19, T20, T21, T22, T24, T26, T28, T33, T34, T35, T36, T39 and T40.

Each task is about 2 h of agent work, ends with a PR against `main` from `agent/002-<Tnn>`, and checks
its own `Done` box in that PR (constitution, definition of done). `Depends on` is the authoritative
dependency list. `Needs human` marks work agents must not do alone: credentials, Docker or Windows
setup, repository settings, protected paths after bootstrap, and real runs. `Profile` is a hint for
`hr-director`, who assigns the `Agent` field afterwards.

**Order changes (human, 2026-10-30):** T14, the risk spike, is listed first and runs before any other
task, because every container and runtime task depends on its findings. T17, the runtime router, moved
to Phase B: with one runtime, T20 resolves `claude-code` directly. Ids are unchanged; file order is
the selection order (ADR 0019).

**Walking skeleton cut-off: T24.** The Phase A tasks (T14, T01-T13, T15, T16, T42-T44, T18-T24) are the bootstrap: they run in supervised sessions,
one at a time, tracked by this file and PRs (ADR 0014). T24 installs Roster, imports this file into
the store and makes the first real `roster run`. From T25 on, Roster executes its own tasks; tasks that
touch protected paths (ADR 0025) carry `Needs human`.

Guard files are written once in the skeleton and cover every job profile, so later tasks do not touch
them: `src/core/policy/**` (T08), `src/adapters/vcs/push-guard.ts` (T10, project branch rules in T43),
`container/**` (T13), `src/adapters/sandbox/docker/isolation.ts` (T15),
`src/adapters/runtime/claude-code/managed-settings.ts` (T16).

## Phase A — Walking skeleton (bootstrap)

## T14. Spike: Claude Code headless in a container on Docker Desktop

- [x] Done
- Depends on: none (runs first, before any other task)
- Needs human: needs Docker Desktop, a real `claude setup-token` token and real runs
- Profile: container/devops
- Areas: `docs/spikes/2026-11-container-runtime.md`, `docs/spikes/container-runtime/` (throwaway files)
- Acceptance criteria:
  - Uses a throwaway image (`node:24-bookworm-slim` plus a pinned Claude Code CLI, user uid 1000) and a
    throwaway logging CONNECT proxy, both kept under `docs/spikes/container-runtime/` and never reused as
    product code; T13 builds the real images from these findings.
  - With that image, an internal network and the proxy, a trivial `claude -p` prompt runs as uid 1000 with only `CLAUDE_CODE_OAUTH_TOKEN` (no `--bare`) and returns a result: confirms or refutes H2.
  - Records which Anthropic hosts the proxy saw, and whether the run works with only `api.anthropic.com` (H3).
  - Confirms a read-only managed settings mount at `/etc/claude-code/managed-settings.json` with `allowManagedPermissionRulesOnly` and `dontAsk` is honored: a denied tool is denied without waiting (H4).
  - Records a sample `stream-json` output, including the `result` line, saved as a test fixture with no secrets.
  - Records the internal network's DNS and route behavior (H7) and the time of `npm ci && npm test` of a small project on an NTFS bind mount (H6).
  - Lists any flag, version or allowlist change the images and adapters (T13, T15, T16) must follow.
- Verification: the human reviews the spike notes; each hypothesis is marked confirmed or refuted with evidence.

## T01. Scaffold the roster package, CI and the layering test

- [x] Done
- Depends on: none
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `src/`, `test/`, `.github/workflows/ci.yml`
- Acceptance criteria:
  - `package.json` at the repo root: name `roster`, `"type": "module"`, `"engines": { "node": ">=24" }`, no runtime dependencies, dev dependencies `typescript`, `vitest`, `@types/node` only, lockfile committed.
  - Scripts: `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `start` (`node src/cli/main.ts`).
  - `tsconfig.json` is strict with `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions`, `noEmit`.
  - Folders `src/core`, `src/ports`, `src/adapters`, `src/cli`, `test/fakes` exist; `src/cli/main.ts` prints usage and exits 0.
  - `test/architecture.test.ts` parses every import under `src/` and fails when `core` imports anything outside `core` and `ports`, when `ports` imports outside `core/domain`, or when an adapter imports another adapter or `cli`. It includes one deliberately bad fixture that must fail.
  - `.github/workflows/ci.yml` runs `npm ci`, `typecheck` and `test` on Node 24 for pull requests, with `permissions: { contents: read }`.
- Verification: `npm ci && npm run typecheck && npm test` pass locally; CI passes on the PR. The workflow file is pushed by the human (protected path, ADR 0025 and 0029).

## T02. Domain types, ports and fakes

- [x] Done
- Depends on: T01
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/domain/`, `src/ports/`, `test/fakes/`
- Acceptance criteria:
  - `core/domain` defines the types of plan 002 sections 5 and 14: Project, Feature, Stage, Step, Task, TaskStatus, Execution, ExecutionStatus, JobKind, JobProfile, Capability, AgentDefinition, the five result contracts, ApprovalRequest, and typed error classes with a stable `name`.
  - `core/domain` also defines `RateLimitSnapshot` (ADR 0030: `status`, `limitType`, 5-hour and 7-day `utilization` and `resetsAt` as ISO 8601 UTC, `observedAt`; every field except `observedAt` optional) and the `RuntimeOutcome.detail` fields `rateLimit?: RateLimitSnapshot`, `quotaResetsAt?: string` and `quotaWindow?: string`.
  - Result validators for the five contracts of ADR 0026, hand-written, returning either the typed value or a list of errors with JSON paths; free-text fields are length-limited.
  - Ports as TypeScript interfaces: RuntimePort (ADR 0022), SandboxPort, VcsPort, ForgePort, StorePort, SecretsPort, ClockPort, ConsolePort, FileSystemPort.
  - One fake per port in `test/fakes/`, recording calls in order, with scriptable responses.
  - Only erasable syntax (no `enum`, `namespace` or parameter properties).
- Verification: unit tests for every validator (valid sample, each missing field, wrong enum value, over-long text); architecture test still passes.

## T03. Machine config and human-language messages

- [x] Done
- Depends on: T02
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/messages/`, `src/cli/config.ts`, tests
- Acceptance criteria:
  - `loadConfig(path)` reads `%LOCALAPPDATA%\Roster\config.json` with keys from ADR 0018 (`rosterRepo`, `workspaceRoot`, `maxRunsPerNight` default 5, `quotaCooldownMinutes` default 300, `workspaceRetentionDays` default 14, `commitAuthor`, `enabledRuntimes` default `["claude-code"]`, `nightWindow` default 22:00-06:00) and fails with a message that lists every invalid or missing key.
  - `human_language` is parsed from `specs/constitution.md` of the pinned install; unknown or missing falls back to `en`.
  - Templates in `es` and `en` for: stop reasons (invalid result, no changes, protected path, dependency approval, verification failed, timeout, error, interrupted, stopped, docker unavailable, quota cooldown, hire PR opened, PR closed unmerged) and console lines used by `run`.
  - No template ever interpolates a secret; a test checks templates against a fake token value.
- Verification: unit tests for defaults, invalid keys, language fallback and every template in both languages.

## T04. `tasks.md` parser and task DAG

- [x] Done
- Depends on: T02
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/dag/`, `test/fixtures/tasks/`, tests
- Acceptance criteria:
  - Parses the format of ADR 0019: task headings, `Done` checkbox, `Depends on`, `Needs human`, `Agent`, `Profile`, `Areas`, `Acceptance criteria`, `Verification`; other level-2 headings end a task; unknown keys produce warnings.
  - Errors name the line and task id: duplicate id, missing required field, unknown dependency, self-dependency, empty acceptance criteria.
  - Cycle detection rejects the import and names one cycle in order (`T03 -> T07 -> T05 -> T03`).
  - `isReady(task, tasksById)` and `selectNext(features, tasks)` implement ADR 0019 readiness and selection.
  - `planReimport(existing, parsed)` returns the changes of ADR 0019 re-import rules, including the rejection when a removed task is running or in review.
  - Parsing `specs/002-local-core/tasks.md` itself yields 41 tasks and no errors.
- Verification: table-driven tests for each rule and error; a fixture with a three-node cycle; the real file of this plan as a fixture.

## T05. AgentDefinition v2 reader

- [x] Done
- Depends on: T02
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/agents/`, tests
- Acceptance criteria:
  - Parses the flat frontmatter of ADR 0021 (one `key: value` per line, comma lists, dotted keys, `#` comments) and returns the definition and the body; anything else is an error naming the line.
  - Validates required keys, `name` equal to the slug, slug pattern `^[a-z0-9-]+$`, known capabilities and contracts.
  - v1 files (no `schema`) map `tools` to capabilities as in ADR 0021, default `runtimes` and `contract`, and return a warning.
  - `skills` are checked against a given list of approved skill names; unknown skills are an error.
- Verification: unit tests with every real file in `agents/` (v1), a v2 sample, and invalid samples (nested YAML, bad slug, unknown capability).

## T06. SQLite store: engine, migrations, projects, features and tasks

- [x] Done
- Depends on: T02
- Profile: TS adapters
- Agent: roster-sqlite-store-engineer
- Areas: `src/adapters/store/sqlite/`, tests
- Acceptance criteria:
  - Uses `node:sqlite` only; opens one file; enables WAL and foreign keys; any experimental warning is suppressed for this module only and the suppression is documented in code.
  - Numbered migrations applied in one transaction at open; `schema_migrations` records them; re-opening applies nothing new.
  - Tables `projects`, `features`, `feature_events`, `grilling`, `tasks`, `task_dependencies` as in plan 002 section 5.
  - StorePort methods for these tables, including an atomic `importTasks` that writes all tasks and edges or nothing.
- Verification: tests on a temporary database file: migrations idempotent, round-trip of each entity, `importTasks` rollback on a forced failure.

## T07. SQLite store: executions, steps, events, approvals, runtime state

- [x] Done
- Depends on: T06
- Profile: TS adapters
- Agent: roster-sqlite-store-engineer
- Areas: `src/adapters/store/sqlite/`, tests
- Acceptance criteria:
  - Tables `executions`, `execution_steps`, `execution_events`, `approval_requests`, `runtime_state` as in plan 002 section 5, added by a new migration, including the rate-limit columns of `executions` and `cooldown_source` and `cooldown_window` of `runtime_state` (ADR 0030).
  - StorePort methods: start, update step, finish execution; append event; request and resolve approvals; read and set runtime cooldown (with `cooldown_until`, source and window); count executions started inside a time window; list latest executions per feature.
  - StorePort methods `recordRateLimit(executionId, snapshot)`, which overwrites the execution's previous snapshot, and `latestRateLimit(runtime)`, which returns the most recently observed snapshot of that runtime with its execution id, or none.
  - Execution ids follow `<yyyymmddhhmmss>-<6 hex>`.
- Verification: tests on a temporary database: full lifecycle of an execution with steps and events, window count, cooldown read/write with both sources, snapshot overwrite within one execution, latest snapshot across executions, and null columns when no snapshot was recorded.

## T08. Policy module and policy files

- [x] Done
- Depends on: T02
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/policy/`, `policies/mvp.json`, `policies/protected-paths.json`, tests (protected paths)
- Acceptance criteria:
  - `policies/mvp.json` holds the operation classes, limits, timeouts per profile, `providerHosts` (`api.anthropic.com`), `registryHosts` (`registry.npmjs.org`) and default dependency manifests of ADR 0024.
  - `policies/protected-paths.json` holds the default and Roster-repo patterns of ADR 0025.
  - A glob matcher (`**`, `*`, literal segments; case-sensitive; forward slashes) with no dependencies.
  - `checkChanges({ jobKind, changedPaths, projectPolicy })` returns protected matches, paths outside the job kind's allowed paths (ADR 0024 table) and changed dependency manifests; the hire exception allows only `agents/**` and `skills/registry.md`.
  - `limitsFor(profile)` caps agent `max-turns` and `timeout-minutes` by the policy.
- Verification: table-driven tests for every pattern in both files, each job kind, the hire exception, and a project that tries to remove a default pattern (rejected).

## T09. Project registry reader

- [x] Done
- Depends on: T02
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/projects.ts`, tests
- Acceptance criteria:
  - Reads every `projects/*.json` from `origin/main` of the Roster repo through `VcsPort.showFile` and validates the format of plan 002 section 6 (`name`, `repoPath`, `remote` as `https://github.com/<owner>/<repo>`, `defaultBranch` `main`, `setup`, `verify`, `dependencyManifests`, `protectedPaths`, `image`).
  - Invalid files are reported with file and field and skipped; valid ones are cached in the store with the commit they were read at.
  - `projectPolicy(project)` merges project protected paths and manifests with the defaults, never removing defaults.
- Verification: unit tests with a fake VcsPort: valid file, each invalid field, two projects.

## T10. Git adapter: workspaces, commits, changed paths and push guard

- [x] Done
- Depends on: T02
- Profile: TS adapters
- Agent: roster-boundary-adapters-engineer
- Areas: `src/adapters/vcs/git/`, `src/adapters/vcs/push-guard.ts`, tests (protected path: `push-guard.ts`)
- Acceptance criteria:
  - `createWorkspace(project, executionId)` clones from the project's local path into a separate git dir and work tree, removes any `.git` entry from the work tree, sets `origin` to the GitHub remote and fetches.
  - Every git call uses `execFile` with an argument array and passes `--git-dir`, `--work-tree`, `-c core.hooksPath=<empty dir>`, `-c core.fsmonitor=false`, `-c core.autocrlf=false` and no credential helper.
  - `prepareBranch(name)` checks out `origin/<name>` when it exists (returns `resumed: true`), otherwise creates it from `origin/main`.
  - `changedPaths(base)` (work tree and commits over a range), `commitAll(message, author)`, `showFile(ref, path)`, `headCommit()`.
  - `push(branch, ghToken)` goes through `push-guard.ts`, which refuses any destination outside `refs/heads/agent/`, `main`, `--force`, `--force-with-lease` and `+` refspecs; the token reaches only the push child as `GH_TOKEN` with `gh auth git-credential` as the helper for that command.
- Verification: tests against temporary repos with a bare `origin`: resume and fresh branch, a planted `.git/hooks/pre-commit` in the clone source does not run, push to `main` rejected by the guard, token absent from git config afterwards.

## T11. GitHub adapter through `gh`

- [x] Done
- Depends on: T02
- Profile: TS adapters
- Agent: roster-boundary-adapters-engineer
- Areas: `src/adapters/forge/github/`, tests
- Acceptance criteria:
  - `ensurePr({ repo, branch, title, body })` reuses an open PR for the branch or creates one against `main`; returns number and URL.
  - `prState(repo, number)` returns `open`, `merged` (with `mergedAt`) or `closed`.
  - `mainProtection(repo)` returns whether PRs are required and force pushes blocked, or `unknown` without Administration read.
  - `gh` runs through `execFile` with `GH_TOKEN` in its environment only; the token is never an argument or in an error message.
  - PR bodies are passed through a file or stdin, not as an argument.
- Verification: unit tests with a stubbed process runner: argument lists, environment, JSON parsing of each state, error mapping.

## T12. DPAPI secrets adapter and `roster auth set`

- [x] Done
- Depends on: T03
- Profile: Windows/PowerShell
- Agent: roster-windows-powershell-engineer
- Areas: `src/adapters/secrets/dpapi/`, `src/adapters/console/tty/`, `src/cli/commands/auth.ts`, tests
- Acceptance criteria:
  - `set(name, value)` and `get(name)` for `claude-oauth-token` and `github-token`, stored under `%LOCALAPPDATA%\Roster\secrets\` with DPAPI (current user) through `powershell.exe -NoProfile -NonInteractive`; the value travels through stdin, never through arguments.
  - `roster auth set claude|github` reads the value from stdin without echo and prints only the last 4 characters.
  - `get` of a missing secret raises a typed error naming the `roster auth set` command.
  - A redaction helper replaces known secret values in any text with `[redacted]`.
- Verification: unit tests with a stubbed runner (arguments contain no secret); a Windows-only integration test, skipped elsewhere, round-trips a dummy value.

## T13. Container images and egress proxy

- [x] Done
- Depends on: T01, T14
- Profile: container/devops
- Agent: roster-container-devops-engineer
- Areas: `container/runtime-claude/`, `container/egress-proxy/`, tests (protected paths)
- Acceptance criteria:
  - `container/runtime-claude/Dockerfile`: `node:24-bookworm-slim` pinned by digest, user `agent` uid 1000, Claude Code CLI at a pinned version (build argument with a default), auto-update disabled, `ripgrep` and `ca-certificates`, no `git`, no `gh`, working directory `/workspace`.
  - `container/egress-proxy/proxy.ts`: zero-dependency HTTP CONNECT proxy that allows only `host:443` pairs given as arguments, rejects everything else with 403, never forwards plain HTTP, and logs one JSON line per decision.
  - `container/egress-proxy/Dockerfile` from the same base, non-root.
  - Applies the T14 findings: Claude Code CLI version, flags and the Anthropic hosts in the allowlist.
  - Both images build with `docker build` and carry a label with the Roster commit.
- Verification: unit tests of the proxy's allow/deny logic and request parsing; the human runs `docker build` of both images and pastes the result in the PR.

## T15. Docker sandbox adapter

- [x] Done
- Depends on: T02, T08, T13, T14
- Profile: TS adapters
- Agent: roster-boundary-adapters-engineer
- Areas: `src/adapters/sandbox/docker/`, tests (protected path: `isolation.ts`)
- Acceptance criteria:
  - `isolation.ts` builds the full `docker run` argument list for the four profiles `agent`, `review`, `setup`, `verify` exactly as in plan 002 section 9: user, read-only root, tmpfs, `--cap-drop ALL`, `no-new-privileges`, limits from policy, mounts (and nothing else), network, `--dns 0.0.0.0`, environment by name only.
  - `SandboxPort.run(invocation)` creates the per-execution internal network, starts the proxy with the profile's allowlist, runs the job container, writes its stdout and stderr to the job's log files with secret redaction (next criterion), kills it at the timeout, and removes network and proxy at the end, also on errors.
  - Job logs follow ADR 0031: stdout goes to `<log_dir>\<job>.jsonl` for runtime jobs (`agent`, `review`) or `<job>.log` for `setup` and `verify`, and stderr to `<job>.stderr.log`, where `<job>` is the job's `execution_steps` step. Output is split into complete lines; each line is redacted and appended as soon as it is complete, and an unterminated last line is redacted and flushed when the job ends. Apart from redaction, `.jsonl` lines are the runtime's raw `stream-json` lines, and nothing else is written into them. Files are opened without exclusive sharing, so another process (`roster watch`) can read them while they are written.
  - `kill(executionId)` kills every container named `roster-<execution-id>-*` and removes the network.
  - `available()` runs `docker info` with a 20 s timeout.
  - Environment values reach only the `docker` child process; none appear in any argument.
- Verification: unit tests with a stubbed runner asserting the exact argument lists per profile, the absence of extra mounts and of `GH_TOKEN`, timeout kill and cleanup; log tests: a secret split across two output chunks is redacted, a redacted `stream-json` line still parses as JSON, stderr never reaches the `.jsonl` file, and a second reader sees each complete line before the job ends; an opt-in integration test (`ROSTER_DOCKER_IT=1`).

## T16. Claude Code runtime adapter

- [x] Done
- Depends on: T05, T08, T14
- Profile: TS adapters
- Agent: roster-boundary-adapters-engineer
- Areas: `src/adapters/runtime/claude-code/`, `test/fixtures/claude/`, tests (protected path: `managed-settings.ts`)
- Acceptance criteria:
  - `managed-settings.ts` generates the managed settings of plan 002 section 9.5 from the agent's capabilities and the policy: managed-only rules and hooks, `dontAsk`, bypass disabled, connectors disabled, allow rules per capability, the deny list, `WebFetch` denied.
  - `buildInvocation(job)` returns image, argv and files for `/roster/in` as in plan 002 section 9.5, with the flag changes recorded by T14; `--bare` can never appear (test).
  - `interpret(exit, logPath)` parses the `stream-json` log and returns `completed`, `quota_exhausted` (patterns in one exported constant), `timeout`, `error` or `stopped`.
  - For every outcome, `interpret` puts the last `rate_limit_event` of the log in `detail.rateLimit` (ADR 0030): `rate_limit_info.status`, `rateLimitType`, and `utilization` and `resetsAt` of `unifiedWindows.five_hour` and `seven_day`, with epoch seconds converted to ISO 8601 UTC. Missing or malformed fields are left out; no event leaves `rateLimit` undefined; parsing never changes the outcome kind.
  - For `quota_exhausted`, `detail.quotaResetsAt` is the latest `resetsAt` among the window named by `rateLimitType` (its `unifiedWindows` entry, else the top-level `resetsAt`) and every window with `utilization >= 1`, and `detail.quotaWindow` names that window; both undefined when no reset time is available. The adapter applies no fallback.
  - Reading `/roster/out/result.json` and validating it is left to the orchestrator.
- Verification: unit tests with the T14 fixtures and synthetic fixtures for each outcome; the `success-pong.jsonl` fixture yields status `allowed`, type `five_hour`, utilization 0.04 and 0.6 and both reset times; synthetic quota fixtures cover a 5-hour exhaustion, a 7-day exhaustion (7-day reset and window `seven_day` chosen) and a stream with no `rate_limit_event` (no `quotaResetsAt`); snapshot of the generated managed settings for each capability set.

## T42. Registration: base branch, branch prefix and agent branch names

- [ ] Done
- Depends on: T09
- Profile: TS core
- Areas: `src/core/domain/project.ts`, `src/core/domain/branches.ts`, `src/core/orchestrator/projects.ts`, tests
- Acceptance criteria:
  - Follow-up of T09 for ADR 0032. `ProjectRegistration` drops `defaultBranch` and gains `baseBranch` and `branchPrefix`, always set after parsing (defaults `main` and `agent` when the file omits them).
  - `parseRegistration` validates both fields with the rules of ADR 0032 section 1 and reports file and field: `baseBranch` is a plain branch name of 1 to 100 characters, does not start with `agent/`, has no segment starting with `agent-`, and differs from `branchPrefix`; `branchPrefix` matches `^[a-z][a-z0-9_-]{0,31}$` and is none of `main`, `master`, `develop`, `head`, `refs`, `origin`.
  - A file that still has `defaultBranch` is invalid, with a message that names `baseBranch`. Messages never echo the value (T09 rule).
  - `readProjects` reports the Roster repo's registration as invalid (and skips it) unless it resolves to `baseBranch` `main` and `branchPrefix` `agent`. `REGISTRY_REF` stays `origin/main`.
  - `src/core/domain/branches.ts` is pure and is the only place that formats agent branch names: `taskBranch(rules, NNN, Tnn)`, `specBranch(rules, NNN)`, `planBranch(rules, NNN)`, `hireBranch(slug)` and `registrationBranch(name)` produce the names of ADR 0032 section 2 (namespace `agent/` for prefix `agent`, `<prefix>/agent-` otherwise); `ROSTER_REPO_BRANCH_RULES` is `{ baseBranch: 'main', branchPrefix: 'agent' }` and is used by the hire and registration builders. Inputs are validated (three-digit `NNN`, task key, slug pattern) with typed errors.
  - `isAgentBranch(rules, name)` is true exactly for names in the project's agent namespace with one segment after the prefix.
- Verification: unit tests: defaults when both fields are absent; each invalid value (reserved prefix, uppercase prefix, two-segment prefix, base under `agent/`, base with an `agent-` segment, base equal to the prefix, base over 100 characters); a stale `defaultBranch`; the Roster repo registered with `develop` or prefix `feature` rejected; name tables for prefixes `agent` and `feature` (`agent/002-T01`, `feature/agent-002-T01`, spec, plan, hire, registration); `isAgentBranch` false for `feature/login`, `agent/x/y`, `feature/agent-` and `agent/002-T01` under prefix `feature`.

## T43. Push guard and git adapter: project branch rules

- [ ] Done
- Depends on: T10, T42
- Needs human: changes the protected path `src/adapters/vcs/push-guard.ts` (ADR 0025); the human pushes the branch
- Profile: TS adapters
- Areas: `src/adapters/vcs/push-guard.ts`, `src/adapters/vcs/git/`, `src/ports/vcs.ts`, `test/fakes/`, tests (protected path: `push-guard.ts`)
- Acceptance criteria:
  - Follow-up of T10 for ADR 0032 section 3. `push-guard.ts` exports `createPushGuard({ baseBranch, branchPrefix })`, which validates the rules itself (patterns and reserved names of ADR 0032 section 1) and returns a frozen `{ pushArguments(branch), assertSafePush(argv) }`; invalid rules throw `PushRejectedError`.
  - The guard imports nothing from `core` except the error type, and does not call the T42 naming or registration code.
  - The destination must be `refs/heads/<branchPrefix>/<one segment>`; when the prefix is not `agent`, the segment starts with `agent-` and has at least one character after it. `refs/heads/main`, `refs/heads/master`, `refs/heads/develop` and `refs/heads/<baseBranch>` are always refused.
  - Every other T10 rule is unchanged: remote `origin`, the fixed options, exactly one `R:R` refspec with the same source and destination, no `+`, no force option, no delete, the safe global options and the push-only credential helper.
  - `WorkspaceSource` gains `baseBranch` and `branchPrefix`. `GitVcsOptions.pushGuard` becomes a factory with the signature of `createPushGuard`, called once in `createWorkspace` with the source's rules; there is still no unguarded push, and a workspace cannot change its rules afterwards.
  - `prepareBranch(name)` checks out `origin/<name>` when it exists (`resumed: true`), otherwise creates the branch from `origin/<baseBranch>`; a missing base fails with `NotFoundError` naming `origin/<baseBranch>`.
  - Port comments and the fake VcsPort follow the new signatures.
- Verification: guard table tests for prefixes `agent` and `feature` with bases `main` and `develop`: `agent/002-T01` and `feature/agent-002-T01` allowed under their own prefix; refused `feature/login`, `agent/002-T01` under prefix `feature`, `feature/agent-`, `feature/agent-x/y`, `main`, `master`, `develop`, the base branch, `+` refspecs, every force option, a delete and two refspecs; invalid rules refused at creation (reserved prefix, uppercase prefix, base under `agent/`, base equal to the prefix). Git tests against temporary repos with a bare `origin` that has `main` and `develop`: a fresh branch starts from `origin/develop`, resume still works, a missing base fails, and the T10 tests still pass.

## T44. GitHub adapter: PRs against the base branch and branch protection

- [ ] Done
- Depends on: T11, T42
- Profile: TS adapters
- Areas: `src/adapters/forge/github/`, `src/ports/forge.ts`, `test/fakes/`, tests
- Acceptance criteria:
  - Follow-up of T11 for ADR 0032 sections 4 and 5. `ensurePr({ repo, branch, base, title, body })` reuses the open PR from `branch` into `base` or creates one; `base` is validated as a plain branch name; the lookup matches both head and base. The constant `BASE_BRANCH` is removed.
  - The branch check accepts only the agent namespace forms of ADR 0032 (`agent/<one segment>`, or `<prefix>/agent-<rest>` with one segment after the prefix) and refuses a branch equal to `base`, `main`, `master` or `develop`.
  - `mainProtection(repo)` is replaced by `branchProtection(repo, branch)`, returning `missing` (404 from the branches endpoint), `unknown`, or `{ prRequired, forcePushBlocked }`, combining rulesets and classic protection as T11 does.
  - The token and PR body rules of T11 are unchanged.
- Verification: unit tests with the stubbed runner: create and reuse against `develop`; an open PR from the same branch into another base is not reused; branch checks for both namespace forms; `branchProtection` for a protected, an unprotected, an unreadable and a missing branch; the adapted T11 tests pass.

## T18. Sync of task PR states

- [ ] Done
- Depends on: T07, T11
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/sync.ts`, tests
- Acceptance criteria:
  - `sync()` fetches the Roster repo and every registered project, refreshes registrations (T09), and reads the state of every task PR Roster has not yet seen closed.
  - Merged ─► task `done` with `merged_at`; closed unmerged ─► task `rejected` with the reason; open ─► unchanged.
  - Each change writes an event; a GitHub error for one PR does not stop the others and is reported.
- Verification: unit tests with fake ForgePort, VcsPort and store asserting the resulting states and events.

## T19. Feature import (adopt) and `tasks.md` import

- [ ] Done
- Depends on: T04, T07, T09, T10, T42
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/import.ts`, tests
- Acceptance criteria:
  - `importFeature(project, "NNN-slug")` requires `spec.md`, `plan.md` and `tasks.md` on `origin/<baseBranch>` of the project (ADR 0032), records the stages `idea` to `plan_approved` in order with the commit that brought each file to the base branch as evidence, imports `tasks.md` and moves the feature to `execution`.
  - Import errors and cycles write nothing and return the parser's messages.
  - `[x] Done` tasks import as `done` on first import (ADR 0019); re-import applies `planReimport`.
  - Importing `specs/002-local-core` of this repository works on a fixture repo.
- Verification: unit tests with a fake VcsPort: fresh import, import from a project whose base branch is `develop` (files only on `origin/develop`), cycle rejection, re-import with a removed unstarted task, re-import rejected while a task is running.

## T20. Orchestrator: task pipeline happy path

- [ ] Done
- Depends on: T03, T07, T08, T10, T11, T15, T16, T18, T19, T42, T43, T44
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/run.ts`, `src/core/orchestrator/prompt.ts`, tests
- Acceptance criteria:
  - With injected ports, runs plan 002 section 8 steps 1, 3, 4, 5, 6, 9, 10 and 11 (setup, verify and review come in T25, T26 and T36): workspace, agent job, result validation, policy check, commit, push, PR, record.
  - The prompt contains the task text, acceptance criteria, spec and plan paths, the result contract, the statement that git and network are unavailable, and resume and retry notes when they apply.
  - The workspace is created with the project's `baseBranch` and `branchPrefix` from the registration loaded by sync; the branch is `taskBranch` of T42 (`agent/<NNN>-<Tnn>` by default, `<prefix>/agent-<NNN>-<Tnn>` otherwise); the policy check of step 9 covers `origin/<baseBranch>..HEAD`; the PR targets `baseBranch`. PR title `<NNN>-<Tnn>: <title>`; PR body with task id, summary, agent verification, notes and execution id.
  - A selected task without an approved agent ends `blocked` with the "no agent" reason (replaced by hiring in T28).
  - Nothing is pushed before the result is validated and the policy check passes.
  - Runtime resolution in the skeleton: the only runtime is `claude-code`; while its
    `runtime_state.cooldown_until` is in the future, the run exits 0 with "quota cooldown". The
    capability router replaces this in T17.
  - Runtime jobs go through one helper that, right after `interpret` and whatever the outcome, stores `detail.rateLimit` on the execution with `recordRateLimit` when present (ADR 0030). Later jobs (review, hire, stage jobs) reuse it.
- Verification: unit test asserting the exact ordered list of side effects and store updates for the happy path (including the rate-limit record) and for "nothing to do"; the happy path also runs for a project with base `develop` and prefix `feature` and asserts the branch `feature/agent-<NNN>-<Tnn>`, the range base and the PR base.

## T21. Orchestrator: stop, failure, quota and recovery paths

- [ ] Done
- Depends on: T20
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/`, tests
- Acceptance criteria:
  - Result `blocked` ─► task `blocked` with the agent's questions; nothing pushed.
  - Missing or invalid result, `timeout`, `error`, no changes, or an exception after start ─► execution and task `failed` with the reason in `human_language`; nothing pushed.
  - Protected path or path outside the allowed ones ─► commit kept locally, task `blocked`, approval request `protected_path` naming the paths and the local branch; nothing pushed.
  - Changed dependency manifests ─► commit kept locally, task `blocked`, approval request `dependencies` with the manifest hash; nothing pushed.
  - `quota_exhausted` ─► ADR 0028: WIP commit, guarded push of the task's agent branch (ADR 0032) without PR, task `todo`, runtime cooldown.
  - Cooldown length (ADR 0030): `cooldown_until = detail.quotaResetsAt` with source `resets_at` and window `detail.quotaWindow` when it is later than now and at most 8 days after now; otherwise `now + quotaCooldownMinutes` with source `fallback` and no window. `quota_exhausted_at` is now in both cases.
  - The rate-limit snapshot is recorded on the execution on every path of this task that ran a runtime job, including `quota_exhausted`, `timeout` and `error`.
  - Start-of-run recovery: an execution left `running` by a dead PID ─► `interrupted`, task `failed`, sandbox `kill` called.
  - The range check of step 9 covers `origin/<baseBranch>..HEAD`, including commits from earlier resumed runs.
- Verification: one unit test per path asserting final states, events, message template and the absence of push or PR where required; cooldown tests with a fake clock for a 5-hour reset, a 7-day reset, a missing reset, a reset in the past and a reset more than 8 days ahead (the last three use the fallback).

## T22. CLI wiring: `run`, `feature import`, `sync`, `doctor`

- [ ] Done
- Depends on: T12, T21
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/cli/`, tests
- Acceptance criteria:
  - `roster run [--dry-run]` implements plan 002 section 7.4: lock with PID, interrupted recovery, `maxRunsPerNight` window, Docker check (exit 2), sync, one unit of work, exit 0 on every handled outcome and non-zero only on Roster bugs.
  - `--dry-run` prints the selected unit and planned steps and writes nothing except the sync cache.
  - `roster feature import <project> <NNN-slug>`, `roster sync` and `roster doctor` (checks of plan 002 section 7.8 that exist so far) are wired with real adapters.
  - The composition root wires `createPushGuard` (T43) as the git adapter's guard factory.
  - `doctor` checks, for every registered project, that the base branch exists and that the base branch and `main` (when different and present) are protected, through `branchProtection` (T44); a missing `main` is reported, not failed (ADR 0032).
  - The lock file is removed on every exit path, including uncaught errors and Ctrl+C.
- Verification: unit tests with fakes per command, including `doctor` for a project with base `develop` (protected, unprotected, missing `main`); a `--dry-run` snapshot test; manual run of `roster doctor` on the human's PC pasted in the PR.

## T23. Pinned install script and `roster.cmd` shim

- [ ] Done
- Depends on: T22
- Profile: Windows/PowerShell
- Agent: roster-windows-powershell-engineer
- Areas: `scripts/install.ps1`, `src/cli/commands/doctor.ts`, tests (protected path: `scripts/install.ps1`)
- Acceptance criteria:
  - `scripts/install.ps1 [-Update]` clones or fast-forwards the Roster repo's `origin/main` into `%LOCALAPPDATA%\Roster\app` at a given or latest commit, refuses if the target has local changes, runs `npm ci --omit=dev`, builds both images tagged with the commit, and writes `%LOCALAPPDATA%\Roster\bin\roster.cmd`.
  - The script never reads or writes secrets and never touches the human's working copy.
  - `doctor` reports the pinned commit, fails if it is not on `origin/main` or has local changes, and shows how many commits it is behind.
- Verification: the human runs the script once and pastes the output; `doctor` unit tests for clean, dirty and off-main installs.

## T24. Machine setup and first real run

- [ ] Done
- Depends on: T14, T23
- Needs human: credentials, repository settings, Docker Desktop and Windows setup, real run
- Profile: container/devops
- Agent: roster-container-devops-engineer
- Areas: GitHub settings, `%LOCALAPPDATA%\Roster\`, `projects/roster.json`
- Acceptance criteria:
  - The human runs `claude setup-token` and `roster auth set claude`; creates the fine-grained PAT of ADR 0029 for the Roster repo and runs `roster auth set github`.
  - `main` of the Roster repo requires PRs and blocks force pushes, with no bypass.
  - Docker Desktop starts at sign-in with the WSL2 backend.
  - The human commits `projects/roster.json` (with `setup` and `verify` commands, and with `baseBranch` and `branchPrefix` either omitted or set to `main` and `agent`, ADR 0032) through a reviewed PR.
  - `scripts/install.ps1` installed the pinned version; `roster doctor` passes.
  - `roster feature import roster 002-local-core` imports this file with every Phase A task before T24 `done`.
  - `roster run` executes the next ready Phase B task in a container and opens a PR from `agent/002-<Tnn>` without manual steps.
- Verification: the human records the `doctor` output, the import summary, the execution id and the PR link in this task's PR.

## Phase B — Complete execution

## T17. Runtime router and registry

- [ ] Done
- Depends on: T05, T07, T24
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/router/`, `src/cli/runtimes.ts`, `src/core/orchestrator/`, tests
- Acceptance criteria:
  - `selectRuntime({ agent, enabled, runtimes, state, now })` implements ADR 0022: first preferred, enabled, capable runtime not in cooldown; otherwise a typed "none" with the reason.
  - `ROSTER_HARNESS`, when set, restricts the choice to that runtime; unknown names fail fast.
  - The CLI registry maps `claude-code` to the adapter of T16.
  - Replaces the fixed runtime resolution of T20; the orchestrator's existing tests still pass.
- Verification: table-driven tests: capability missing, cooldown active and expired, override, unknown name.

## T25. Verification step

- [ ] Done
- Depends on: T24
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/verify.ts`, `src/core/orchestrator/run.ts`, tests
- Acceptance criteria:
  - After the commit, each project `verify` command runs in the `verify` profile (no network, no token); exit codes and the last 50 lines of output are recorded as a step and in the log directory.
  - All pass ─► the PR body gets a "Verification by Roster" section listing each command and result.
  - Any failure ─► task `failed` with the failing command and tail in `human_language`; the branch is pushed through the guard; no PR.
  - A project without `verify` commands records the step as `skipped` and says so in the PR body.
- Verification: unit tests with fake sandbox outcomes for pass, fail and skipped, asserting side-effect order.

## T26. Setup step and dependency approval

- [ ] Done
- Depends on: T25
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/setup.ts`, `src/core/orchestrator/run.ts`, tests
- Acceptance criteria:
  - Before the agent job, the project's `setup` commands run in the `setup` profile only when the work tree's dependency manifests equal `origin/<baseBranch>` (ADR 0032) or their SHA-256 matches a resolved `dependencies` approval for the task.
  - Otherwise setup is skipped and the prompt says dependencies are not installed.
  - A resolved approval is consumed by one successful execution; later manifest changes need a new approval.
  - Setup failure ─► task `failed` with the reason.
- Verification: unit tests: unchanged manifests, approved hash, changed hash after approval, setup failure, and unchanged manifests compared with `origin/develop` for a project whose base is `develop`.

## T27. `roster retry`

- [ ] Done
- Depends on: T26
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/cli/commands/retry.ts`, `src/core/orchestrator/retry.ts`, tests
- Acceptance criteria:
  - `roster retry <task> [--note <text>] [--approve-dependencies]` moves a `blocked`, `failed`, `stopped` or `rejected` task to `todo` and refuses any other state.
  - `--note` is stored and included in the next prompt as the human's answer, then cleared after that execution.
  - `--approve-dependencies` resolves the task's pending `dependencies` approval for its recorded hash; it fails if there is none.
  - A pending `protected_path` approval cannot be resolved by this command; it explains, in `human_language`, that the human must push the branch.
- Verification: unit tests per state and flag. If the human rejects open questions 1 or 2 of plan 002, this task is re-planned before it starts.

## T28. Hiring step

- [ ] Done
- Depends on: T24
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/hire.ts`, `src/core/orchestrator/run.ts`, `src/core/orchestrator/sync.ts`, tests
- Acceptance criteria:
  - Implements ADR 0027: hr-director job on a fresh Roster repo workspace with the task text, the target project's stack files and approved skills in `/roster/in`.
  - No changes and the slug on `origin/main` ─► assignment recorded, specialist runs in the same invocation.
  - Changes ─► commit on `agent/hire-<slug>` (`hireBranch` of T42, workspace created with the Roster repo rules `main` and `agent`), guarded push, PR `hire: <slug>` against `main` of the Roster repo, task `waiting_hire`, whatever the target project's base branch and prefix.
  - Paths outside `agents/**` and `skills/registry.md`, invalid result or `needsHuman` ─► task `blocked`; nothing pushed.
  - Sync: hire PR merged ─► every task waiting for the slug returns to `todo` with the assignment.
- Verification: unit tests with fakes for reuse, hire PR (also for a target project with base `develop` and prefix `feature`, where the hire branch and PR still use the Roster repo rules), invalid result, forbidden path, and the merge detected by sync.

## T29. Windows Task Scheduler integration

- [ ] Done
- Depends on: T24
- Profile: Windows/PowerShell
- Agent: roster-windows-powershell-engineer
- Areas: `src/adapters/scheduler/windows/`, `src/cli/commands/schedule.ts`, `src/cli/commands/doctor.ts`, tests
- Acceptance criteria:
  - `roster schedule install` registers task `Roster\run` through PowerShell `ScheduledTasks` cmdlets with the triggers of ADR 0015 from `nightWindow`, "run only when user is logged on", wake to run, start when available, 110 minute limit, action `%LOCALAPPDATA%\Roster\bin\roster.cmd run`.
  - `roster schedule remove` and `roster schedule show` work; `install` is idempotent.
  - `doctor` reports whether the task exists and its next run time.
  - The night window for `maxRunsPerNight` uses the same `nightWindow` value.
- Verification: unit tests asserting the generated PowerShell with a stubbed runner; the human registers it once and pastes `roster schedule show`.

## Phase C — Feature lifecycle

## T30. Lifecycle state machine and store transitions

- [ ] Done
- Depends on: T24
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/lifecycle/`, `src/core/orchestrator/lifecycle.ts`, tests
- Acceptance criteria:
  - Pure `transition(feature, event)` implements ADR 0020 stages and steps and rejects skipped or backward stage moves with a typed error.
  - Every accepted transition writes a `feature_events` row with evidence (PR URL and `mergedAt`, or commit).
  - A closed unmerged spec or plan PR resets the step as in ADR 0020.
  - `roster feature import` (T19) uses the same transition function.
- Verification: table-driven tests over every stage and step pair; store test for the event rows.

## T31. Migrate agent definitions to v2

- [ ] Done
- Depends on: T05
- Needs human: changes protected paths (`agents/**`, `scripts/sync-agents.ps1`); the human pushes the branch
- Profile: docs
- Agent: roster-agent-definitions-engineer
- Areas: `agents/*.md`, `scripts/sync-agents.ps1`, `AGENTS.md`
- Acceptance criteria:
  - Every file in `agents/` uses the v2 frontmatter of ADR 0021 with capabilities, runtimes and contract; `architect` uses contract `architect`, `hr-director` uses `hr` and its template produces v2 files.
  - Linear steps are removed from `project-manager` and from every specialist's closing rule; closing rules describe the result file of ADR 0026.
  - `scripts/sync-agents.ps1` maps capabilities back to Claude Code tool names for `.claude/agents/`.
  - `AGENTS.md` notes that in Roster runs rule 7 is fulfilled through the result file and that agents have no git or network.
- Verification: the T05 reader parses every file with no warnings; the sync script output for one agent is shown in the PR.

## T32. Hire the lifecycle agents: analyst and code reviewer

- [ ] Done
- Depends on: T28, T31
- Needs human: the human reviews and merges the hire PRs
- Profile: docs
- Agent: hr-director
- Areas: `agents/analyst.md`, `agents/code-reviewer.md`
- Acceptance criteria:
  - `hr-director` defines `analyst` (capabilities `read`, `edit`; contract `analyst`; asks questions in `human_language`, writes only `specs/<feature>/spec.md` from the spec template used in this repo).
  - `hr-director` defines `code-reviewer` (capability `read`; contract `reviewer`; reviews the diff against the task's acceptance criteria and the ADRs).
  - Both hire PRs are merged by the human.
- Verification: both files are on `origin/main` and parse with the T05 reader.

## T33. Grilling: `roster feature new`

- [ ] Done
- Depends on: T30, T32
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/cli/commands/feature-new.ts`, `src/core/orchestrator/analysis.ts`, `src/adapters/console/tty/`, tests
- Acceptance criteria:
  - Implements plan 002 section 7.2: idea from file or stdin, next free `NNN` from `specs/` on `origin/<baseBranch>` of the project, stages `idea` then `analysis`, analyst questions job, interactive questions and answers in the terminal, every question and answer stored.
  - Spec draft job with allowed path `specs/<NNN-slug>/spec.md` only; more questions repeat the round, at most 3 rounds.
  - Roster commits the draft on `specBranch` of T42 (`agent/<NNN>-spec` by default), pushes, opens PR `spec(<NNN-slug>): <title>` against the project's base branch, step `spec_pr_open`.
  - The command takes the global lock and refuses to run while another execution is running.
- Verification: unit tests with fake console, sandbox and runtime for one round, two rounds, the round limit and a forbidden path, and one round for a project with base `develop` and prefix `feature` (branch `feature/agent-<NNN>-spec`, PR into `develop`).

## T34. Gate detection and the architect stage job

- [ ] Done
- Depends on: T30, T31
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/sync.ts`, `src/core/orchestrator/stage-jobs.ts`, `src/core/orchestrator/run.ts`, tests
- Acceptance criteria:
  - Sync: spec PR merged ─► `spec_approved`/`plan_job_pending` with the merge date; plan PR merged ─► `plan_approved`, then import from `origin/<baseBranch>` of the project, then `execution`, or `import_failed` with the parser's errors; all tasks `done` or `cancelled` ─► `delivered`.
  - `roster run` picks a `plan_job_pending` feature before any task and runs the architect job (contract `architect`, allowed paths `specs/<feature>/**` and `docs/adr/**`), then commits on `planBranch` of T42 (`agent/<NNN>-plan` by default), pushes and opens PR `plan(<NNN-slug>): ...` against the project's base branch, step `plan_pr_open`.
  - Architect `blocked` ─► the question is shown by `roster status`; the step stays `plan_job_pending`.
- Verification: unit tests with fakes for each transition and for the stage-job priority over tasks, including a plan PR into `develop` for a project whose base is `develop`.

## T35. `roster project add`

- [ ] Done
- Depends on: T24
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/cli/commands/project-add.ts`, `src/core/orchestrator/projects.ts`, tests
- Acceptance criteria:
  - Implements plan 002 section 7.1: `roster project add <name> --path <repo> [--base <branch>] [--branch-prefix <prefix>]` validates repo, `origin` URL, token access, the base branch and prefix rules of ADR 0032 (defaults `main` and `agent`), that the base branch exists, and the protection of the base branch and of `main` when different and present (`branchProtection`, T44); writes `projects/<name>.json` (with `baseBranch` and `branchPrefix` when they differ from the defaults) in a fresh Roster repo workspace; commits; pushes `agent/project-<name>` (`registrationBranch` of T42, Roster repo rules); opens PR `project: register <name>` against `main` of the Roster repo.
  - This is the only code path allowed to push a change under `projects/**`; it changes exactly one file there and nothing else.
  - Validation failures print the reason in `human_language` and write nothing.
- Verification: unit tests with fakes for success with the defaults, success with `--base develop --branch-prefix feature`, and each validation failure (invalid prefix, missing base branch, unprotected base branch).

## Phase D — Code review

## T36. Code review step

- [ ] Done
- Depends on: T25, T32
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/orchestrator/review.ts`, `src/core/orchestrator/run.ts`, tests
- Acceptance criteria:
  - After verification passes and before the push, a `code-reviewer` job runs in the `review` profile (work tree read-only) with the diff `origin/<baseBranch>..HEAD` (ADR 0032), the task's acceptance criteria and the list of ADR paths in `/roster/in`.
  - The verdict and findings go at the top of the PR body, grouped by severity.
  - A review error or invalid result does not block the PR; the PR body says the review is missing and why.
  - Review `quota_exhausted` follows ADR 0028, with the cooldown length of ADR 0030 (T21).
  - The review job runs through the job helper of T20, so its rate-limit snapshot replaces the agent job's snapshot on the execution.
- Verification: unit tests for approve, request_changes, invalid result and quota, asserting the PR body and step order, and that the stored snapshot after a review is the review job's.

## Phase E — Visibility and control

## T37. `roster status`

- [ ] Done
- Depends on: T30
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/cli/commands/status.ts`, `src/core/orchestrator/status.ts`, tests
- Acceptance criteria:
  - Implements plan 002 section 7.5: stage and step per feature, each task with its state (ready computed), PR links, pending questions and approval requests in `human_language`, latest executions with task, agent, runtime, start, end, status, log directory and PR.
  - Per runtime, shows the latest rate-limit snapshot (ADR 0030): status, limit type, 5-hour and 7-day utilization as percentages with their reset times in local time, when it was observed and in which execution; "no data" when none was recorded.
  - Per runtime, shows an active cooldown with its end in local time, source (`resets_at` or `fallback`) and window.
  - Read-only: performs no sync and no writes; shows the last sync time.
  - Filters by project and feature.
- Verification: snapshot tests from a seeded store in `es` and `en`, including a store with a recorded snapshot and a 7-day cooldown, and a store with no snapshot.

## T38. `roster stop`

- [ ] Done
- Depends on: T24
- Profile: TS adapters
- Agent: roster-core-ts-engineer
- Areas: `src/cli/commands/stop.ts`, `src/core/orchestrator/stop.ts`, `src/core/orchestrator/run.ts`, tests
- Acceptance criteria:
  - Implements plan 002 section 7.6: sets `stop_requested_at`, calls `SandboxPort.kill`, waits up to 30 s for the run process to finalize, otherwise finalizes itself.
  - The pipeline checks the flag after every step and finalizes as `stopped` (task `stopped`, nothing pushed, workspace kept).
  - Works from a second terminal while `roster run` holds the lock; does nothing harmful when no execution is running.
- Verification: unit tests with fakes for stop during the agent step, between steps, and with a dead run process.

## T41. `roster watch`: live activity view

- [ ] Done
- Depends on: T15, T16, T17, T37
- Profile: TS core
- Agent: roster-core-ts-engineer
- Areas: `src/core/domain/`, `src/ports/`, `src/adapters/runtime/claude-code/activity.ts`, `src/core/watch/`, `src/core/messages/`, `src/cli/commands/watch.ts`, `src/cli/log-follow.ts`, `src/adapters/store/sqlite/` (read queries only), `test/fixtures/claude/`, tests
- Acceptance criteria:
  - Implements plan 002 section 7.12 and ADR 0031. `core/domain` defines `ActivityEvent` (`start`, `tool`, `denied`, `tool_error`, `rate_limit`, `result`, each with an optional time); `RuntimePort` gets the optional member `activity`, a pure reducer `(state, line) => { state, events }`.
  - `src/adapters/runtime/claude-code/activity.ts` is pure and translates one `stream-json` line at a time: `system` `init` ─► `start` with CLI version, model and permission mode; each `tool_use` item of an `assistant` line ─► `tool` with its target: `file_path` relative to `/workspace` for `Read`, `Edit`, `Write` and `NotebookEdit`, the first line of `command` for `Bash`, `pattern` (and `path`) for `Grep` and `Glob`, `query` for `WebSearch`, `description` for `Task`, none for other tools.
  - A `tool_result` with `is_error: true` ─► `denied` with reason "not allowed" when its text matches a pattern in one exported constant (today `No such tool available`, spike finding 4), else `tool_error` with the first line of its text; the tool name comes from the `tool_use` id kept in the state. Successful `tool_result` content and assistant text produce no event.
  - `rate_limit_event` ─► `rate_limit`, using the same parsing as `interpret` of T16 (shared in the adapter folder, not duplicated); `result` ─► `result` with `subtype`, `is_error`, `num_turns`, `duration_ms` and the first line of `result` or of `errors[0]`. Unknown types, malformed JSON and non-JSON lines produce no event and never throw.
  - `core/watch` is pure: from the running (or last) execution with its task, feature and running step, the events and the current time, it renders the header (feature, task id and title, agent, runtime, job kind, current step, start time and elapsed time, rate-limit snapshot with 5-hour and 7-day utilization as percentages and reset times in local time, and when it was observed) and one line per event prefixed with the elapsed time. Labels come from `core/messages` in `human_language` (`es`, `en` fallback); tool names, paths and commands are printed verbatim.
  - Every string taken from a log has its control characters (C0, DEL, C1, including ESC) replaced, is printed on one line, and is cut to 120 characters.
  - The snapshot shown is the latest `rate_limit` event of the current job, else the execution's stored snapshot, else `latestRateLimit(runtime)` (T07); "no data" when there is none.
  - `src/cli/log-follow.ts` follows a file by polling about once per second: opens it read-only, reads from the last offset, closes it, keeps an unterminated last line buffered, and starts again at offset 0 if the file shrank. It never holds the file open between polls.
  - `roster watch [--once] [--lines <n>]` polls the store for the `running` execution and its running `execution_steps` row; follows `<log_dir>\<step>.jsonl` through the translator of `executions.runtime` (registry of T17) or `<step>.log` as plain lines; switches file when the step changes; shows "starting" while the log does not exist; on start shows the last `n` lines (default 20) of the current job.
  - After 60 s with no new line it prints one "still running" line with the step and elapsed time. When the execution's `pid` is not alive, it says the run process is gone and the next `roster run` marks it interrupted.
  - With no running execution it says so in `human_language`, shows the last execution's id, task, agent, status, end time, reason and PR link, and then follows the next execution that starts. `--once` prints the current view and exits 0; Ctrl+C exits 0.
  - Read-only: does not take `run.lock`, writes nothing to the store or the logs, never calls Docker, never reads a secret (no SecretsPort), and sends no input to any process. It works from a second terminal while `roster run`, also one started by Task Scheduler, holds the lock.
- Verification: translator tests with the three spike fixtures copied to `test/fixtures/claude/`: `managed-settings-denials.jsonl` yields `start`, `Read notes.txt`, `Bash: echo hi > /workspace/BASH_RAN`, `denied: Bash (not allowed)`, `Write WRITE_RAN.txt`, `denied: Write (not allowed)`, a rate-limit snapshot with 5-hour 0.05 and 7-day 0.6, and `result` `success` with 4 turns; `success-pong.jsonl` yields `start`, a snapshot and `result` `success` with text `pong`; `error-max-turns.jsonl` yields `Read notes.txt`, `Read .claude/settings.json` and `result` `error_max_turns` with "Reached maximum number of turns (2)"; synthetic lines cover every tool mapping, malformed JSON, a non-JSON line and an ESC sequence in a path. `core/watch` snapshot tests in `es` and `en`: running agent job, running verify job, idle with the last outcome, no rate-limit data, dead PID. Follow tests on a temporary file: appended lines, a line split across two writes, a shrunk file. CLI test with fakes for `--once`: no lock file created, no store write, no SecretsPort or SandboxPort call. The human runs `roster watch` in a second terminal during a real `roster run` and pastes the output in the PR (H11).

## Phase F — Documentation and acceptance

## T39. Documentation and operator runbook

- [ ] Done
- Depends on: T29, T34, T36, T37, T38, T41
- Profile: docs
- Agent: technical-writer
- Areas: `README.md`, `docs/runbook.md`, `AGENTS.md`
- Acceptance criteria:
  - `README.md` describes Roster as of spec 002 (no Linear), the layout and the commands.
  - `docs/runbook.md`: install and update of the pinned version, token setup and rotation, PAT repo list, Docker Desktop settings, scheduler, power settings for night runs, reading `roster status`, following a run live with `roster watch`, unblocking tasks, troubleshooting by symptom (Docker down, quota cooldown, protected path stop, dependency approval, interrupted run).
  - The quota cooldown entry explains the 5-hour and 7-day windows, the `fallback` source, and how to read the recorded utilization to tune `maxRunsPerNight` (ADR 0030).
  - The runbook explains `baseBranch` and `branchPrefix` (ADR 0032): the agent branch names, that the human never creates branches in a project's agent namespace, that the base branch and `main` must be protected, and the troubleshooting entries "missing base branch" and "push rejected by a ref conflict".
  - Every command, path and setting named exists in the code or the plan.
- Verification: link check; the PR lists each command named and the file that implements it.

## T40. End-to-end acceptance

- [ ] Done
- Depends on: T26, T27, T28, T29, T33, T34, T35, T36, T37, T38, T39, T41
- Needs human: real runs on a sandbox project with real credentials
- Profile: container/devops
- Agent: roster-container-devops-engineer
- Areas: a sandbox GitHub repo registered with Roster
- Acceptance criteria:
  - A sandbox project with protected `main` and `develop` branches is registered with `roster project add --base develop --branch-prefix feature` and the PR is merged.
  - An idea goes through grilling in the terminal, a spec PR, its merge, a scheduled architect run, a plan PR, its merge, and an automatic task import.
  - A scheduled night run executes one task in a container and leaves a PR with verification results and review findings.
  - Every PR Roster opens in the sandbox comes from a `feature/agent-...` branch into `develop`; `main` and `develop` are never pushed.
  - A task with ambiguous text ends `blocked` with a Spanish question; `roster retry --note` resumes it.
  - A task that edits `.github/workflows/` stops with a protected-path request and nothing is pushed.
  - `roster stop` ends a running execution; `roster status` shows all of the above.
  - `roster watch`, started in a second terminal, follows a scheduled run: header, one line per agent step, the job changes and the final result, with no token in its output.
- Verification: the human records execution ids, PR links, `roster status` output and a `roster watch` excerpt in this task's PR.
