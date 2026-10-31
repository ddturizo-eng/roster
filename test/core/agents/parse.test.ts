import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentDefinitionError,
  formatAgentIssue,
  parseAgentDefinition,
  parseAgentDefinitionStrict,
} from '../../../src/core/agents/parse.ts';
import { RosterError } from '../../../src/core/domain/errors.ts';

const AGENTS_DIR = fileURLToPath(new URL('../../../agents/', import.meta.url));

const v2 = (extra = '', overrides: Record<string, string | null> = {}): string => {
  const base: Record<string, string> = {
    schema: 'roster/agent@2',
    name: 'code-reviewer',
    description: 'Reviews a diff against the acceptance criteria.',
    capabilities: 'read',
    skills: '',
    runtimes: 'claude-code',
    contract: 'reviewer',
  };
  const lines = Object.entries({ ...base, ...overrides })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n${extra}---\nBody line.\n`;
};
const opts = { slug: 'code-reviewer', approvedSkills: ['better-ui'] };

describe('v2 definition', () => {
  it('parses every key, comments and blank lines', () => {
    const text = v2('# a comment\n\nmodel.claude-code: sonnet\nmax-turns: 60\ntimeout-minutes: 20\n', {
      capabilities: 'edit, web',
      skills: 'better-ui',
      runtimes: 'claude-code, other-rt',
    });
    const r = parseAgentDefinition(text, opts);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.definition).toEqual({
      schemaVersion: 2,
      name: 'code-reviewer',
      description: 'Reviews a diff against the acceptance criteria.',
      capabilities: ['read', 'edit', 'web'],
      skills: ['better-ui'],
      runtimes: ['claude-code', 'other-rt'],
      contract: 'reviewer',
      models: { 'claude-code': 'sonnet' },
      maxTurns: 60,
      timeoutMinutes: 20,
      body: 'Body line.',
    });
  });

  it('handles CRLF and a BOM like LF', () => {
    const lf = parseAgentDefinition(v2(), opts);
    const crlf = parseAgentDefinition('﻿' + v2().replace(/\n/g, '\r\n'), opts);
    expect(crlf.definition).toEqual(lf.definition);
  });

  it('keeps a "#" inside a value', () => {
    const r = parseAgentDefinition(v2('', { description: 'Fixes issue #12' }), opts);
    expect(r.definition?.description).toBe('Fixes issue #12');
  });

  it('warns on unknown keys', () => {
    const r = parseAgentDefinition(v2('color: red\n'), opts);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['unknown_key']);
  });
});

describe('errors', () => {
  const cases: [string, string, string][] = [
    ['nested YAML', v2('metadata:\n  a: b\n'), 'invalid_syntax'],
    ['YAML list', v2('- x\n'), 'invalid_syntax'],
    ['flow list value', v2('', { capabilities: '[read]' }), 'invalid_syntax'],
    ['not key: value', v2('just text\n'), 'invalid_syntax'],
    ['duplicate key', v2('contract: hr\n'), 'duplicate_key'],
    ['bad slug', v2(), 'invalid_slug'],
    ['name mismatch', v2('', { name: 'other' }), 'name_mismatch'],
    ['missing description', v2('', { description: null }), 'missing_field'],
    ['missing capabilities', v2('', { capabilities: null }), 'missing_field'],
    ['unknown capability', v2('', { capabilities: 'read, fly' }), 'unknown_capability'],
    ['unknown contract', v2('', { contract: 'boss' }), 'unknown_contract'],
    ['unknown skill', v2('', { skills: 'evil-skill' }), 'unknown_skill'],
    ['unsupported schema', v2('', { schema: 'roster/agent@3' }), 'unsupported_schema'],
    ['bad max-turns', v2('max-turns: 0\n'), 'invalid_value'],
    ['bad runtime name', v2('', { runtimes: 'Claude Code' }), 'invalid_value'],
    ['empty model', v2('model.claude-code:\n'), 'invalid_value'],
    ['no frontmatter', 'hello\n', 'missing_frontmatter'],
    ['unterminated', '---\nname: x\n', 'unterminated_frontmatter'],
  ];
  for (const [title, text, code] of cases) {
    it(`${title} -> ${code}`, () => {
      const slug = title === 'bad slug' ? 'Bad_Slug' : 'code-reviewer';
      const r = parseAgentDefinition(text, { ...opts, slug });
      expect(r.ok).toBe(false);
      expect(r.definition).toBeNull();
      expect(r.errors.map((e) => e.code)).toContain(code);
    });
  }

  it('names the line of the error', () => {
    const r = parseAgentDefinition(v2('metadata:\n  a: b\n'), opts);
    const issue = r.errors[0];
    expect(issue?.line).toBe(10);
    expect(formatAgentIssue(issue!)).toMatch(/^line 10: /);
  });

  it('strict variant throws a RosterError with the issues', () => {
    expect(() => parseAgentDefinitionStrict('hello', opts)).toThrow(AgentDefinitionError);
    try {
      parseAgentDefinitionStrict('hello', opts);
    } catch (e) {
      expect(e).toBeInstanceOf(RosterError);
      expect((e as AgentDefinitionError).issues[0]?.code).toBe('missing_frontmatter');
    }
  });
});

describe('v1 definition', () => {
  const v1 = `---\nname: code-reviewer\ndescription: x\ntools: Read, Grep, Write, Bash, WebSearch\nmodel: opus\n---\nHi\n`;

  it('maps tools, defaults runtimes and contract, and warns', () => {
    const r = parseAgentDefinition(v1, opts);
    expect(r.errors).toEqual([]);
    expect(r.definition).toMatchObject({
      schemaVersion: 1,
      capabilities: ['read', 'edit', 'shell', 'web'],
      runtimes: ['claude-code'],
      contract: 'specialist',
      models: { 'claude-code': 'opus' },
      body: 'Hi',
    });
    expect(r.warnings.map((w) => w.code)).toEqual(['legacy_definition']);
  });

  it('rejects an unknown tool', () => {
    expect(parseAgentDefinition(v1.replace('Bash', 'Teleport'), opts).errors[0]?.code).toBe('unknown_tool');
  });

  it('grants every capability, with a warning, when tools is missing', () => {
    const r = parseAgentDefinition(v1.replace(/tools:.*\n/, ''), opts);
    expect(r.errors).toEqual([]);
    expect(r.definition?.capabilities).toEqual(['read', 'edit', 'shell', 'web']);
    expect(r.warnings).toHaveLength(2);
  });
});

describe('every real file in agents/', () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  it('finds the agents', () => expect(files.length).toBeGreaterThan(0));
  for (const file of files) {
    it(`${file} parses (v1 or v2)`, () => {
      const slug = file.replace(/\.md$/, '');
      const r = parseAgentDefinition(readFileSync(AGENTS_DIR + file, 'utf8'), { slug, approvedSkills: [] });
      expect(r.errors).toEqual([]);
      expect(r.definition?.body.length).toBeGreaterThan(0);
      expect(r.definition?.capabilities).toContain('read');
    });
  }
});
