// Fake SandboxPort: every container exits 0 unless a test scripts another exit. Recorded run
// requests carry environment names only; their values are replaced by `[redacted]`.

import type { ContainerExit } from '../../src/core/domain/runtime.ts';
import type { SandboxAvailability, SandboxPort, SandboxRunRequest } from '../../src/ports/sandbox.ts';
import { FAKE_START_TIME } from './clock.ts';
import { CallLog, Responses } from './recorder.ts';
import { REDACTED } from './secrets.ts';

export class FakeSandbox implements SandboxPort {
  readonly log: CallLog;
  readonly responses = new Responses<SandboxPort>();

  constructor(log: CallLog = new CallLog()) {
    this.log = log;
  }

  async available(): Promise<SandboxAvailability> {
    this.log.record('sandbox', 'available', []);
    return this.responses.answer('available', [], (): SandboxAvailability => ({ available: true }));
  }

  async run(request: SandboxRunRequest): Promise<ContainerExit> {
    const envValues = Object.fromEntries(Object.keys(request.envValues).map((name) => [name, REDACTED]));
    this.log.record('sandbox', 'run', [{ ...request, envValues }]);
    return this.responses.answer('run', [request], () => ({
      exitCode: 0,
      timedOut: false,
      stopped: false,
      startedAt: FAKE_START_TIME,
      endedAt: FAKE_START_TIME,
    }));
  }

  async kill(executionId: string): Promise<void> {
    this.log.record('sandbox', 'kill', [executionId]);
    this.responses.answer('kill', [executionId], () => undefined);
  }
}
