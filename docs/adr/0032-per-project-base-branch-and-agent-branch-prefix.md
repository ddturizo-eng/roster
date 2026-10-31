# 0032. Per-project base branch and agent branch prefix

- Status: Proposed
- Date: 2026-10-30
- Deciders: architect (proposed), human
- Amends: 0018 (rule 1, project side), 0019 (import ref), 0020 (import evidence), 0024 (`vcs_write`
  and `install_dependencies` rows), 0025 (decision 2, range of the check), 0028 (decision 1, branch
  name), 0029 (protection check and consequences). The rest of each ADR stands.

## Context

Roster hardcodes two values: the base branch `main` (source of every agent branch, target of every
PR, the ref approved intent is read from, the base of the protected-path and dependency checks) and
the agent branch prefix `agent/` (task, spec, plan, WIP, hire and registration branches; the push
guard accepts only `refs/heads/agent/*`). They appear in ADRs 0018, 0019, 0020, 0024, 0025, 0028 and
0029, in plan 002 and in the code of the done tasks T09 (`defaultBranch` must be `main`), T10
(`prepareBranch` starts from `origin/main`; the guard accepts only `agent/`) and T11 (`ensurePr` base
`main`, branch must start with `agent/`, `mainProtection` reads only `main`).

Many projects the human wants Roster to work on use gitflow: work branches start from `develop`, PRs
target `develop`, and branch names follow the project's convention (`feature/...`, `fix/...`). The
human protects both `main` and `develop` with branch protection and reviews every PR. Roster only
opens PRs and never merges (ADR 0020).

Forces:

- **Correct diffs.** A branch cut from `main` in a gitflow repo misses everything on `develop`. Its PR
  against `develop` shows unrelated changes, and a range check `origin/main..HEAD` would include every
  `develop` commit not yet released, so a human change to `.github/workflows/` on `develop` would stop
  every task as a protected-path match.
- **Guard safety.** The push guard (ADR 0024, 0025) is the last line before GitHub. Today its rule is
  one fixed namespace. A configurable prefix must not let Roster push to a human branch
  (`feature/login`), to `main`, to `develop`, or to the base branch, and the value must not be
  something an agent can influence.
- **Self-modification protection.** ADR 0025 anchors trust in `origin/main` of the Roster repo:
  the pinned install, policies, registrations and agent definitions are read from it. The Roster repo
  cannot move to another base without breaking that anchor.
- **Compatibility.** `AGENTS.md` rule 4 and every Roster branch so far use `agent/<feature>-<task>`.
  No project is registered yet (`projects/` is empty; T24 writes the first registration), so the
  registration format can still change without a migration.

## Decision

Each project registration names its base branch and its agent branch prefix. Defaults reproduce
today's behavior exactly. Every agent branch name carries an agent marker, so the push guard can tell
it from a human branch. The Roster repo itself stays on `main` and `agent`.

### 1. Registration fields

`projects/<name>.json` (ADR 0018, protected by ADR 0025) gets two optional fields:

| Field | Default | Meaning | Validation |
| --- | --- | --- | --- |
| `baseBranch` | `main` | Source of every agent branch of the project, target of every PR, and the ref approved project intent is read from. | Plain branch name: 1 to 100 characters, `/`-separated segments matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `..`, no segment ending in `.` or `.lock`. Must not start with `agent/`, must not contain a segment starting with `agent-`, must not equal `branchPrefix`. |
| `branchPrefix` | `agent` | First segment of every agent branch of the project. | One lowercase segment `^[a-z][a-z0-9_-]{0,31}$`, not one of `main`, `master`, `develop`, `head`, `refs`, `origin`. |

The existing field `defaultBranch` (only value `main`) is removed from the format. A registration that
still has it is invalid, with a message that names `baseBranch`; silently ignoring it would let
`"defaultBranch": "develop"` look configured while Roster used `main`.

