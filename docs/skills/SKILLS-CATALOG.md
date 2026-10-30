# Skills catalog — research inventory

- Date: 2026-10-30
- Author: Claude (research), for human review
- Status: research only. Nothing is installed or approved. Approval follows ADR 0005 and
  `SKILL-SECURITY-POLICY.md`.

Legend: **[V]** verified on 2026-10-30 against the GitHub API or the source file; **[R]** recommendation;
**[H]** hypothesis, not verified. Stars and dates come from the GitHub API on 2026-10-30. "Scripts"
counts executable files (`.py .sh .js .mjs .cjs .ts .ps1`) under `skills/` or `scripts/` in the repo,
including CI helpers, so it is an upper bound on what a skill runs.

Priority uses the roadmap tiers (`MVP-SKILLS-ROADMAP.md`): P0 essential now, P1 main specializations,
P2 extra technologies, P3 advanced, **Build** = no trustworthy skill found, write our own,
**Exclude** = do not adopt.

## 1. Source repositories

| Repository | Owner type | License [V] | Last push [V] | Stars [V] | Skills [V] | Scripts [V] | Assessment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [agentskills/agentskills](https://github.com/agentskills/agentskills) | Standard (originated by Anthropic) | Apache-2.0 | 2026-08-09 | 26.8k | spec + `skills-ref` validator | — | The format itself. Use `skills-ref validate` in Roster's validation. |
| [anthropics/skills](https://github.com/anthropics/skills) | Official (Anthropic) | **Per skill**: e.g. `frontend-design` Apache-2.0; `docx`/`pdf`/`pptx`/`xlsx` proprietary "All rights reserved" | 2026-10-28 | 185k | 20 | 77 | Reference quality. Only Apache-2.0 skills are usable; document skills are excluded. |
| [openai/skills](https://github.com/openai/skills) | Official (OpenAI) | Per-skill `LICENSE.txt`, no repo license | 2026-10-28 | 28.4k | 44 | 62 | Mostly product integrations (Figma, Notion, Linear, deploy targets). `playwright`, `gh-fix-ci`, `gh-address-comments` are relevant; check each license. |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | Official (Vercel) | **No LICENSE file**; some SKILL.md say `license: MIT`, others none | 2026-10-28 | 33.3k | 9 | 91 | High-quality React/Next.js guidance. License per skill must be confirmed with Vercel before vendoring skills without a `license` field. |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Community (well-known author) | Apache-2.0 | 2026-10-30 | 96.9k | 1 umbrella skill (v4.8.0), copied into ~20 harness folders | 154 | Strong design vocabulary and audit workflow; heavy (live-browser scripts). |
| [jakubkrehel/skills](https://github.com/jakubkrehel/skills) | Community | MIT | 2026-10-25 | 9.3k | 14 | 19 (only `teardown` assets) | Small, precise, composable UI skills; mostly instruction-only. |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | Community | MIT | 2026-10-30 | 143k | 7 (+ CLI copies) | 130 | Searchable design database driven by scripts and data files; CLI installer. |
| [prisma/skills](https://github.com/prisma/skills) | Official (Prisma) | MIT | 2026-10-30 | 77 | 10 | 0 | Official, instruction-only. Low stars but first-party. |
| [mongodb/agent-skills](https://github.com/mongodb/agent-skills) | Official (MongoDB) | Apache-2.0 | 2026-10-30 | 192 | 8 unique (+ plugin copies) | 5 | Official; schema design, query optimizer, connection. Some skills target Atlas/MCP. |
| [redis/agent-skills](https://github.com/redis/agent-skills) | Official (Redis) | MIT | 2026-10-27 | 171 | 8 unique | 6 (CI) | Official; core, connections, clustering, security, observability, search, semantic cache. |
| [supabase/agent-skills](https://github.com/supabase/agent-skills) | Official (Supabase) | MIT | 2026-10-02 | 3.0k | 2 | 1 (build) | `supabase-postgres-best-practices` is useful for plain PostgreSQL too. |
| [firebase/agent-skills](https://github.com/firebase/agent-skills) | Official (Firebase) | Apache-2.0 | 2026-10-30 | 494 | 13 | 3 (tooling) | Official; Firestore, security rules creation and auditing. |
| [neondatabase/agent-skills](https://github.com/neondatabase/agent-skills) | Official (Neon) | Apache-2.0 | 2026-10-30 | 108 | 9 | — | Vendor-specific (Neon). Only if an app uses Neon. |
| [planetscale/skills](https://github.com/planetscale/skills) | Official (PlanetScale) | MIT | 2026-10-30 | 136 | 15 | — | Vendor-specific (PlanetScale MySQL/Postgres). Only if an app uses it. |
| [fastapi/fastapi](https://github.com/fastapi/fastapi) | Official (FastAPI) | MIT | 2026-10-30 | 104k | 1 (`fastapi`) | — | First-party FastAPI skill shipped in the framework repo. |
| [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) | Official (Microsoft) | Apache-2.0 | 2026-10-30 | 14.8k | 2 (`playwright-cli`, `playwright-triage`) | — | First-party Playwright skill; needs the CLI tool and a browser. |
| [microsoft/skills](https://github.com/microsoft/skills) | Official (Microsoft) | MIT | 2026-10-30 | 3.2k | 211 | — | Mostly Azure SDK skills. Not relevant unless an app uses Azure. |
| [github/awesome-copilot](https://github.com/github/awesome-copilot) | Official curation, community content | MIT | 2026-10-30 | 40.6k | 466 | — | Large, uneven. Useful Java (`java-springboot`, `java-junit`, `java-hibernate-jpa`, `java-testcontainers`), `multi-stage-dockerfile`, `postgresql-optimization`. Review one by one. |
| [trailofbits/skills](https://github.com/trailofbits/skills) | Security firm | **CC-BY-SA-4.0** | 2026-10-28 | 7.9k | 97 | 125 | Expert security content (Semgrep, CodeQL, supply chain, fuzzing, property-based testing). Share-alike license; many skills need external tools. |
| [getsentry/skills](https://github.com/getsentry/skills) | Company (Sentry) | Apache-2.0 | 2026-10-26 | 1.1k | 30 | 9 | `security-review`, `skill-scanner`, `code-review`, `find-bugs`, `gha-security-review` are relevant. |
| [hashicorp/agent-skills](https://github.com/hashicorp/agent-skills) | Official (HashiCorp) | MPL-2.0 | 2026-10-28 | 910 | — | — | Terraform/Vault. Only for IaC needs (P3). |
| [cloudflare/skills](https://github.com/cloudflare/skills) | Official (Cloudflare) | Apache-2.0 | 2026-10-30 | 3.2k | — | — | Vendor-specific. Only if deploying to Cloudflare. |
| [elastic/agent-skills](https://github.com/elastic/agent-skills) | Official (Elastic) | Apache-2.0 | 2026-10-29 | 603 | — | — | Vendor-specific. |
| [wshobson/agents](https://github.com/wshobson/agents) | Community, multi-harness marketplace | MIT | 2026-10-26 | 42.0k | 185 | 9 | Broad coverage (TS, Node, Python, Postgres, RAG, testing, CI). Quality varies; read each skill. |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | Community (well-known author) | MIT | 2026-10-29 | 112k | 25 | 16 (lint/tests) | Engineering-process skills: spec-driven development, ADRs, TDD, code review, security hardening. |
| [obra/superpowers](https://github.com/obra/superpowers) | Community | MIT | 2026-10-29 | 309k | 15 | 12 (tooling) | Process skills: brainstorming, plans, TDD, systematic debugging, verification before completion. Opinionated about subagents. |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Community (well-known author) | MIT | 2026-10-30 | 307k | 38 | 7 (tooling) | `grill-me`, `grilling`, `grill-with-docs`, `to-spec`, `tdd`, `domain-modeling`, `codebase-design`. |
| [rrezartprebreza/spring-boot-skills](https://github.com/rrezartprebreza/spring-boot-skills) | Community | MIT | 2026-10-29 | 333 | 66 | 5 (repo tooling) | Focused Spring Boot 3 skills, has its own evaluation script. Best Java candidate found. |
| [exa-ronniejin/claude-code-skills](https://github.com/exa-ronniejin/claude-code-skills) | Community, single maintainer | MIT | **2026-01-14** | **1** | many (AWS Java, JUnit, AI) | — | Starter kit, inactive for 9 months, no adoption signal. **Exclude** as a source; use as idea list only. |

Not found [V, GitHub search on 2026-10-30]: no official or well-maintained skill for **NestJS**, **Docker**
(official), **Drizzle**, **TypeORM**, **Sequelize**, **MySQL** (engine-generic), **DynamoDB**, **Cassandra**,
**C4 model** or **OWASP Top 10** as a standalone curated skill. Search results for these were repos with
0-11 stars.

## 2. Skill inventory by specialization

Columns: skill · source · description (short) · maintenance · compatibility · quality · priority.
Compatibility: **Spec** = only Agent Skills spec fields; **Spec+CC** = uses Claude Code extension fields
(ignored elsewhere); **Tool** = needs an external binary, browser, MCP server or network.
Quality is a first-pass reading of the SKILL.md header and size, not a full review.

### A. Frontend engineering

| Skill | Source | What it covers | Maint. | Compat. | Quality | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| `vercel-react-best-practices` | vercel-labs | React/Next.js performance rules (149 lines + rule files); `license: MIT` in frontmatter [V] | Active | Spec | High | P1 |
| `vercel-composition-patterns` | vercel-labs | Component architecture, compound components, React 19 API (`license: MIT`) [V] | Active | Spec | High | P1 |
| `react-view-transitions` | vercel-labs | View Transitions API in React | Active | Spec | — | P2 |
| `nextjs-app-router-patterns` | wshobson | Next.js App Router | Active | Spec | Unreviewed | P1 (if Next.js) |
| `react-state-management` | wshobson | State management options | Active | Spec | Unreviewed | P2 |
| `tailwind-design-system` | wshobson | Tailwind tokens and design system | Active | Spec | Unreviewed | P2 |
| `typescript-advanced-types` | wshobson | Advanced TS types | Active | Spec | Unreviewed | P1 |
| `modern-javascript-patterns` | wshobson | Modern JS | Active | Spec | Unreviewed | P3 |
| `frontend-ui-engineering` | addyosmani | Frontend engineering practices | Active | Spec | Unreviewed | P2 |
| Responsive design, API integration | — | No dedicated trustworthy skill found | — | — | — | Build (small, if needed) |

### B. UI/UX and interface design

The nine names in the brief map to **four** sources. They are not equivalent:

| Skill | Source | Nature | Scripts / risk | Overlaps with |
| --- | --- | --- | --- | --- |
| `frontend-design` | anthropics (Apache-2.0) [V] | Short (71 lines) aesthetic direction: pick a bold direction, typography, avoid templated "AI" look | None, instruction-only | Impeccable `shape`, UI UX Pro Max style picking |
| `impeccable` v4.8.0 | pbakaus (Apache-2.0) [V] | One umbrella skill with ~20 sub-commands (`shape`, `audit`, `critique`, `polish`, `typeset`, `colorize`, `layout`, `animate`, `harden`, `live`...). Design vocabulary plus review workflow | Many scripts, including live-browser DOM session scripts [V] — higher risk tier | Overlaps almost all of the jakubkrehel family and `frontend-design` |
| `better-ui`, `better-interface`, `better-typography`, `better-layout`, `better-colors`, `better-accessibility`, `better-writing`, `interface-review`, `teardown`, `variant`, `build-design`, `state-machine`, `break`, `explain-interface` | jakubkrehel (MIT) [V] | 14 small skills, each with exact values (radius, optical alignment, type scale, wrapping). `interface-review` is manual-only (`disable-model-invocation: true`) | Instruction-only except `teardown` (JS assets) | Each overlaps one Impeccable sub-command |
| `ui-ux-pro-max` (+ `design-system`, `ui-styling`, `brand`, `design`, `slides`, `banner-design`) | nextlevelbuilder (MIT) [V] | A design-knowledge database (styles, palettes, font pairings, UX rules) queried by scripts; ships a CLI installer | 130 script files, data files; needs Python/Node to query [V] | Overlaps Impeccable and `frontend-design` on direction and design systems |
| `web-design-guidelines` | vercel-labs | Reviews UI against Vercel's Web Interface Guidelines (39 lines). **No license field** [V]; [H] may fetch the guidelines from the network at run time | Check before use | Overlaps `interface-review`, Impeccable `audit` |
| `wcag-audit-patterns`, `accessibility-compliance`, `screen-reader-testing` | wshobson | Accessibility audits | Unreviewed | Overlaps `better-accessibility` |

[R] Do not assign overlapping UI skills to the same agent run: they give conflicting exact values. Pick
one *direction* skill (`frontend-design`) and one *precision* family (jakubkrehel), and keep Impeccable as
the alternative audit/critique toolkit once its scripts are reviewed. UI UX Pro Max is the most popular,
but its value is in its data and scripts, which raise the risk tier; P2.

### C. Backend engineering

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `nodejs-backend-patterns` | wshobson | Node backend patterns | P1 |
| `api-design-principles`, `openapi-spec-generation`, `error-handling-patterns`, `auth-implementation-patterns` | wshobson | REST design, OpenAPI, errors, auth (`api-design-principles` ships a Python template asset) | P1 |
| `api-and-interface-design`, `observability-and-instrumentation`, `performance-optimization`, `security-and-hardening` | addyosmani | Process-level guidance | P1 |
| NestJS architecture, testing, security | — | **None found** | **Build** `nestjs-*` skills if an app uses NestJS |
| Express | — | None found | Build if needed |
| WebSockets, OAuth2/JWT specifics | — | Only generic auth patterns found | Build or rely on `auth-implementation-patterns` |

### D. Relational databases

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `prisma-orm-setup`, `prisma-client-api`, `prisma-cli`, `prisma-database-setup`, `prisma-upgrade-v7` | prisma (official) | Instruction-only [V] | P1 (if Prisma) |
| `supabase-postgres-best-practices` | supabase (official) | Postgres schema, indexes, RLS | P1 |
| `postgresql-table-design`, `sql-optimization-patterns`, `database-migration` | wshobson | Design, query tuning, migrations | P1 |
| `postgresql-optimization`, `postgresql-code-review` | awesome-copilot | Postgres tuning and review | P2 |
| MySQL, Drizzle, TypeORM, Sequelize | — | Only vendor-specific (PlanetScale) or 0-star repos | **Build** per ORM actually used |

### E. NoSQL (kept separate from relational)

| Model | Skill | Source | Notes | Priority |
| --- | --- | --- | --- | --- |
| Document | `mongodb-schema-design`, `mongodb-query-optimizer`, `mongodb-connection` | mongodb (official) | Some skills assume Atlas or the MongoDB MCP server (`mongodb-mcp-setup`) | P2 |
| Document | `firebase-firestore`, `firestore-rules-creation`, `firebase-security-rules-auditor` | firebase (official) | Firestore modeling and security rules | P2 |
| Key-value / cache | `redis-core`, `redis-connections`, `redis-security`, `redis-clustering`, `redis-observability` | redis (official) | `redis-search` / `redis-semantic-cache` are vector/AI uses | P2 |
| Wide-column | Cassandra | none trustworthy (one 0-star repo) | — | **Build** |
| Cloud key-value/document | DynamoDB | none found (only Java SDK skills in an inactive repo) | — | **Build** |
| Cross-cutting | NoSQL data modeling, consistency and replication, partitioning | none found | — | **Build** `nosql-data-modeling` that forces the model choice first (document vs key-value vs wide-column) |

### F. Java

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| 66 Spring Boot 3 skills (`rest-api-conventions`, `hexagonal-architecture`, `oauth2-resource-server`, `flyway-migrations`, `problem-details-rfc9457`, `idempotency-patterns`...) | rrezartprebreza (MIT) | Focused, active, own evaluation script | P2 |
| `java-springboot`, `java-junit`, `java-hibernate-jpa`, `java-testcontainers`, `java-development` | awesome-copilot | GitHub-curated community content | P2 |
| AWS Java SDK, JUnit unit-test series | exa-ronniejin | Inactive, 1 star | Exclude |

### G. Python and AI engineering

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `fastapi` | fastapi (official) | First-party | P2 |
| `python-testing-patterns`, `python-type-safety`, `python-packaging`, `python-performance-optimization`, `async-python-patterns`, `python-project-structure` | wshobson | Broad Python set | P2 |
| `modern-python`, `property-based-testing` | trailofbits | Expert, CC-BY-SA | P3 |
| `rag-implementation`, `llm-evaluation`, `ml-pipeline-workflow` | wshobson | AI engineering | P3 |
| `claude-api` | anthropics (Apache-2.0) [V] | Claude API usage | P3 |
| Computer vision (OpenCV) | none trustworthy | — | Build if needed |

### H. Architecture and engineering practices (cross-cutting)

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `grill-me`, `grilling`, `grill-with-docs` | mattpocock | Grilling: question the plan before acting. Matches Roster's grilling stage | P0 |
| `to-spec`, `domain-modeling`, `codebase-design`, `improve-codebase-architecture` | mattpocock | Spec writing, DDD-style modeling | P1 |
| `spec-driven-development`, `documentation-and-adrs`, `planning-and-task-breakdown`, `incremental-implementation` | addyosmani | SDD, ADRs, task breakdown | P0 (compare with Roster's own SDD rules first) |
| `architecture-decision-records`, `architecture-patterns`, `microservices-patterns`, `cqrs-implementation`, `saga-orchestration` | wshobson | ADR and pattern references | P1/P3 |
| `brainstorming`, `writing-plans`, `systematic-debugging`, `verification-before-completion` | obra/superpowers | Process discipline | P0/P1 |
| C4 model documentation | none found | — | **Build** `c4-documentation` |
| Brownfield analysis | none dedicated | — | **Build** (Roster's architect already reads ADRs first) |

### I. QA

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `test-driven-development` | obra/superpowers, addyosmani, mattpocock (`tdd`) | Three overlapping TDD skills; pick one | P0 (one of them) |
| `playwright-cli`, `playwright-triage` | microsoft/playwright-cli (official) | Needs the Playwright CLI and a browser in the container | P1 (if web UI) |
| `webapp-testing` | anthropics (Apache-2.0) [V] | Playwright-based local app testing, ships scripts | P2 |
| `javascript-testing-patterns`, `e2e-testing-patterns`, `python-testing-patterns` | wshobson | Patterns | P1/P2 |
| `mutation-testing`, `coverage-analysis`, `property-based-testing` | trailofbits | Advanced | P3 |
| Vitest-specific, Testcontainers (Node) | none found | — | Build if needed |

### J. Security

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `security-review`, `find-bugs`, `gha-security-review`, `security-model` | getsentry | Practical review skills | P0 (code-reviewer) |
| `skill-scanner` | getsentry | Scans skills for risky content — useful **for Roster's own skill vetting** | P0 (tooling) |
| `security-and-hardening` | addyosmani | General hardening | P1 |
| `supply-chain-risk-auditor`, `semgrep`, `codeql`, `sharp-edges`, `differential-review`, `agentic-actions-auditor` | trailofbits | Expert; Semgrep/CodeQL need the tools installed | P3 |
| `secrets-management`, `threat-mitigation-mapping`, `security-requirement-extraction` | wshobson | Threat modeling and secrets | P2 |
| `agent-owasp-compliance`, `mcp-security-audit` | awesome-copilot | OWASP-oriented | P2 |
| OWASP Top 10 / API Top 10 as a curated checklist | none trustworthy | — | **Build** from OWASP's own documents (CC-BY-SA) |

### K. DevOps

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `github-actions-templates`, `deployment-pipeline-design`, `git-advanced-workflows`, `secrets-management` | wshobson | CI/CD and git | P2 |
| `multi-stage-dockerfile` | awesome-copilot | Dockerfile practice | P2 |
| `ci-cd-and-automation`, `git-workflow-and-versioning` | addyosmani | Process | P2 |
| `devcontainer-setup` | trailofbits | Dev containers | P3 |
| Docker hardening (non-root, read-only, egress) | none official | Roster's own ADR 0023 is stricter than anything found | **Build** from ADR 0023 |
| Terraform / IaC | hashicorp (official, MPL-2.0) | Only if IaC is in scope | P3 |

### L. Technical writing

| Skill | Source | Notes | Priority |
| --- | --- | --- | --- |
| `documentation-and-adrs` | addyosmani | ADRs and docs | P1 |
| `openapi-spec-generation`, `changelog-automation` | wshobson | OpenAPI, changelogs | P2 |
| `document-api-endpoint`, `pr-writer`, `agents-md` | getsentry | API docs, PR text, AGENTS.md | P2 |
| `writing-for-agents` | mattpocock | Writing instructions for agents | P1 (for `hr-director` and agent definitions) |
| TSDoc, README generation | none dedicated | — | Build small if needed |

## 3. Findings that affect Roster's design

1. **[V] The format is portable; the extensions are not.** The spec defines only `name`, `description`,
   `license`, `compatibility`, `metadata` and experimental `allowed-tools`. Claude Code adds
   `disable-model-invocation`, `context: fork`, `hooks`, `model`, `paths`, `shell` and more, and other
   clients ignore them. Codex adds an optional `agents/openai.yaml`.
2. **[V] Claude Code skills can run shell commands before the model sees them** (`` !`cmd` `` and
   ```` ```! ```` blocks). The managed setting `disableSkillShellExecution: true` replaces them with a
   placeholder. Roster's managed settings (T16) should set it.
3. **[V] A skill's `allowed-tools` pre-approves tools "even in a `-p` run in an untrusted folder"**, and
   skills can declare `hooks`. [H] Roster's `allowManagedPermissionRulesOnly` and
   `allowManagedHooksOnly` should neutralize both; this must be tested like spike T14 did for settings.
4. **[V] Project skills load from the work tree** (`.claude/skills/` in Claude Code, `.agents/skills/` in
   Codex and Gemini CLI). A target repository can therefore inject skills into a Roster run. This is a
   prompt-injection path that Roster must control (see the security policy).
5. **[V] The ecosystem distributes the same skill in many harness folders** (Impeccable ships ~20 copies).
   Roster should store one canonical copy and let each runtime adapter place it where that runtime looks.
6. **[V] Licenses are not uniform even inside one official repo.** Anthropic's document skills are
   proprietary; Vercel's repo has no LICENSE file. License is checked per skill, not per repo.
7. **[V] Gemini CLI's documentation states it was replaced by Antigravity CLI on 2026-06-18.** [H] The
   `.agents/skills` convention likely carries over; verify before writing a Gemini/Antigravity adapter.

## 4. References

- Agent Skills specification: https://agentskills.io/specification and https://agentskills.io/
- Claude Code skills: https://code.claude.com/docs/en/skills
- Codex skills: https://learn.chatgpt.com/docs/build-skills
- Gemini CLI skills: https://geminicli.com/docs/cli/skills/
- Repositories: links in section 1 (metadata from `gh api repos/<owner>/<repo>` and the git tree API,
  2026-10-30).
