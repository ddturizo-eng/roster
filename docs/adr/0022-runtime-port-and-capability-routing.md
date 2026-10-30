# 0022. Runtime port inside a sandbox, and routing by capabilities

- Status: Proposed
- Date: 2026-10-30
- Deciders: architect (pending human)
- Extends: 0010

## Context

ADR 0010 put every harness behind one interface, chosen by name (`ROSTER_HARNESS`, default
`claude-code`), with quota detection inside each adapter and a fake for tests. Spec 002 keeps the
runtime as a parameter ("adding another runtime does not change the orchestration logic") but now
every run happens in a container (ADR 0023), and agents declare capabilities and preferred runtimes
instead of tool names (ADR 0021). Only Claude Code is implemented in this spec.

## Decision

ADR 0010's principles stand: one interface, adapters registered by name, a fake adapter for tests,
quota detection inside the adapter. This ADR changes how the interface fits the sandbox and adds a
router.

1. **Port.** A runtime adapter does not spawn anything. It describes and interprets a run:

   ```
   RuntimePort {
     name: string
     capabilities: Set<Capability>
     buildInvocation(job: RuntimeJob): ContainerInvocation   // image, argv, env names, files for /roster/in
     interpret(exit: ContainerExit, logPath: string): RuntimeOutcome
   }
   RuntimeOutcome = { kind: "completed" | "quota_exhausted" | "timeout" | "error" | "stopped", detail }
   ```

   `RuntimeJob` carries the parsed agent, the prompt, the job profile, limits and policy. The
   orchestrator passes the invocation to `SandboxPort.run` (Docker) and the exit back to `interpret`.
   Adapters live in `src/adapters/runtime/<name>/`.
2. **Router** (`core/router`, pure): given the agent's `runtimes` list, the runtimes enabled in
   `config.json`, each runtime's capabilities and `runtime_state` cooldowns, pick the first runtime
   that is enabled, offers every capability the agent requires, and is not cooling down. If none
   qualifies, the unit of work is skipped with a recorded reason.
3. **Override.** `ROSTER_HARNESS`, if set, restricts the router to that runtime; unknown names fail fast.

## Considered options

- **Describe/interpret adapter + separate sandbox port:** the container logic is written once and
  shared by every runtime; adapters are pure and easy to test.
- **Adapter that runs its own container (`run()` as in ADR 0010):** smaller interface; every adapter
  would duplicate the isolation code, which is the most security-sensitive part.
- **No router, one runtime per agent:** simpler; cannot fall back when a runtime is out of quota once
  a second runtime exists.

## Consequences

- Adding a runtime means a new adapter folder, a registry entry, and an image; the orchestrator and
  the sandbox do not change.
- The orchestrator is still tested with a fake runtime and a fake sandbox.
- With only `claude-code` enabled, quota exhaustion means no runtime is available until the cooldown
  ends (ADR 0028).
- Implementation order: the router is built after the walking skeleton (task T17 of spec 002). Until
  then the orchestrator uses `claude-code` directly and honors its cooldown, which is the same result
  with a single runtime.
