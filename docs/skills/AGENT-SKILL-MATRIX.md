# Agent-skill matrix

- Date: 2026-10-30
- Status: proposal. Skill ids refer to `SKILLS-CATALOG.md`; "Build:" marks a skill Roster would write.
- Levels: **M** mandatory (always mounted for this agent), **R** recommended (mounted when the task's
  technologies match), **O** optional (mounted only when the task asks for it), **S** specialized
  (only for projects whose stack uses that technology).

Two notes before the table:

- These 14 agents are **roles for the projects Roster builds**. Roster's own spec 002 specialists
  (`roster-core-ts-engineer`, etc.) are separate and today use no skills.
- Overlapping skills are never both **M** for one agent (for example only one TDD skill, one UI precision
  family). The chosen one is listed; alternatives are in the catalog.

| Agent | Mandatory | Recommended | Optional | Specialized |
| --- | --- | --- | --- | --- |
| 1. Product Analyst | `mattpocock/grill-me` (or `grilling`) | `mattpocock/to-spec`, `addyosmani/idea-refine` | `addyosmani/interview-me` | — |
| 2. Software Architect | `addyosmani/documentation-and-adrs`, `addyosmani/spec-driven-development` | `mattpocock/domain-modeling`, `mattpocock/codebase-design`, `addyosmani/planning-and-task-breakdown`, `wshobson/architecture-patterns` | `wshobson/microservices-patterns`, `wshobson/cqrs-implementation`, Build: `c4-documentation` | Build: `nosql-data-modeling` (for data architecture of NoSQL projects) |
| 3. Frontend Engineer | `vercel-react-best-practices` (React projects) | `vercel-composition-patterns`, `wshobson/typescript-advanced-types`, `jakubkrehel/better-accessibility` | `wshobson/react-state-management`, `vercel/react-view-transitions` | `wshobson/nextjs-app-router-patterns`, `wshobson/tailwind-design-system` |
| 4. UI/UX Designer | `anthropics/frontend-design` | `jakubkrehel/better-ui`, `better-typography`, `better-layout`, `better-colors`, `better-accessibility` | `jakubkrehel/interface-review` (manual), `teardown` | `pbakaus/impeccable` (alternative toolkit, after script review); `ui-ux-pro-max` (P2, data reference) |
| 5. Backend Engineer | `wshobson/nodejs-backend-patterns` (Node projects) | `wshobson/api-design-principles`, `wshobson/error-handling-patterns`, `wshobson/auth-implementation-patterns`, `addyosmani/observability-and-instrumentation` | `addyosmani/performance-optimization` | Build: `nestjs-architecture`, `nestjs-testing`, `nestjs-security`; `fastapi/fastapi` (Python backends) |
| 6. Relational DB Engineer | `wshobson/postgresql-table-design` | `supabase-postgres-best-practices`, `wshobson/sql-optimization-patterns`, `wshobson/database-migration` | `awesome-copilot/postgresql-code-review` | `prisma/*` (Prisma), Build: `drizzle-orm` / `typeorm` (only the ORM used) |
| 7. NoSQL DB Engineer | Build: `nosql-data-modeling` (choose the model first) | — | — | `mongodb/mongodb-schema-design`, `mongodb-query-optimizer`; `firebase/firebase-firestore`, `firestore-rules-creation`, `firebase-security-rules-auditor`; `redis/redis-core`, `redis-connections`, `redis-security`; Build: `dynamodb-modeling`, `cassandra-modeling` |
| 8. Java Engineer | `awesome-copilot/java-springboot` | `rrezartprebreza/spring-boot-3/rest-api-conventions`, `hexagonal-architecture`, `problem-details-rfc9457`; `awesome-copilot/java-junit` | `awesome-copilot/java-testcontainers`, `java-hibernate-jpa` | `rrezartprebreza/oauth2-resource-server`, `flyway-migrations` |
| 9. Python / AI Engineer | `wshobson/python-type-safety`, `wshobson/python-testing-patterns` | `fastapi/fastapi`, `wshobson/python-project-structure`, `wshobson/python-packaging` | `wshobson/async-python-patterns`, `python-performance-optimization` | `wshobson/rag-implementation`, `llm-evaluation`, `ml-pipeline-workflow`; `anthropics/claude-api` |
| 10. DevOps Engineer | Build: `container-hardening` (from ADR 0023) | `awesome-copilot/multi-stage-dockerfile`, `wshobson/github-actions-templates`, `wshobson/secrets-management` | `addyosmani/ci-cd-and-automation`, `trailofbits/devcontainer-setup` | `hashicorp/*` (Terraform), vendor deploy skills |
| 11. QA Engineer | one TDD skill: `obra/test-driven-development` | `wshobson/javascript-testing-patterns`, `wshobson/e2e-testing-patterns` | `trailofbits/property-based-testing`, `mutation-testing` | `microsoft/playwright-cli` (T3), `wshobson/python-testing-patterns`, `awesome-copilot/java-junit` |
| 12. Security Engineer | `getsentry/security-review` | `addyosmani/security-and-hardening`, `wshobson/threat-mitigation-mapping`, Build: `owasp-top10-checklist` | `getsentry/gha-security-review`, `trailofbits/supply-chain-risk-auditor` | `trailofbits/semgrep`, `codeql` (T3); `firebase-security-rules-auditor` |
| 13. Code Reviewer | `getsentry/code-review` (or `addyosmani/code-review-and-quality`; pick one) | `getsentry/security-review`, `getsentry/find-bugs`, `obra/verification-before-completion` | `trailofbits/differential-review` | `jakubkrehel/interface-review` (UI diffs) |
| 14. Technical Writer | `addyosmani/documentation-and-adrs` | `wshobson/openapi-spec-generation`, `getsentry/document-api-endpoint` | `wshobson/changelog-automation`, `mattpocock/writing-for-agents` | Build: `c4-documentation`, `tsdoc-conventions` |

Cross-cutting for **every** agent (R): Roster's own SDD rules come from `AGENTS.md` and the constitution,
not from a skill. Process skills (`obra/systematic-debugging`, `obra/verification-before-completion`) are
R for engineers and the reviewer.

`hr-director` also gets `mattpocock/writing-for-agents` (R) when writing agent definitions.
