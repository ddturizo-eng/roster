import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RuntimeInputError,
  composeAgentInstructions,
  createClaudeCodeRuntime,
  generateManagedSettings,
  skillBody,
} from '../../../../src/adapters/runtime/claude-code/index.ts';
import type { AgentDefinition, Capability } from '../../../../src/core/domain/agent.ts';
import type { RuntimeJob, SkillText } from '../../../../src/core/domain/runtime.ts';
import { parsePolicy } from '../../../../src/core/policy/policy.ts';

// Approved skills inlined into `/roster/in/agent.md` (human decision on T16, option 1): delimited
// sections, frontmatter dropped, nothing skipped, the `Skill` tool still denied, no `--bare`.

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(repoFile(path), 'utf8'));
const OPERATIONS = parsePolicy(readJson('policies/mvp.json'), readJson('policies/protected-paths.json')).operations;

const runtime = createClaudeCodeRuntime({ image: 'roster/runtime-claude:51a94ac', operations: OPERATIONS });

const UI_SKILL = '---\nname: better-ui\ndescription: UI polish.\n---\n# Better UI\n\nUse 8 px radii.\n';
const MOTION_SKILL = '﻿---\r\nname: motion\r\ndescription: Motion.\r\n---\r\n\r\n# Motion\r\n\r\nEase out.\r\n';

function agent(skills: readonly string[], capabilities: readonly Capability[] = ['read', 'edit']): AgentDefinition {
  return {
    schemaVersion: 2,
    name: 'frontend-engineer',
    description: 'Frontend work.',
    capabilities,
    skills,
    runtimes: ['claude-code'],
    contract: 'specialist',
    models: {},
    body: '# Role\n\nYou build UIs.\n',
  };
}

function job(listed: readonly string[], skills: readonly SkillText[], capabilities?: readonly Capability[]): RuntimeJob {
  return {
    executionId: '20261031120000-abc123',
    jobKind: 'specialist',
    profile: 'agent',
    agent: agent(listed, capabilities),
    prompt: 'Do the task.',
    limits: { maxTurns: 60, timeoutMinutes: 90 },
    skills,
  };
}

const agentMd = (j: RuntimeJob): string => runtime.buildInvocation(j).inFiles.find((file) => file.name === 'agent.md')?.content ?? '';

describe('agent.md composition', () => {
  it('is the agent body unchanged when the agent lists no skill', () => {
    expect(agentMd(job([], []))).toBe('# Role\n\nYou build UIs.\n');
  });

  it('appends one delimited section per listed skill, in the order of skills:, without frontmatter', () => {
    const content = agentMd(
      job(['motion', 'better-ui'], [
        { name: 'better-ui', content: UI_SKILL },
        { name: 'motion', content: MOTION_SKILL },
      ]),
    );
    expect(content).toBe(
      [
        '# Role',
        '',
        'You build UIs.',
        '',
        '---',
        '',
        '## Skill: motion',
        '',
        '# Motion',
        '',
        'Ease out.',
        '',
        '---',
        '',
        '## Skill: better-ui',
        '',
        '# Better UI',
        '',
        'Use 8 px radii.',
        '',
      ].join('\n'),
    );
    expect(content).not.toContain('description:');
    expect(content).not.toContain('\r');
  });

  it('keeps a skill without frontmatter whole', () => {
    expect(skillBody('plain', '# Plain\n\nText.\n')).toBe('# Plain\n\nText.');
  });

  it('does not change the prompt, the stdin file or the other files', () => {
    const invocation = runtime.buildInvocation(job(['better-ui'], [{ name: 'better-ui', content: UI_SKILL }]));
    expect(invocation.stdinFile).toBe('prompt.md');
    expect(invocation.inFiles.map((file) => file.name)).toEqual(['prompt.md', 'agent.md', 'managed-settings.json']);
    expect(invocation.inFiles[0]?.content).toBe('Do the task.');
  });
});

describe('skills are never skipped or added silently', () => {
  it('fails when a listed skill has no content', () => {
    expect(() => runtime.buildInvocation(job(['better-ui', 'motion'], [{ name: 'better-ui', content: UI_SKILL }]))).toThrow(
      new RuntimeInputError('skills', 'skill "motion" is listed by the agent but no content was provided'),
    );
  });

  it('fails when content is given for a skill the agent does not list', () => {
    expect(() => runtime.buildInvocation(job([], [{ name: 'better-ui', content: UI_SKILL }]))).toThrow(RuntimeInputError);
  });

  it('fails on a duplicate entry or a duplicate listing', () => {
    expect(() =>
      runtime.buildInvocation(
        job(['better-ui'], [
          { name: 'better-ui', content: UI_SKILL },
          { name: 'better-ui', content: UI_SKILL },
        ]),
      ),
    ).toThrow(RuntimeInputError);
    expect(() => runtime.buildInvocation(job(['better-ui', 'better-ui'], [{ name: 'better-ui', content: UI_SKILL }]))).toThrow(RuntimeInputError);
  });

  it('fails on empty content, an unclosed frontmatter or frontmatter only', () => {
    for (const content of ['', '  \n', '---\nname: x\n# never closed\n', '---\nname: x\n---\n\n']) {
      expect(() => runtime.buildInvocation(job(['better-ui'], [{ name: 'better-ui', content }])), JSON.stringify(content)).toThrow(RuntimeInputError);
    }
  });

  it('fails on a skill name that could break the section heading', () => {
    expect(() => composeAgentInstructions('body', ['bad\n## Skill: x'], [{ name: 'bad\n## Skill: x', content: '# X' }])).toThrow(RuntimeInputError);
  });

  it('fails when the job carries no skill list', () => {
    const broken = { ...job([], []), skills: undefined } as unknown as RuntimeJob;
    expect(() => runtime.buildInvocation(broken)).toThrow(RuntimeInputError);
  });

  it('never echoes skill content in an error', () => {
    try {
      runtime.buildInvocation(job(['better-ui', 'motion'], [{ name: 'better-ui', content: '# SECRET-ISH SKILL TEXT' }]));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET-ISH');
    }
  });
});

describe('skills stay instructions only', () => {
  it('keeps the Skill tool denied for every capability set', () => {
    for (const capabilities of [['read'], ['read', 'edit', 'shell', 'web']] as Capability[][]) {
      const invocation = runtime.buildInvocation(job(['better-ui'], [{ name: 'better-ui', content: UI_SKILL }], capabilities));
      const settings = JSON.parse(invocation.inFiles[2]?.content ?? '{}') as ReturnType<typeof generateManagedSettings>;
      expect(settings.permissions.deny).toContain('Skill');
      expect(settings.permissions.allow).not.toContain('Skill');
    }
  });

  it('adds no argument, mount or environment name, and never --bare', () => {
    const without = runtime.buildInvocation(job([], []));
    const withSkills = runtime.buildInvocation(job(['better-ui'], [{ name: 'better-ui', content: '# Run with --bare\n\nUse --bare.' }]));
    expect(withSkills.argv).toEqual(without.argv);
    expect(withSkills.env).toEqual(without.env);
    expect(withSkills.argv.filter((arg) => arg === '--bare' || arg.startsWith('--bare='))).toEqual([]);
    expect(withSkills.argv.some((arg) => arg.includes('skill'))).toBe(false);
  });
});
