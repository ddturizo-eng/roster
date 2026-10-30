# Agent-skill architecture

- Date: 2026-10-30
- Status: proposal. Shows how skills fit into the spec 002 architecture (plan 002, ADRs 0021-0026)
  without changing its trust boundaries.

## 1. Components

```
                    git (reviewed intent)                          local store (progress)
 ┌───────────────────────────────────────────────┐        ┌──────────────────────────────┐
 │ agents/<slug>.md      skills/registry.json     │        │ executions: which skills were│
 │  (skills: [ids])      skills/sources/**        │        │ mounted (ids + commit)       │
 │                       skills/local/**          │        └──────────────▲───────────────┘
 └───────────────┬───────────────────┬───────────┘                       │
                 │                   │                                   │ record
                 ▼                   ▼                                   │
        ┌─────────────────┐   ┌──────────────────────┐                   │
        │ core/agents     │   │ core/skills (pure)   │                   │
        │ AgentDefinition │──►│ validate · select    │──── selected ─────┤
        └─────────────────┘   │ (agent ∩ task tech,  │     skill set     │
                              │  cap, tier ≤ policy) │                   │
                              └──────────┬───────────┘                   │
                                         │                               │
                                         ▼                               │
                              ┌──────────────────────┐                   │
                              │ RuntimePort adapter  │  places skills    │
                              │ claude-code / codex  │  where that       │
                              │ / api (later)        │  runtime looks    │
                              └──────────┬───────────┘                   │
                                         │ invocation (argv, mounts)     │
                                         ▼                               │
 ┌──────────────────────── SandboxPort (Docker, ADR 0023) ──────────────────────────────────┐
 │ job container (untrusted)                                                                 │
 │   /workspace                  work tree (project .claude/skills, .agents/skills masked)  │
 │   /home/agent/.claude/skills  selected skills, read-only      (Claude Code)              │
 │   /home/agent/.agents/skills  selected skills, read-only      (Codex, Gemini/Antigravity)│
 │   /etc/claude-code/managed-settings.json  disableSkillShellExecution, managed-only rules │
 │   network: proxy ─► provider API only                                                     │
 │   output: /roster/out/result.json  (lists skills the agent says it used)                 │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Flow for one task

1. The orchestrator picks the task and its agent (unchanged from plan 002).
2. `core/skills.select(agent.skills, task.technologies, policy)` returns the approved skills to mount,
   capped and filtered by tier. Pure function, tested with fixtures.
3. Validation: hashes, license, `skills-ref`, tier. Failure stops the run with a reason.
4. The runtime adapter adds read-only mounts for the selected skill folders at its runtime's
   user-level skills path, and masks project skill folders in the work tree copy.
5. Inside the container the runtime does its normal progressive disclosure: names and descriptions at
   start, full `SKILL.md` on activation, resources on demand.
6. Roster records the mounted skill ids and commits on the execution; the agent's `result.json` may
   list the ones it activated.

## 3. Provider independence

| Layer | Portable? | How |
| --- | --- | --- |
| Skill content (`SKILL.md`, references, assets) | Yes | Agent Skills spec; Roster never edits it |
| Spec frontmatter | Yes | Read by all supporting clients |
| Extension frontmatter (`context`, `hooks`, `allowed-tools`, `agents/openai.yaml`) | No | Ignored or neutralized by Roster policy; recorded in the sidecar as `extensionFields` |
| Discovery path | No | Runtime adapter maps it (`.claude/skills` vs `.agents/skills`) |
| Activation | No | Native in CLIs; for API runtimes Roster must emulate it |
| Scripts | Partly | Run in the same container regardless of runtime; tier rules apply |

**API runtimes (OpenAI or Anthropic APIs without a CLI)** have no skill loader [H for OpenAI; Anthropic's
Skills API accepts only spec fields per Claude Code docs]. An API adapter would need to: put names and
descriptions in the system prompt, expose a `read_skill(name)` tool that returns `SKILL.md` and files from
the mounted folder, and route script execution through Roster's own sandbox. This is a later spec; the
skill format does not change for it.

## 4. Decisions this needs (future ADRs)

1. Skill storage by provenance with a Roster sidecar and `registry.json` (replaces the table in ADR 0005).
2. Read-only skill mounts and masking of project skill folders (extends ADR 0023).
3. Managed settings add `disableSkillShellExecution: true`; spike to confirm skill `allowed-tools` and
   `hooks` are neutralized (extends ADR 0024 and T16).
4. `core/skills` selection rule and cap (extends ADR 0021).
5. Risk tiers and the license allowlist (from `SKILL-SECURITY-POLICY.md`).

## 5. Relation to visibility (dashboard)

Recording the mounted skills per execution feeds the same execution view the human asked for: which
agent is running, on which task, with which skills, doing what. See the note in the PR description
about adding live activity to spec 002 or to the dashboard spec.
