# Roster — vision and architecture analysis

- Date: 2026-10-30
- Author: human (vision) + Claude (analysis)
- Status: vision agreed; the architecture below is a proposal until its ADRs are accepted

This document records the foundational vision of Roster, the critical analysis made on 2026-10-30,
and the human's answers to it. It is the input for spec 002 and for the ADRs that follow.
Every statement is tagged as **confirmed**, **proposal**, **hypothesis** or **risk** (section 9).

## 1. What Roster is

A personal software-engineering platform run by specialized autonomous agents. From an idea, Roster
analyzes the need, writes a spec, proposes an architecture, records decisions, breaks the work into
tasks with dependencies, assigns them to specialists, executes them, verifies the results with tests
and reviews, and keeps the project's documentation and context. The human intervenes at the important
decisions.

It is not a chatbot that generates code. It coordinates an engineering process end to end.

## 2. Scope and philosophy (confirmed)

- Personal-first, single-user, local-first. Not a SaaS, no multi-tenancy.
- Runs mainly on the human's machine (Windows 11, Docker Desktop available).
- Interfaces: CLI first, then a tailored web dashboard. Both use the same core.
- Modular, no premature microservices, no abstraction without a current use case.
- Configurable autonomy with human supervision. Security never relies only on agent instructions.
- Provider independence. The first runtime is Claude Code on the human's Claude Pro subscription,
  through its official login. No credential extraction, no session reuse outside what the provider allows.
- Roster takes part in its own development, under Git, branches, tests, reviews and human approval.
  Roster never changes its own security, permissions or approval policies unattended.

## 3. Decisions taken on 2026-10-30 (confirmed by the human)

1. **Local execution.** Runs happen on the human's PC, including unattended night runs (the PC stays
   on). This replaces the GitHub Actions direction of ADR 0006 and spec 001.
2. **No Linear.** Roster has its own store and its own UI, for independence. This replaces ADR 0001 /
   0011 and constitution principle 2 (see ADR 0014).
3. **Container isolation.** Agent executions run in Docker containers.
4. **Prior decisions can be superseded** when the new direction needs it, always with the human's
   permission.
5. **Bootstrap tracking.** Until Roster's store exists, work status is `specs/<feature>/tasks.md` plus
   PRs (ADR 0014).

The human also mentioned cloud credits offered by Claude. It is unknown whether they are a one-time
promotion. Cloud sessions run on the provider's infrastructure, not locally, so they are at most a
future optional runtime and not a basis for the architecture.

## 4. Critical analysis of the original vision

### 4.1 Points that needed definition

1. **"Tool Gateway" vs agentic CLIs (proposal).** Claude Code, Codex CLI and Gemini CLI run their own
   tools; Roster cannot proxy every call. Two options:
   - Own agent loop over provider APIs: full control, but API billing, against the subscription choice.
   - Agentic CLI with enforcement outside the prompt: allow/deny tool flags, a settings file kept
     **outside** the workspace (`--settings`), `PreToolUse` hooks, container isolation, and the
     orchestrator performing every irreversible side effect (ADR 0009).

   Proposal: the second option. The Tool Gateway becomes **Policy Enforcement**: it configures the
   runtime and the sandbox instead of proxying tools.
2. **Provider / Model / Runtime / Auth are coupled in subscription CLIs (proposal).** Claude Code only
   runs Claude and manages its own login. Keep the separation as a concept; the real code seam is the
   **Runtime** adapter (ADR 0010). An Authentication Profile is "which CLI login / config directory"
   (for example `CLAUDE_CONFIG_DIR`). Roster never reads token files.
3. **"An agent is not a saved prompt" (proposal).** At run time an agent is prompt + tools + skills +
   model + contract. What makes it more than a prompt is the **structured output contract** and the
   **external evaluation**: tests and acceptance checks run by the orchestrator, not by the agent.
4. **Autonomy per project × agent × operation is too many dimensions (proposal).** Use a policy per
   **operation class** (read, write in workspace, run commands, install dependencies, delete, migrate,
   push, deploy). The project sets the maximum; an agent definition can only restrict it. L0-L3 are
   presets over that table.