**The Roster repo is fixed.** The registration of the Roster repo (the one whose `repoPath` is the
Roster repo of `config.json`) is invalid unless it resolves to `baseBranch` `main` and `branchPrefix`
`agent`, written or defaulted. Pushes Roster makes to the Roster repo (hire branches, ADR 0027;
registration branches, plan 002 section 7.1) always use `main` and `agent`, even before the Roster
repo is registered. Reason: ADR 0025 decisions 3 and 4 read the pinned install, policies,
registrations and agents from `origin/main` of the Roster repo; a hire PR merged into any other branch
would never approve the agent. `AGENTS.md` rule 4 therefore stays true for the Roster repo.

### 2. Branch names

The agent namespace of a project is:

- `agent/` when `branchPrefix` is `agent` (the whole namespace belongs to Roster, as today);
- `<branchPrefix>/agent-` for any other prefix.

| Branch | Name | Default (`agent`) | Example (`feature`) |
| --- | --- | --- | --- |
| Task (and its WIP pushes, ADR 0028) | `<ns><NNN>-<Tnn>` | `agent/002-T01` | `feature/agent-002-T01` |
| Spec draft (plan 002 section 7.2) | `<ns><NNN>-spec` | `agent/014-spec` | `feature/agent-014-spec` |
| Plan (plan 002 section 7.2, T34) | `<ns><NNN>-plan` | `agent/014-plan` | `feature/agent-014-plan` |
| Hire, Roster repo only (ADR 0027) | `agent/hire-<slug>` | `agent/hire-analyst` | not applicable |
| Registration, Roster repo only (plan 002 section 7.1) | `agent/project-<name>` | `agent/project-web` | not applicable |

The part after the prefix is always exactly one segment. One function in `core/domain` builds these
names from the registration; nothing else formats an agent branch.

The human must not create branches inside a project's agent namespace. If a branch with an agent name
already exists on `origin`, Roster treats it as its own and resumes it (plan 002 section 8 step 1).

### 3. Push guard

`src/adapters/vcs/push-guard.ts` stays a protected path (ADR 0025) and keeps all of its current rules
(remote `origin`, fixed options, exactly one refspec `R:R` with the same source and destination, no
`+`, no force options, no delete, safe global options, the push-only credential helper). Changes:

