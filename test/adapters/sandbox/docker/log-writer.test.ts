import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LineLogWriter, REDACTED, longestSecret, secretRedactor } from '../../../../src/adapters/sandbox/docker/index.ts';

// Line-by-line redacting log writer (ADR 0031).

const FAKE_TOKEN = 'sk-ant-oat01-FAKE0123456789abcdefFAKE0123456789';
const FAKE_GH = 'github_pat_FAKE0123456789abcdef';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logPath(name = 'agent.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'roster-log-'));
  dirs.push(dir);
  return join(dir, 'logs', name);
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('secretRedactor', () => {
  it('replaces every known value, longest first, and nothing else', () => {
    const redact = secretRedactor([FAKE_TOKEN, 'sk-ant', '', FAKE_GH]);
    expect(redact(`a ${FAKE_TOKEN} b ${FAKE_GH} c sk-ant-x`)).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}-x`);
    expect(secretRedactor([])('unchanged')).toBe('unchanged');
    expect(secretRedactor(['a.b'])('a.b axb')).toBe(`${REDACTED} axb`);
    expect(longestSecret([FAKE_GH, FAKE_TOKEN])).toBe(FAKE_TOKEN.length);
  });
});

describe('LineLogWriter', () => {
  it('writes each complete line at once and keeps an unterminated one until it completes', () => {
    const path = logPath();
    const writer = new LineLogWriter(path, { secrets: [] });
    writer.write('{"a":1}\n{"b"');
    expect(read(path)).toBe('{"a":1}\n');
    writer.write(':2}\n');
    expect(read(path)).toBe('{"a":1}\n{"b":2}\n');
    writer.close();
  });

  it('redacts a secret split across two chunks', () => {
    const path = logPath();
    const writer = new LineLogWriter(path, { secrets: [FAKE_TOKEN] });
    const line = `{"type":"user","text":"token ${FAKE_TOKEN} here"}\n`;
    const cut = line.indexOf(FAKE_TOKEN) + 10;
    writer.write(Buffer.from(line.slice(0, cut)));
    expect(read(path)).toBe('');
    writer.write(Buffer.from(line.slice(cut)));
    writer.close();
    expect(read(path)).not.toContain(FAKE_TOKEN);
    expect(read(path)).not.toContain(FAKE_TOKEN.slice(0, 10) + FAKE_TOKEN.slice(10));
    expect(JSON.parse(read(path).trim())).toEqual({ type: 'user', text: `token ${REDACTED} here` });
  });

  it('decodes a UTF-8 character split across chunks', () => {
    const path = logPath();
    const writer = new LineLogWriter(path, { secrets: [] });
    const bytes = Buffer.from('café ✓\n', 'utf8');
    writer.write(bytes.subarray(0, 4));
    writer.write(bytes.subarray(4, 7));
    writer.write(bytes.subarray(7));
    writer.close();
    expect(read(path)).toBe('café ✓\n');
  });

  it('flushes an unterminated last line on close, redacted and with a line break', () => {
    const path = logPath();
    const writer = new LineLogWriter(path, { secrets: [FAKE_TOKEN] });
    writer.write(`first\nlast ${FAKE_TOKEN}`);
    writer.close();
    expect(read(path)).toBe(`first\nlast ${REDACTED}\n`);
    writer.write('after close\n');
    writer.close();
    expect(read(path)).toBe(`first\nlast ${REDACTED}\n`);
  });

  it('appends to an existing file and keeps line content unchanged apart from redaction', () => {
    const path = logPath();
    const first = new LineLogWriter(path, { secrets: [] });
    first.write('one\r\n');
    first.close();
    const second = new LineLogWriter(path, { secrets: [] });
    second.write('two\n\n');
    second.close();
    expect(read(path)).toBe('one\r\ntwo\n\n');
  });

  it('calls onLine with each redacted line', () => {
    const lines: string[] = [];
    const writer = new LineLogWriter(logPath(), { secrets: [FAKE_TOKEN], onLine: (line) => lines.push(line) });
    writer.write(`a\nb ${FAKE_TOKEN}\nc`);
    writer.close();
    expect(lines).toEqual(['a', `b ${REDACTED}`, 'c']);
  });

  it('bounds memory on a huge unterminated line and still redacts a secret crossing the cut', () => {
    const path = logPath();
    const writer = new LineLogWriter(path, { secrets: [FAKE_TOKEN], maxPendingChars: 64 });
    const head = 'x'.repeat(60);
    // The token starts before the overflow point and ends in a later chunk.
    writer.write(head + FAKE_TOKEN.slice(0, 20));
    expect(read(path).length).toBeGreaterThan(0);
    expect(read(path)).not.toContain('\n');
    writer.write(`${FAKE_TOKEN.slice(20)} tail ${FAKE_TOKEN}`);
    writer.write('y'.repeat(200));
    writer.write('\n');
    writer.close();
    const content = read(path);
    expect(content).not.toContain(FAKE_TOKEN);
    expect(content).toBe(`${head}${REDACTED} tail ${REDACTED}${'y'.repeat(200)}\n`);
  });

  it('lets a second reader open, read and delete the file while it is open for writing', () => {
    const path = logPath();
    const writer = new LineLogWriter(path, { secrets: [] });
    writer.write('line 1\n');
    expect(readFileSync(path, 'utf8')).toBe('line 1\n');
    writer.write('line 2\n');
    expect(readFileSync(path, 'utf8')).toBe('line 1\nline 2\n');
    // Retention may delete a log another process still holds open (shared delete access on Windows).
    unlinkSync(path);
    writer.close();
  });
});
