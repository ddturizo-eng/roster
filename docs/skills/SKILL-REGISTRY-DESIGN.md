# Skill registry design

- Date: 2026-10-30
- Status: proposal. Not implemented. It extends ADR 0005, ADR 0021 (AgentDefinition v2) and ADR 0018
  (persistence split). Each decision below marked **[D?]** needs an ADR before implementation.

## 1. Goals and non-goals

Goals: one canonical, reviewed copy of each skill; metadata Roster can filter on; pinning and integrity;
per-agent and per-task assignment; placement into any runtime without changing the skill.

Non-goals for the MVP: a remote marketplace, automatic updates, dependency resolution beyond a flat
list, a database table per skill attribute, semantic search.

## 2. Storage layout — organize by provenance, classify by metadata

The brief proposes a tree by category (`skills/frontend/react/...`). **[R] Do not encode the taxonomy
in folders.** Reasons:

- A skill belongs to several categories (`vercel-react-best-practices` is frontend *and* performance;
  `supabase-postgres-best-practices` is relational *and* security).
- The spec requires `name` to equal the directory name, and names must be unique where a runtime loads
  them; the source, not the category, is what keeps names unique.
- Updates are reviewed as a diff against the upstream commit; one folder per upstream source keeps that
  diff simple.

**[D?] Proposed layout** (in the Roster repo, reviewed in git as ADR 0018 requires):

```
skills/
  registry.json                 # index: one entry per skill (generated + hand-edited status)
  registry.md                   # human-readable view, generated from registry.json
  sources/
    jakubkrehel/                # one folder per upstream source
      better-typography/        # verbatim copy at the pinned commit
        SKILL.md
        ...
        roster.skill.json       # Roster sidecar metadata (never upstream)
    prisma/
      prisma-orm-setup/
  local/                        # skills written for Roster (the "Build" items)
    nosql-data-modeling/
    c4-documentation/
```

Categories, technologies and specializations live in the sidecar. Views by category (the tree in the
brief) are generated listings, not folders.

## 3. Metadata

### 3.1 Spec fields (kept untouched in `SKILL.md`)

