// ConsolePort over the process terminal (plan 002 section 4.3). `readSecret` never echoes: on a TTY
// the input is read in raw mode and nothing is written back; on a pipe it reads the first line.

import { createInterface } from 'node:readline';
import type { ConsolePort } from '../../../ports/console.ts';

export interface TtyReadable extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface TtyConsoleOptions {
  readonly input?: TtyReadable;
  readonly output?: NodeJS.WritableStream;
  readonly errorOutput?: NodeJS.WritableStream;
}

export class TtyConsole implements ConsolePort {
  readonly #input: TtyReadable;
  readonly #output: NodeJS.WritableStream;
  readonly #errorOutput: NodeJS.WritableStream;

  constructor(options: TtyConsoleOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#errorOutput = options.errorOutput ?? process.stderr;
  }

  print(line: string): void {
    this.#output.write(`${line}\n`);
  }

  printError(line: string): void {
    this.#errorOutput.write(`${line}\n`);
  }

  ask(question: string): Promise<string> {
    const rl = createInterface({ input: this.#input, output: this.#output, terminal: false });
    return new Promise((resolve, reject) => {
      let answered = false;
      rl.once('close', () => {
        if (!answered) reject(new Error('Input closed before an answer was given'));
      });
      rl.question(`${question} `, (answer) => {
        answered = true;
        rl.close();
        resolve(answer);
      });
    });
  }

  readSecret(prompt: string): Promise<string> {
    this.#output.write(`${prompt} `);
    const input = this.#input;
    const raw = input.isTTY === true && typeof input.setRawMode === 'function';
    return new Promise((resolve, reject) => {
      let value = '';
      const finish = (error?: Error): void => {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('error', onError);
        if (raw) input.setRawMode?.(false);
        input.pause();
        this.#output.write('\n');
        if (error === undefined) resolve(value);
        else reject(error);
      };
      const onData = (chunk: Buffer | string): void => {
        for (const ch of chunk.toString()) {
          if (ch === '\r' || ch === '\n') return finish();
          if (raw && ch === '\u0003') return finish(new Error('Input cancelled'));
          if (raw && (ch === '\b' || ch === '\u007f')) value = value.slice(0, -1);
          else if (ch >= ' ') value += ch;
        }
      };
      const onEnd = (): void => finish();
      const onError = (error: Error): void => finish(error);
      if (raw) input.setRawMode?.(true);
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', onError);
      input.resume();
    });
  }

  readInput(): Promise<string> {
    const input = this.#input;
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      input.setEncoding?.('utf8');
      input.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()));
      input.on('end', () => resolve(chunks.join('')));
      input.on('error', reject);
      input.resume();
    });
  }
}

export function createTtyConsole(options: TtyConsoleOptions = {}): TtyConsole {
  return new TtyConsole(options);
}