5. **How agents collaborate (proposal).** Only through artifacts: spec, plan, ADRs, code in the repo,
   and notes on the task. No agent-to-agent chat. This keeps traceability and reproducibility.
6. **"Persistent memory" (proposal).** For the MVP, memory is the versioned project documents
   (`AGENTS.md`, specs, ADRs, docs) plus the execution log. No vector store.
7. **Self-development vs self-protection (proposal).** The agent edits the same repo that holds the
   policies. Needed: protected paths that the push guard refuses (policies, hooks, guards, runtime
   settings, the constitution), and an orchestrator that runs a pinned version installed from `main`,
   never the working branch.
8. **LLM planner vs deterministic orchestrator (proposal).** The LLM proposes the task DAG
   (`tasks.md`), the human approves it, a deterministic engine executes it. Agents never edit the DAG;
   they can only propose new tasks.
9. **Grilling and C4 (proposal).** Grilling is a lifecycle stage: the agent writes questions, the human
   answers, then the work moves on. C4 is documentation in `docs/architecture/`. Neither needs a
   dedicated feature in the MVP.

### 4.2 Control Plane vs Execution Plane

Worth keeping as a **code and trust boundary**, not as a process boundary (proposal).

- **Control Plane (trusted):** state, task DAG, policies, approvals, irreversible side effects
  (commit, push, PR).
- **Execution Plane (untrusted):** one isolated container per execution running the agentic runtime.
  Code, tasks, dependencies and web content can carry prompt injection.
- **Rule:** nothing in the Execution Plane writes Control Plane state. The agent returns a structured
  result; the Control Plane validates it and decides.
- Both run on the same machine. The store, policies and credentials are never inside the workspace.

## 5. Proposed logical architecture (proposal)

A TypeScript modular monolith with one-way dependencies:

```
presentation/   cli (MVP) · web (later, over a local HTTP API)
core/           domain · lifecycle · task-dag · orchestrator · policy · agent-registry · context
ports/          RuntimePort · VcsPort · StorePort · SandboxPort
adapters/       claude-code (later codex, gemini, ollama) · git+gh · sqlite · docker
```

- `core` has no external dependencies and is tested with fakes (ADR 0008).
- Stack hypothesis challenged: NestJS is overhead for a single-user CLI; Prisma adds a build step and
  conflicts with ADR 0008; Next.js only matters once the dashboard exists. Proposal: Node 24 with
  native type stripping, SQLite (`node:sqlite` or `better-sqlite3`), Vitest. Dashboard later: Vite +
  React + shadcn/ui served by the same process.

## 6. Domain entities (proposal)

| Entity | Lives in | Why |
| --- | --- | --- |
| Project (repo, stack, policy) | git (`projects/<app>.yml` in Roster) | Reviewed by the human |
| Spec, Plan, Decision (ADR) | git, in the project repo | Versioned, reviewed through PRs |
| AgentDefinition, Skill, Policy | git, in Roster | Approved by the human (ADR 0012) |
| Task (node) + Dependency (edge) | `tasks.md` (git) imported into the store | Plan reviewed in git, status in the store |
| Execution (one attempt at a task) | local store | Operational state |
| ExecutionEvent (log) | local store + log file | Traceability |
| ApprovalRequest | local store | Human gate |
| RuntimeProfile (runtime + auth + limits) | local config, outside git | Machine-specific |
| Artifact (PR, commit, file, note) | reference in the store | Links an execution to its outcome |

Principle: what is reviewed lives in git; what is operational lives in the store.

## 7. Agents, runtimes and orchestration (proposal)

- **AgentDefinition v2** (neutral markdown + frontmatter, extends `agents/*.md`): role, instructions,
  approved skills, required capabilities (`edit`, `shell`, `web`) instead of tool names, maximum
  autonomy, preferred runtimes in order, input/output contract, evaluation criteria.
- **Runtime adapters** translate the definition into each CLI's native format and flags.
- **Router:** first preferred runtime that has the required capabilities and quota. On quota
  exhaustion, ADR 0013 applies or the next runtime is used.
