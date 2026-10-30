// Fake ConsolePort: keeps printed lines; input methods answer only what a test scripted.

import type { ConsolePort } from '../../src/ports/console.ts';
import { CallLog, Responses } from './recorder.ts';

export class FakeConsole implements ConsolePort {
  readonly log: CallLog;
  readonly responses = new Responses<ConsolePort>();
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  constructor(log: CallLog = new CallLog()) {
    this.log = log;
  }

  print(line: string): void {
    this.log.record('console', 'print', [line]);
    this.responses.answer('print', [line], () => {
      this.stdout.push(line);
    });
  }

  printError(line: string): void {
    this.log.record('console', 'printError', [line]);
    this.responses.answer('printError', [line], () => {
      this.stderr.push(line);
    });
  }

  async ask(question: string): Promise<string> {
    this.log.record('console', 'ask', [question]);
    return this.responses.answer('ask', [question], () => {
      throw new Error('FakeConsole: no answer scripted for ask');
    });
  }

  async readSecret(prompt: string): Promise<string> {
    this.log.record('console', 'readSecret', [prompt]);
    return this.responses.answer('readSecret', [prompt], () => {
      throw new Error('FakeConsole: no answer scripted for readSecret');
    });
  }

  async readInput(): Promise<string> {
    this.log.record('console', 'readInput', []);
    return this.responses.answer('readInput', [], () => {
      throw new Error('FakeConsole: no answer scripted for readInput');
    });
  }
}
