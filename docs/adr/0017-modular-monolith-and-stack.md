# 0017. Modular monolith on Node 24 with ports and adapters; SQLite through `node:sqlite`

- Status: Accepted (2026-10-30, PR #3 merged)
- Date: 2026-10-30
- Deciders: architect, human
- Amends: 0008 (code location only; the rest of 0008 stands)

## Context

ADR 0008 chose deterministic TypeScript on Node 24 with native type stripping, no build step,
`tsc --noEmit`, Vitest and no runtime dependencies beyond Node built-ins, with the code in
`dispatcher/`. Spec 002 grows the program into Roster's core: CLI now, a web dashboard later over the
same core, several adapters (runtime, sandbox, git, GitHub, store, secrets, scheduler), and a local
store. Constitution principle 12 forbids microservices and abstractions without a current use case.
The vision proposed NestJS, Prisma and Next.js as candidate stack items and challenged them.

## Decision

1. **One package, one process.** The `roster` package lives at the root of the Roster repo
   (`package.json`, `src/`, `test/`), replacing the `dispatcher/` folder named in ADR 0008. Layers:
   `core` (pure), `ports` (interfaces), `adapters`, `cli` (composition root). Dependencies point one
   way: `cli -> adapters -> ports -> core/domain`, and `core` imports only `core` and `ports`. A test
   fails the build on any violation. Every port has a fake for tests.
2. **Stack.** Everything in ADR 0008 stands: Node.js 24 LTS, TypeScript run through type stripping
   (erasable syntax only), `tsc --noEmit`, Vitest, no build step, no runtime dependencies. Data files
   that Roster parses (project registrations, policies) are JSON; agent frontmatter is a flat subset
   parsed by hand (ADR 0021).
3. **Store engine.** SQLite through the built-in `node:sqlite` module (stability 1.2, release
   candidate since Node v24.15.0, no flag needed), behind `StorePort`.
4. **Not now:** NestJS, Prisma, Next.js, an ORM, a DI container, a workflow engine.

## Considered options

- **`node:sqlite`:** built-in, keeps zero runtime dependencies, no native build on Windows;
  release-candidate stability, API may still change, possible warning output (hypothesis H1).
- **`better-sqlite3`:** mature, fast, synchronous API; native addon that needs prebuilt binaries for
  Node 24 on Windows or Visual Studio build tools, and breaks the zero-dependency rule of ADR 0008.
  Kept as the fallback behind the same port if H1 fails.
- **JSON files as the store:** zero dependencies; no transactions, no queries, fragile under crashes.
- **NestJS:** modules and DI out of the box; heavy runtime and decorators (not erasable syntax) for a
  single-user CLI with a handful of commands.
- **Prisma:** typed schema and migrations; a code-generation step and a native engine, against the
  no-build rule.
- **Next.js:** only useful once the dashboard exists; that is a later spec, which can serve a UI from
  the same process over a local HTTP API.

## Consequences

- One `npm ci` and one test command for the whole program; the dashboard can reuse `core` unchanged.
- Hand-written validators and a minimal frontmatter parser are needed instead of libraries.
- Code installed under `node_modules` cannot run with type stripping, so Roster is installed as a
  plain directory (ADR 0025).
- If `node:sqlite` proves unstable, switching to `better-sqlite3` needs a new ADR that also amends the
  zero-dependency rule.