- **Output contract:** the agent writes a `result.json` (status, summary, verification, questions)
  validated against a schema; the orchestrator then runs its own checks.
- **Two levels of orchestration:**
  1. Feature lifecycle: a state machine with human gates — idea, analysis, grilling, spec approved,
     architecture and ADRs, plan approved, execution, delivery.
  2. Task DAG inside an approved plan: cycle detection on import; a task is ready when its
     dependencies are **merged**; statuses and retries.
- **Concurrency 1 in the MVP:** quota, merge conflicts and the human's review capacity are the limit.
  The DAG orders work; it does not parallelize it yet. No workflow engine (Temporal or similar).
- **Replanning:** the DAG is versioned; changes go through the architect or project manager and the
  human.

## 8. Security and local-execution risks

| Risk | Mitigation (proposal) |
| --- | --- |
| Agent with a shell reaches `~/.ssh`, browser data, other repos, env vars | Container per execution; only the task worktree is mounted; sanitized env |
| Prompt injection from code, tasks, dependencies, web | Treat all as untrusted; orchestrator owns irreversible effects; restricted network egress |
| Runtime credentials inside the container (the agent can read them) | Egress allowlist (provider API only); short-lived or scoped token where possible; open question in spec 002 |
| Supply chain (`postinstall` scripts) | Installing dependencies needs approval; evaluate `--ignore-scripts` |
| Secret exfiltration | No secrets in the workspace; no GitHub token in the container (push happens outside) |
| Self-modification of policies | Protected paths, pinned orchestrator, mandatory human PR |
| Destructive git | Push guard, no force push, protected `main` |
| Runaway loops and quota burn | Max turns, timeout, per-execution budget, ADR 0013 |
| Approval fatigue | Approve whole plans in one step, not each operation |
| Windows specifics | Docker Desktop must be running for night runs; WSL2 backend |

## 9. Classification

- **Confirmed:** personal, single-user, local-first; Claude Code on the Pro subscription as first
  runtime; SDD + ADRs; human approval at gates; agents defined as files; no SaaS, no microservices;
  CLI + web UI; local execution; no Linear, own store and UI; Docker isolation; bootstrap tracking in
  `tasks.md` + PRs.
- **Proposals:** Policy Enforcement instead of a Tool Gateway; autonomy per operation class;
  collaboration only through artifacts; two-level orchestration; protected paths and pinned
  orchestrator; stack without NestJS or Prisma; reuse of the spec 001 core design.
- **Hypotheses to validate:** provider terms for unattended, scheduled use of a subscription CLI;
  whether the Claude Pro quota is enough; `node:sqlite` maturity; running Claude Code headless inside
  a container on Windows.
- **Risks:** section 8.

## 10. Decisions that need an ADR

1. Task and execution store; bootstrap tracking — ADR 0014 (supersedes 0011, and 0001 through it).
2. Local runner and trigger (supersedes 0006).
3. Subscription authentication in local and in-container runs; provider terms check (revisits 0007).
4. Runtime routing by capabilities (extends 0010).
5. AgentDefinition v2 schema.
6. Autonomy model and enforcement points.
7. Container isolation boundary (Docker, mounts, network, credentials).
8. Persistence split between git and the store.
9. Self-modification protection (protected paths, pinned orchestrator).
10. Feature lifecycle state machine and task DAG.
11. Modular monolith and stack.
12. Later: dashboard technology and memory strategy.

ADRs 0008, 0009, 0010, 0012 and 0013 are expected to survive, possibly amended. 0006, 0007 and 0011
are expected to be superseded.

## 11. Phases

- **Spec 001 (single-repo dispatcher on GitHub Actions + Linear):** superseded by spec 002. Its core
  design (selection, harness adapter, push guard, hiring step, orchestrator, CLI) is reused.
- **Spec 002 — local core MVP:** the end-to-end path from idea to reviewed PR, from the CLI.
- **Later, each with its own spec:** web dashboard, more runtimes, parallel tasks, richer memory,
  multi-repo hardening.
