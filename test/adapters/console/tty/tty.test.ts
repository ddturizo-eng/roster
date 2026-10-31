import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TtyConsole } from '../../../../src/adapters/console/tty/index.ts';

function setup(isTTY = false) {
  const input = Object.assign(new PassThrough(), { isTTY, raw: [] as boolean[], setRawMode(mode: boolean) { this.raw.push(mode); } });
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let out = '';
  output.on('data', (d: Buffer) => (out += d.toString()));
  let err = '';
  errorOutput.on('data', (d: Buffer) => (err += d.toString()));
  return { input, console: new TtyConsole({ input, output, errorOutput }), out: () => out, err: () => err };
}

describe('TtyConsole', () => {
  it('prints lines to stdout and stderr', () => {
    const t = setup();
    t.console.print('hello');
    t.console.printError('bad');
    expect(t.out()).toBe('hello\n');
    expect(t.err()).toBe('bad\n');
  });

  it('readSecret on a pipe reads the first line and never echoes it', async () => {
    const t = setup(false);
    const pending = t.console.readSecret('Secret:');
    t.input.write('s3cret-value\nrest');
    expect(await pending).toBe('s3cret-value');
    expect(t.out()).not.toContain('s3cret');
    expect(t.out()).toContain('Secret:');
  });

  it('readSecret on a TTY uses raw mode, handles backspace and never echoes', async () => {
    const t = setup(true);
    const pending = t.console.readSecret('Secret:');
    t.input.write('abcx\u007f');
    t.input.write('d\r');
    expect(await pending).toBe('abcd');
    expect(t.input.raw).toEqual([true, false]);
    expect(t.out()).not.toContain('abc');
  });

  it('readSecret on a TTY rejects on Ctrl+C', async () => {
    const t = setup(true);
    const pending = t.console.readSecret('Secret:');
    t.input.write('ab\u0003');
    await expect(pending).rejects.toThrow('cancelled');
    expect(t.input.raw).toEqual([true, false]);
  });

  it('readInput reads all of stdin', async () => {
    const t = setup();
    const pending = t.console.readInput();
    t.input.write('line one\nline two\n');
    t.input.end();
    expect(await pending).toBe('line one\nline two\n');
  });

  it('ask prints the question and returns one answer', async () => {
    const t = setup();
    const pending = t.console.ask('Name?');
    t.input.write('Ana\n');
    expect(await pending).toBe('Ana');
    expect(t.out()).toContain('Name?');
  });
});