`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` (agentskills.io spec).
Roster never edits the upstream `SKILL.md`; extension fields (Claude Code's `context`, `hooks`, etc.)
stay as they are and are handled by policy.

### 3.2 Roster sidecar `roster.skill.json`

```json
{
  "schema": 1,
  "id": "jakubkrehel/better-typography",
  "name": "better-typography",
  "title": "Better Typography",
  "category": ["ui-ux"],
  "specializations": ["typography", "visual-hierarchy"],
  "technologies": ["css", "html"],
  "source": {
    "repo": "https://github.com/jakubkrehel/skills",
    "path": "skills/better-typography",
    "commit": "<40-char sha>",
    "author": "Jakub Krehel",
    "license": "MIT",
    "licenseFile": "LICENSE"
  },
  "version": "upstream:<sha7>",
  "tier": "T0",
  "files": [{ "path": "SKILL.md", "sha256": "<hash>", "kind": "instructions" }],
  "scripts": [],
  "requires": { "skills": [], "binaries": [], "hosts": [], "mcp": [] },
  "extensionFields": ["disable-model-invocation"],
  "conflictsWith": ["pbakaus/impeccable"],
  "compatibility": { "claude-code": "native", "codex": "native", "api": "adapter" },
  "status": "approved",
  "review": { "by": "human", "pr": 0, "date": "2026-11-01", "notes": "" }
}
```

Field meanings that the brief asked for: ID (`id` = `<source>/<name>`, unique), name, description (from
`SKILL.md`), category, technologies, specialization, source repo, author, license, version, compatibility,
dependencies (`requires`), instructions (`SKILL.md`), resources (`files`), scripts, required permissions
(`tier` + `requires`).

### 3.3 Registry index `registry.json`

One object per skill with `id`, `status` (`proposed | approved | suspended | rejected`), `tier`,
`category`, `technologies`, `agents` (default assignment hints) and the sidecar path. `registry.md` is
generated from it. This replaces the hand-written table of ADR 0005 **[D?]**.

## 4. Versioning

- **Version = upstream commit SHA** plus the per-file SHA-256 list. Upstream `metadata.version` or
  Impeccable's `version:` is recorded but not trusted.
- One approved version per skill id at a time. An update is a PR that replaces the folder and shows the
  upstream diff (security policy section 5).
- Local skills (`skills/local/`) are versioned by Roster's own git history.

## 5. Dependencies

The spec has no dependency field. The sidecar `requires` lists:

| Key | Meaning | Effect |
| --- | --- | --- |
| `skills` | Other skill ids that must be assigned too | Assignment adds them or fails |
| `binaries` | Tools the skill expects in the container (`playwright`, `semgrep`) | Tier T3; the runtime image must provide them (image change = ADR) |
| `hosts` | Network hosts | Tier T3; never added to the egress allowlist automatically |
| `mcp` | MCP servers | Tier T3; MVP runs with `--strict-mcp-config` and no servers (T14) |

No transitive resolution in the MVP: `requires.skills` is one level deep and validated at approval time.

## 6. Compatibility

Compatibility is per runtime adapter, derived from the files, not declared by the author:

| Aspect | Claude Code [V] | Codex [V] | Gemini CLI / Antigravity [V/H] | Provider APIs (no CLI) |
| --- | --- | --- | --- | --- |
| Discovery path (user level) | `~/.claude/skills/<name>/` | `$HOME/.agents/skills/` | `~/.gemini/skills/` or `~/.agents/skills/` | none; Roster must inject |
| Spec fields | yes | `name`, `description` documented | name/description at startup | Roster implements |
| Extension fields | many (`context`, `hooks`, `allowed-tools`...) | `agents/openai.yaml` | Gemini-specific tiers and consent prompt | n/a |
| Scripts | yes | yes | yes | only through Roster's own tool layer |
| Activation | model-chosen or `/name` | implicit or `$name` | `activate_skill` tool with confirmation | Roster-driven |

[R] The sidecar `compatibility` map is computed: `native` when only spec fields are used, `degraded`
when extension fields would be ignored, `adapter` when Roster must emulate loading (API runtimes).

## 7. Assignment

Two levels, both deterministic:

1. **Agent definition** (ADR 0021 v2) lists `skills:` by id: the skills this agent may use. Only
   `approved` ids pass validation (as ADR 0005 already says for v1).
2. **Per task**, Roster selects the subset to mount: the intersection of the agent's skills with the
   task's technologies and areas (from `tasks.md` / project registry), capped (start at 8). No LLM picks
   skills in the MVP; the model only activates what is mounted, by description, as each runtime does.

`hr-director` writes the agent's list; the human approves it through the hire PR (ADR 0027).

## 8. Installation and placement

- "Installation" is vendoring into the repo through the intake PR. Nothing is installed on the machine.
- At run time, the runtime adapter copies or bind-mounts the selected skill folders **read-only** into
  the container at the runtime's user-level path (`/home/agent/.claude/skills/<name>` for Claude Code,
  `/home/agent/.agents/skills/<name>` for Codex). The work tree's own skill folders are masked (security
  policy section 4).
- The mount is part of the job's argument list built by `isolation.ts` (T15), so it is tested like every
  other mount. **[D?]** This adds one mount type to ADR 0023.

## 9. Validation

At approval and at every run start:

- `skills-ref validate` on the folder.
- SHA-256 of every file matches the sidecar.
- Tier recomputed from files equals the recorded tier.
- License on the allowlist.
- No `requires` entry that the current image or policy cannot satisfy.

A failure stops the run with a message in `human_language`; it never silently drops the skill.

## 10. Execution policy

Summarized from `SKILL-SECURITY-POLICY.md`: T0/T1 always allowed once approved; T2 allowed with no extra
network; T3 not in the MVP. Skills never widen the agent's permissions; `disableSkillShellExecution` is
set; project skills are masked.

## 11. Where this lands in the plan

- **Not in spec 002.** Spec 002 uses agent definitions without skills. This design belongs to a later
  spec ("skills registry"), after T24 proves the run path.
- Smallest useful slice for that spec: sidecar + `registry.json`, validation command, read-only mount
  for Claude Code, masking of project skills, and the P0 skills of `MVP-SKILLS-ROADMAP.md`.
