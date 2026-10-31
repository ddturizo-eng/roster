// Approved skills inlined into `/roster/in/agent.md` (ADR 0005, ADR 0021; human decision on T16,
// option 1). The orchestrator resolves each skill's `SKILL.md` from the pinned install and passes it
// in `RuntimeJob.skills`; this adapter never reads a file. Each skill becomes a delimited section of
// the system prompt appended with `--append-system-prompt-file`:
//
//   <agent body>
//
//   ---
//
//   ## Skill: <name>
//
//   <SKILL.md body without its frontmatter>
//
// No skill directory is mounted, no skill script runs, and the `Skill` tool stays denied by the
// managed settings: a skill is instructions only. A listed skill without content, content for a
// skill the agent does not list, or a duplicate fails with `RuntimeInputError`; nothing is skipped.

import type { SkillText } from '../../../core/domain/runtime.ts';
import { RuntimeInputError } from './errors.ts';

/** Skill names: printable, one line, so the section heading cannot be broken. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;

/** Heading of the section of one skill. */
export function skillHeading(name: string): string {
  return `## Skill: ${name}`;
}

function quoted(name: unknown): string {
  return JSON.stringify(String(name).slice(0, 100));
}

/**
 * The body of a `SKILL.md`: a leading `---` frontmatter block (YAML between two `---` lines) is
 * removed, with a BOM and CRLF line endings accepted. An unterminated block is an error.
 */
export function skillBody(name: string, content: string): string {
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let body = text;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end === -1) throw new RuntimeInputError('skill content', `the frontmatter of skill ${quoted(name)} is not closed`);
    body = lines.slice(end + 1).join('\n');
  }
  body = body.trim();
  if (body.length === 0) throw new RuntimeInputError('skill content', `skill ${quoted(name)} has no instructions after its frontmatter`);
  return body;
}

/**
 * The content of `/roster/in/agent.md`: the agent body, then one section per skill in the order of
 * the agent's `skills:`. `skills` must hold exactly one entry per listed name and nothing else.
 */
export function composeAgentInstructions(body: string, listed: readonly string[], skills: readonly SkillText[]): string {
  if (typeof body !== 'string') throw new RuntimeInputError('agent body', 'must be text');
  if (!Array.isArray(listed)) throw new RuntimeInputError('agent skills', 'must be a list');
  if (!Array.isArray(skills)) throw new RuntimeInputError('skills', 'must be a list of resolved skill texts');

  const byName = new Map<string, string>();
  for (const skill of skills) {
    if (typeof skill !== 'object' || skill === null || typeof skill.name !== 'string' || typeof skill.content !== 'string') {
      throw new RuntimeInputError('skills', 'each entry must have a name and text content');
    }
    if (byName.has(skill.name)) throw new RuntimeInputError('skills', `skill ${quoted(skill.name)} is given more than once`);
    if (!listed.includes(skill.name)) throw new RuntimeInputError('skills', `skill ${quoted(skill.name)} is not listed by the agent`);
    byName.set(skill.name, skill.content);
  }

  const sections: string[] = [];
  const seen = new Set<string>();
  for (const name of listed) {
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw new RuntimeInputError('agent skills', `${quoted(name)} is not a valid skill name`);
    if (seen.has(name)) throw new RuntimeInputError('agent skills', `skill ${quoted(name)} is listed more than once`);
    seen.add(name);
    const content = byName.get(name);
    if (content === undefined) throw new RuntimeInputError('skills', `skill ${quoted(name)} is listed by the agent but no content was provided`);
    sections.push(`---\n\n${skillHeading(name)}\n\n${skillBody(name, content)}\n`);
  }

  if (sections.length === 0) return body;
  const head = body.replace(/\s+$/, '');
  return `${head}\n\n${sections.join('\n')}`;
}