1. **Bound rules.** The guard is created per workspace with the project's `{ baseBranch,
   branchPrefix }`: `createPushGuard(rules)` returns the frozen pair `pushArguments(branch)` and
   `assertSafePush(argv)`. It validates the rules itself at creation (the patterns and reserved names of
   section 1) and throws `PushRejectedError` on invalid rules. The git adapter receives the factory from
   the composition root and calls it once in `createWorkspace`, with the rules carried by the workspace
   source. A workspace cannot change its rules afterwards.
2. **Destination.** `R` must be `refs/heads/<branchPrefix>/<rest>`, with the bound prefix and `<rest>`
   one segment; when the prefix is not `agent`, `<rest>` must start with `agent-` and have at least one
   character after it.
3. **Never pushed, whatever the rules:** `refs/heads/main`, `refs/heads/master`, `refs/heads/develop`
   and `refs/heads/<baseBranch>`. The shape of rule 2 already excludes them; the explicit check stays
   as defense in depth and is tested.
4. **Self-contained.** The guard imports nothing from `core` except the error type. It re-implements
   its checks instead of calling the naming function of section 2 or the registration validator, so a
   change to those unprotected files cannot weaken it.

Where the rules come from, and why an agent cannot set them: Roster reads registrations only from
`origin/main` of the Roster repo (ADR 0018, 0025), never from a workspace; `projects/**` is a protected
path that only `roster project add` (a command the human runs) or a human PR changes; no registration,
store or config file is mounted in any container (ADR 0023). Whatever rules reach the guard, its
invariants hold: one marker branch, never `main`, `master`, `develop` or the base branch, never forced,
never deleted. The worst an unreviewed orchestrator bug can do is push a marker branch under another
valid prefix.

### 4. Base branch everywhere the project side used `main`

For a project, every former `main` / `origin/main` of the project repo becomes `baseBranch` /
`origin/<baseBranch>`:

- new agent branches start from `origin/<baseBranch>` (plan 002 section 8 step 1);
- PRs (task, spec, plan) target `baseBranch`;
- approved project intent (specs, plans, `tasks.md`, ADRs, the next free feature number) is read from
  `origin/<baseBranch>`; "approved" means merged into the base branch (amends ADR 0018 rule 1 for the
  project side, ADR 0019 import step 1, ADR 0020 import evidence);
- the protected-path and allowed-path check covers `origin/<baseBranch>..HEAD` (amends ADR 0025
  decision 2);
- the setup job installs when the dependency manifests equal `origin/<baseBranch>` or match an
  approved hash (amends ADR 0024 `install_dependencies`);
- the code review diff is `origin/<baseBranch>..HEAD`.

Unchanged: everything read from the Roster repo (pinned install, policies, protected paths,
registrations, agent definitions, skills registry) comes from `origin/main` of the Roster repo.

### 5. Protection check

`ForgePort.mainProtection(repo)` becomes `branchProtection(repo, branch)`, returning `missing` (the
branch does not exist), `unknown` (protection not readable with the token), or the two flags (PR
required, force push blocked). `roster doctor` and `roster project add` check the set {`baseBranch`,
`main`}: `main` is checked when it differs from the base branch and exists; a missing `main` is
reported, not failed (some projects use `master`). A missing base branch fails both commands. The
pass/fail rule per branch is the one plan 002 already applies to `main`. The optional Administration
read of ADR 0029 now serves this check for both branches.

## Considered options

- **A. Per-project `baseBranch` and `branchPrefix`, agent namespace (`agent/` or `<prefix>/agent-`),
  Roster repo fixed to `main`/`agent` (chosen):** gitflow works; defaults change nothing; the guard
  keeps a strict, rule-independent shape; two name forms instead of one.
- **B. One form for every project, `<prefix>/agent-<NNN>-<Tnn>` (the original proposal taken
  literally):** a single rule; with the default prefix it gives `agent/agent-002-T01`, which breaks
  `AGENTS.md` rule 4, the existing branches and every plan reference, for no safety gain, because the
  `agent/` namespace is already reserved for Roster.
- **C. A free branch-name template per project (`"branchTemplate": "feature/{feature}-{task}"`):**
  matches any convention; the guard can no longer tell agent branches from human ones, and the template
  becomes a small language to validate.
- **D. Prefix without marker (`feature/002-T01`):** matches the convention exactly; the guard would
  accept `feature/login`, and Roster would resume a human branch whose name happens to match.
- **E. Keep `main` and `agent/` fixed; the human retargets PRs by hand:** no change; branches from
  `main` miss `develop`, diffs are wrong, the range check sees unreleased `develop` commits, and every
  PR needs manual work.
- **F. Base and prefix in `config.json` (machine config):** no registration change; escapes PR review
  and the protected-path rule, against constitution principles 5 and 11.
- **G. Prefix per task (feature or fix by task kind):** closer to some conventions; needs a new
  `tasks.md` field (ADR 0019) and a classification rule. Deferred: one prefix per project until a real
  project needs more.
- **H. Let the Roster repo use any base:** uniform; breaks the `origin/main` trust anchor of ADR 0025
  and the hire gate of ADR 0027.

## Consequences

- Gitflow projects get branches from `develop`, PRs into `develop` and names such as
  `feature/agent-002-T01`. Projects with the defaults, and the Roster repo, see no change.
- The guard is no longer one constant: it is built per workspace from validated rules. Its tests must
  cover every reserved name, a human-looking branch under the prefix (`feature/login`), a branch under
  a different prefix, `agent/x` when the prefix is `feature`, two segments after the prefix, invalid
  rules at creation, and the unchanged force, `+`, delete and multi-refspec cases.
- Done tasks T09, T10 and T11 need follow-up work (tasks T42, T43, T44 of plan 002); T43 touches the
  protected guard and is `Needs human`.
- `tasks` rows store the full branch name, so `roster status` shows it unchanged; the `projects` store
  table needs no new column, because the run reads the registration loaded by the sync step.
- A human branch named exactly like the prefix (`feature`) makes pushes fail with a ref conflict. That
  is a safe failure: the task ends `failed` with GitHub's message.
- Branch protection on the base branch is now as important as on `main`: a leaked token can push only
  unprotected branches, and Roster's own guard pushes only marker branches.
- Constitution principle 5 and the definition of done name `main`. They stay true for the Roster repo,
  which is fixed to `main`; other projects follow their own constitution.
