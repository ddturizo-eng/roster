# Skills roadmap

- Date: 2026-10-30
- Status: proposal. Nothing is approved; each skill goes through `SKILL-SECURITY-POLICY.md`.

Principle: adopt a skill when a real task needs it (constitution principle 12). The tiers below are an
order, not a commitment. Before P0, Roster needs the registry slice of `SKILL-REGISTRY-DESIGN.md`
section 11, which comes after spec 002's first real run (T24).

## P0 — essential (lifecycle agents of spec 002 and skill vetting)

Spec 002 adds an `analyst` and a `code-reviewer` at run time (T32), and Roster needs to vet skills.
All P0 skills are T0 (instructions only) except where noted.

| Skill | For | Why now |
| --- | --- | --- |
| `mattpocock/grill-me` (or `grilling`) | analyst | Spec 002 has a grilling stage; this is the closest existing procedure. Compare with T33's prompt before adopting. |
| `addyosmani/spec-driven-development`, `documentation-and-adrs` | architect, analyst | Check against Roster's own SDD rules; adopt only what adds to them. |
| `getsentry/code-review`, `getsentry/security-review` | code-reviewer | T36 review step. |
| `obra/verification-before-completion` | all engineers | Reinforces "verify before reporting done". |
| One TDD skill (`obra/test-driven-development`) | engineers, QA | Single choice to avoid conflicting rules. |
| `getsentry/skill-scanner` | Roster's intake | Second-opinion scan during skill review (run in sandbox, no network). Review its scripts first (T2). |

Effort: about 8 reviews, mostly short files.

## P1 — main specializations (depends on the stacks of your 1-2 apps)

Open question 4 of plan 002 (which toolchains your apps use) decides this list. Assuming a TypeScript
web app with React and PostgreSQL:

| Area | Skills |
| --- | --- |
| UI/UX | `anthropics/frontend-design`; `jakubkrehel/better-ui`, `better-typography`, `better-layout`, `better-colors`, `better-accessibility` |
| Frontend | `vercel-react-best-practices`, `vercel-composition-patterns` (after license confirmation), `wshobson/typescript-advanced-types` |
| Backend (Node) | `wshobson/nodejs-backend-patterns`, `api-design-principles`, `error-handling-patterns` |
| Relational | `wshobson/postgresql-table-design`, `sql-optimization-patterns`, `supabase-postgres-best-practices`; `prisma/*` if Prisma |
| QA | `wshobson/javascript-testing-patterns`, `e2e-testing-patterns` |
| Docs | `mattpocock/writing-for-agents` (for `hr-director`) |
| Build | `nestjs-*` only if NestJS is chosen; ORM skill for the ORM actually used |

## P2 — additional technologies

| Area | Skills |
| --- | --- |
| NoSQL | Build `nosql-data-modeling` first; then official `mongodb/*`, `firebase/*`, `redis/*` as projects need them |
| Java | `awesome-copilot/java-*`, `rrezartprebreza/spring-boot-3/*` |
| Python | `fastapi/fastapi`, `wshobson/python-*` |
| DevOps | `awesome-copilot/multi-stage-dockerfile`, `wshobson/github-actions-templates`; Build `container-hardening` |
| UI | `ui-ux-pro-max` (T2, data reference) and `pbakaus/impeccable` (T2/T3) after script review |
| Security | `wshobson/threat-mitigation-mapping`, `secrets-management`; Build `owasp-top10-checklist` |

## P3 — advanced

| Area | Skills | Blocker |
| --- | --- | --- |
| Static analysis | `trailofbits/semgrep`, `codeql`, `supply-chain-risk-auditor` | T3: tools in the image |
| Testing | `trailofbits/property-based-testing`, `mutation-testing`; `microsoft/playwright-cli` | T3: browser and tools in the image |
| AI engineering | `wshobson/rag-implementation`, `llm-evaluation`, `ml-pipeline-workflow` | Only for AI apps |
| Data | Build `dynamodb-modeling`, `cassandra-modeling` | No trustworthy source |
| Architecture | Build `c4-documentation` | No source found |
| IaC | `hashicorp/*` | Only if IaC is in scope |

## Skills to build (no trustworthy source found)

`nosql-data-modeling`, `c4-documentation`, `owasp-top10-checklist`, `container-hardening`,
`nestjs-architecture` / `nestjs-testing` / `nestjs-security` (if NestJS), `dynamodb-modeling`,
`cassandra-modeling`, ORM skills for Drizzle/TypeORM (if used). Each is a T0 skill written in
`skills/local/`, reviewed like any other, and kept short (< 500 lines, spec guidance).

## Excluded

- `exa-ronniejin/claude-code-skills`: inactive since 2026-01-14, one star, no adoption signal.
- Anthropic `docx`, `pdf`, `pptx`, `xlsx`: proprietary license.
- Vendor-specific skills (Neon, PlanetScale, Cloudflare, Azure, Elastic) unless an app uses that vendor.
