// Fake RuntimePort: a describe/interpret adapter that completes every job unless a test scripts
// another outcome.

import type { Capability } from '../../src/core/domain/agent.ts';
import { CAPABILITIES } from '../../src/core/domain/agent.ts';
import type { ContainerExit, ContainerInvocation, RuntimeJob, RuntimeOutcome } from '../../src/core/domain/runtime.ts';
import type { RuntimePort } from '../../src/ports/runtime.ts';
import { CallLog, Responses } from './recorder.ts';

export interface FakeRuntimeOptions {
  readonly name?: string;
  readonly capabilities?: readonly Capability[];
}

export class FakeRuntime implements RuntimePort {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly log: CallLog;
  readonly responses = new Responses<RuntimePort>();

  constructor(options: FakeRuntimeOptions = {}, log: CallLog = new CallLog()) {
    this.name = options.name ?? 'fake-runtime';
    this.capabilities = new Set(options.capabilities ?? CAPABILITIES);
    this.log = log;
  }

  buildInvocation(job: RuntimeJob): ContainerInvocation {
    this.log.record('runtime', 'buildInvocation', [job]);
    return this.responses.answer('buildInvocation', [job], () => ({
      image: `roster/runtime-${this.name}:test`,
      argv: [this.name, '--max-turns', String(job.limits.maxTurns)],
      env: [],
      inFiles: [
        { name: 'prompt.md', content: job.prompt },
        { name: 'agent.md', content: job.agent.body },
      ],
      stdinFile: 'prompt.md',
    }));
  }

  interpret(exit: ContainerExit, logPath: string): RuntimeOutcome {
    this.log.record('runtime', 'interpret', [exit, logPath]);
    return this.responses.answer('interpret', [exit, logPath], (): RuntimeOutcome => ({ kind: 'completed', detail: {} }));
  }
}
