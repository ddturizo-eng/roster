// Claude Code runtime adapter (RuntimePort, ADR 0022). It never spawns anything: `buildInvocation`
// describes the container run (invocation.ts, managed-settings.ts) and `interpret` maps the exit and
// the job's `stream-json` log to an outcome (interpret.ts, rate-limit.ts).

import { CAPABILITIES } from '../../../core/domain/agent.ts';
import type { Capability } from '../../../core/domain/agent.ts';
import type { ContainerExit, ContainerInvocation, RuntimeJob, RuntimeOutcome } from '../../../core/domain/runtime.ts';
import type { RuntimePort } from '../../../ports/runtime.ts';
import { RuntimeInputError } from './errors.ts';
import { interpretJob } from './interpret.ts';
import { RUNTIME_NAME, buildClaudeInvocation, checkRuntimeImage } from './invocation.ts';

export interface ClaudeCodeRuntimeOptions {
  /** `roster/runtime-claude:<roster-commit>`, built by the pinned install. */
  readonly image: string;
  /**
   * Operation classes of the policy read from `origin/main` (`Policy.operations` of `core/policy`).
   * They gate the allow rules of the managed settings.
   */
  readonly operations: Readonly<Record<string, string>>;
}

export class ClaudeCodeRuntime implements RuntimePort {
  readonly name = RUNTIME_NAME;
  readonly capabilities: ReadonlySet<Capability> = new Set(CAPABILITIES);
  readonly #image: string;
  readonly #operations: Readonly<Record<string, string>>;

  constructor(options: ClaudeCodeRuntimeOptions) {
    this.#image = checkRuntimeImage(options.image);
    if (typeof options.operations !== 'object' || options.operations === null) {
      throw new RuntimeInputError('policy operations', 'must be an object');
    }
    this.#operations = { ...options.operations };
  }

  buildInvocation(job: RuntimeJob): ContainerInvocation {
    return buildClaudeInvocation(job, { image: this.#image, operations: this.#operations });
  }

  interpret(exit: ContainerExit, logPath: string): RuntimeOutcome {
    return interpretJob(exit, logPath);
  }
}

/** Builds the RuntimePort. The composition root passes the runtime image and the policy. */
export function createClaudeCodeRuntime(options: ClaudeCodeRuntimeOptions): ClaudeCodeRuntime {
  return new ClaudeCodeRuntime(options);
}
