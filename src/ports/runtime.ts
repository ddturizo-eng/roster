// RuntimePort (ADR 0022, extends ADR 0010). A runtime adapter never spawns anything: it describes a
// container run and interprets its exit. The orchestrator passes the invocation to SandboxPort.run
// and the exit back to `interpret`. Adapters live in `src/adapters/runtime/<name>/`.

import type { Capability } from '../core/domain/agent.ts';
import type { ContainerExit, ContainerInvocation, RuntimeJob, RuntimeOutcome } from '../core/domain/runtime.ts';

export interface RuntimePort {
  /** Registry name, for example `claude-code`. */
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  /** Image, argv, environment names and the files for `/roster/in`. Pure. */
  buildInvocation(job: RuntimeJob): ContainerInvocation;
  /**
   * Reads the job's log at `logPath` and maps the exit to an outcome. Detects quota exhaustion and
   * returns the last rate-limit snapshot in `detail.rateLimit` for every outcome (ADR 0030).
   */
  interpret(exit: ContainerExit, logPath: string): RuntimeOutcome;
}
