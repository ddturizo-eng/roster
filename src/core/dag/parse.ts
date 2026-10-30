// Parser of the machine-readable `tasks.md` (ADR 0019) and validation of its dependency graph.
//
// Pure: takes the text, never a path. Handles LF, CRLF and a leading BOM, so the result is the same
// whatever `core.autocrlf` did to the file. `bodyMd` is always LF-normalized for the same reason.
//
// Nothing here throws on bad input. Problems are returned as `errors` (the whole import is rejected,
// nothing is written) and `warnings` (reported, import goes on). When `errors` is not empty,
// `tasks` is best effort (missing fields get neutral values) and must not be imported.

import { SLUG_PATTERN, TASK_KEY_PATTERN } from '../domain/ids.ts';
import { TasksMdError } from './errors.ts';
import type { TasksMdErrorCode, TasksMdIssue, TasksMdWarningCode } from './issue.ts';

/** One task of the file. Plain data, in file order. */
export interface ParsedTask {
  /** `Tnn` (two or three digits), unique in a valid file. */
  readonly key: string;
  readonly title: string;
  /** 0-based position of the task in the file; selection follows it (ADR 0019). */
  readonly ord: number;
  /** 1-based line of the `## Tnn.` heading. */
  readonly line: number;
  /** State of the `Done` checkbox. Only meaningful on the first import of the task. */
  readonly done: boolean;
  /** Keys (`Tnn`) of the tasks this one depends on, in the order written, without repeats. */
  readonly dependsOn: readonly string[];
  /** 1-based line of the `Depends on` item; the task heading line when the item is missing. */
  readonly dependsOnLine: number;
  /** The `Needs human` reason; null when the item is absent. Its presence marks `needs-human`. */
  readonly needsHuman: string | null;
  readonly agent: string | null;
  readonly profile: string | null;
  /** Paths written between backticks in `Areas`. Text outside backticks is not kept here. */
  readonly areas: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verification: string;
  /** The full task text, heading included, LF-normalized, without trailing blank lines. */
  readonly bodyMd: string;
}

export interface ParsedTasksMd {
  /** True when `errors` is empty. */
  readonly ok: boolean;
  readonly tasks: readonly ParsedTask[];
  readonly errors: readonly TasksMdIssue[];
  readonly warnings: readonly TasksMdIssue[];
}

const TASK_HEADING = /^## (T\d{2,3})\.[ \t]+(\S.*?)[ \t]*$/;
const LEVEL2_HEADING = /^##(?:[ \t]|$)/;
const LOOSE_TASK_HEADING = /^##[ \t]+(T\d+)/;
const CHECKBOX_ITEM = /^- \[([ xX])\][ \t]+(.*?)[ \t]*$/;
const KEY_ITEM = /^- ([^:]+?)[ \t]*:[ \t]*(.*?)[ \t]*$/;
const NESTED_ITEM = /^(?: {2}|\t)-(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TRAILING_NOTE = /[ \t]*\([^()]*\)[ \t]*$/;

const KNOWN_KEYS = [
  'Depends on',
  'Needs human',
  'Agent',
  'Profile',
  'Areas',
  'Acceptance criteria',
  'Verification',
] as const;

type KnownKey = (typeof KNOWN_KEYS)[number];

function isKnownKey(key: string): key is KnownKey {
  return (KNOWN_KEYS as readonly string[]).includes(key);
}

/** Text echoed from the file in a message is short and printable. */
function clip(text: string, max = 40): string {
  const printable = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return printable.length > max ? `${printable.slice(0, max)}...` : printable;
}

interface RawField {
  readonly line: number;
  value: string;
  readonly items: string[];
}

interface Block {
  readonly key: string;
  readonly title: string;
  readonly ord: number;
  /** 0-based index of the heading line. */
  readonly start: number;
  /** 0-based index after the last line of the task. */
  readonly end: number;
}

/** True for lines inside a fenced code block, delimiters included. */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let open: { readonly char: string; readonly length: number } | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    const marker = match?.[1] ?? '';
    if (open === null) {
      if (marker !== '') {
        open = { char: marker.charAt(0), length: marker.length };
        fenced.push(true);
      } else {
        fenced.push(false);
      }
    } else {
      fenced.push(true);
      if (marker.charAt(0) === open.char && marker.length >= open.length && line.trim() === marker.trim()) {
        open = null;
      }
    }
  }
  return fenced;
}

class Issues {
  readonly errors: TasksMdIssue[] = [];
  readonly warnings: TasksMdIssue[] = [];

  error(line: number, taskId: string | null, code: TasksMdErrorCode, message: string): void {
    this.errors.push({ line, taskId, code, message });
  }

  warn(line: number, taskId: string | null, code: TasksMdWarningCode, message: string): void {
    this.warnings.push({ line, taskId, code, message });
  }
}

/** Parses and validates `tasks.md` text (ADR 0019, import rules 1 and 2). */
export function parseTasksMd(text: string): ParsedTasksMd {
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).split(/\r\n|\n|\r/);
  const fenced = fencedLines(lines);
  const issues = new Issues();

  const blocks = findBlocks(lines, fenced, issues);
  const tasks = blocks.map((block) => parseBlock(block, lines, fenced, issues));
  validateGraph(tasks, issues);

  // Stable sort: by line, then by the order the problems were found.
  const byLine = (a: TasksMdIssue, b: TasksMdIssue): number => a.line - b.line;
  const errors = [...issues.errors].sort(byLine);
  return { ok: errors.length === 0, tasks, errors, warnings: [...issues.warnings].sort(byLine) };
}

/** Like `parseTasksMd` but throws `TasksMdError` when the import must be rejected. */
export function parseTasksMdStrict(text: string): {
  readonly tasks: readonly ParsedTask[];
  readonly warnings: readonly TasksMdIssue[];
} {
  const result = parseTasksMd(text);
  if (!result.ok) {
    throw new TasksMdError(result.errors);
  }
  return { tasks: result.tasks, warnings: result.warnings };
}

// ---------------------------------------------------------------------------------------------
// Segmentation: a task starts at `## Tnn. title` and ends at the next level-2 heading or the end.

function findBlocks(lines: readonly string[], fenced: readonly boolean[], issues: Issues): Block[] {
  const blocks: Block[] = [];
  let open: { key: string; title: string; start: number } | null = null;

  const close = (end: number): void => {
    if (open !== null) {
      blocks.push({ key: open.key, title: open.title, ord: blocks.length, start: open.start, end });
      open = null;
    }
  };

  lines.forEach((line, index) => {
    if (fenced[index] === true || !LEVEL2_HEADING.test(line)) {
      return;
    }
    close(index);
    const heading = TASK_HEADING.exec(line);
    if (heading !== null) {
      open = { key: heading[1] ?? '', title: heading[2] ?? '', start: index };
      return;
    }
    // Any other level-2 heading only ends the previous task, except one that looks like a task
    // heading but is malformed: dropping it silently would lose a task.
    const loose = LOOSE_TASK_HEADING.exec(line);
    if (loose !== null) {
      issues.error(
        index + 1,
        loose[1] ?? null,
        'invalid_heading',
        'task heading must be "## T<nn>. <title>" with two or three digits and a non-empty title',
      );
    }
  });
  close(lines.length);
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// One task

function parseBlock(block: Block, lines: readonly string[], fenced: readonly boolean[], issues: Issues): ParsedTask {
  const { key } = block;
  const headingLine = block.start + 1;

  let done: boolean | null = null;
  const fields = new Map<KnownKey, RawField>();
  let current: RawField | null = null;

  for (let index = block.start + 1; index < block.end; index += 1) {
    const line = lines[index] ?? '';
    const lineNo = index + 1;
    if (fenced[index] === true || line.trim() === '') {
      continue;
    }

    if (line.startsWith('- ') || line === '-') {
      current = null;
      const checkbox = CHECKBOX_ITEM.exec(line);
      if (checkbox !== null) {
        const label = checkbox[2] ?? '';
        if (label === 'Done') {
          if (done !== null) {
            issues.error(lineNo, key, 'duplicate_field', 'field "Done" appears more than once');
          } else {
            done = checkbox[1] !== ' ';
          }
        } else {
          issues.warn(lineNo, key, 'unknown_key', `unknown field "[${checkbox[1]}] ${clip(label)}" ignored`);
        }
        continue;
      }
      const item = KEY_ITEM.exec(line);
      if (item === null) {
        issues.warn(lineNo, key, 'unrecognized_line', 'list item is not "- <Key>: <value>" and is ignored');
        continue;
      }
      const name = item[1] ?? '';
      if (!isKnownKey(name)) {
        issues.warn(lineNo, key, 'unknown_key', `unknown field "${clip(name)}" ignored`);
        continue;
      }
      if (fields.has(name)) {
        issues.error(lineNo, key, 'duplicate_field', `field "${name}" appears more than once`);
        continue;
      }
      current = { line: lineNo, value: item[2] ?? '', items: [] };
      fields.set(name, current);
      continue;
    }

    if (/^[ \t]/.test(line)) {
      if (current === null) {
        continue;
      }
      if (fields.get('Acceptance criteria') === current) {
        const nested = NESTED_ITEM.exec(line);
        if (nested !== null) {
          const textOfItem = nested[1] ?? '';
          if (textOfItem !== '') {
            current.items.push(textOfItem);
          }
        } else if (current.items.length > 0) {
          // A deeper-indented line continues the previous criterion.
          const last = current.items.length - 1;
          current.items[last] = `${current.items[last]} ${line.trim()}`;
        }
      } else {
        // Indented lines continue the value of a one-line field.
        current.value = `${current.value} ${line.trim()}`.trim();
      }
      continue;
    }

    // Prose between fields is allowed and ignored.
    current = null;
  }

  const missing = (name: string): void => {
    issues.error(headingLine, key, 'missing_field', `missing required field "${name}"`);
  };

  if (done === null) {
    missing('Done');
  }

  // Depends on
  const dependsField = fields.get('Depends on');
  let dependsOn: string[] = [];
  const dependsOnLine = dependsField?.line ?? headingLine;
  if (dependsField === undefined) {
    missing('Depends on');
  } else {
    dependsOn = parseDependsOn(dependsField, key, issues);
  }

  // Needs human
  const needsField = fields.get('Needs human');
  let needsHuman: string | null = null;
  if (needsField !== undefined) {
    if (needsField.value === '') {
      issues.error(needsField.line, key, 'invalid_value', '"Needs human" needs a reason');
    } else {
      needsHuman = needsField.value;
    }
  }

  // Agent
  const agentField = fields.get('Agent');
  let agent: string | null = null;
  if (agentField !== undefined && agentField.value !== '') {
    if (SLUG_PATTERN.test(agentField.value)) {
      agent = agentField.value;
    } else {
      issues.error(agentField.line, key, 'invalid_value', '"Agent" must be a slug of lowercase letters, digits and hyphens');
    }
  }

  const profileValue = fields.get('Profile')?.value ?? '';
  const areasValue = fields.get('Areas')?.value ?? '';

  // Acceptance criteria
  const criteriaField = fields.get('Acceptance criteria');
  let acceptanceCriteria: string[] = [];
  if (criteriaField === undefined) {
    missing('Acceptance criteria');
  } else if (criteriaField.items.length === 0) {
    issues.error(
      criteriaField.line,
      key,
      'empty_acceptance_criteria',
      '"Acceptance criteria" needs at least one nested item (two-space indent)',
    );
  } else {
    acceptanceCriteria = criteriaField.items;
  }

  // Verification
  const verificationField = fields.get('Verification');
  const verification = verificationField?.value ?? '';
  if (verificationField === undefined) {
    missing('Verification');
  } else if (verification === '') {
    issues.error(verificationField.line, key, 'missing_field', 'required field "Verification" has no value');
  }

  const body = lines
    .slice(block.start, block.end)
    .join('\n')
    .replace(/\s+$/, '');

  return {
    key,
    title: block.title,
    ord: block.ord,
    line: headingLine,
    done: done === true,
    dependsOn,
    dependsOnLine,
    needsHuman,
    agent,
    profile: profileValue === '' ? null : profileValue,
    areas: [...areasValue.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').trim()).filter((path) => path !== ''),
    acceptanceCriteria,
    verification,
    bodyMd: body,
  };
}

/** `none`, or comma-separated task keys. A trailing parenthetical note is allowed and dropped. */
function parseDependsOn(field: RawField, key: string, issues: Issues): string[] {
  const value = field.value.replace(TRAILING_NOTE, '').trim();
  if (value === '') {
    issues.error(field.line, key, 'missing_field', 'required field "Depends on" has no value (write "none" for no dependencies)');
    return [];
  }
  if (value === 'none') {
    return [];
  }
  const result: string[] = [];
  let valid = true;
  for (const part of value.split(',').map((piece) => piece.trim())) {
    if (!TASK_KEY_PATTERN.test(part)) {
      issues.error(
        field.line,
        key,
        'invalid_value',
        `"Depends on" must be "none" or comma-separated task ids like T01, T03; got "${clip(part, 20)}"`,
      );
      valid = false;
    } else if (result.includes(part)) {
      issues.warn(field.line, key, 'duplicate_dependency', `dependency ${part} is listed more than once`);
    } else {
      result.push(part);
    }
  }
  return valid ? result : [];
}

// ---------------------------------------------------------------------------------------------
// Graph validation: duplicate ids, unknown and self dependencies, cycles.

function validateGraph(tasks: readonly ParsedTask[], issues: Issues): void {
  const first = new Map<string, ParsedTask>();
  for (const task of tasks) {
    const earlier = first.get(task.key);
    if (earlier === undefined) {
      first.set(task.key, task);
    } else {
      issues.error(task.line, task.key, 'duplicate_id', `task id ${task.key} is already used at line ${earlier.line}`);
    }
  }

  // Edges that survive: known targets, no self loops.
  const edges = new Map<string, string[]>();
  for (const task of first.values()) {
    const targets: string[] = [];
    for (const dependency of task.dependsOn) {
      if (dependency === task.key) {
        issues.error(task.dependsOnLine, task.key, 'self_dependency', `${task.key} depends on itself`);
      } else if (!first.has(dependency)) {
        issues.error(task.dependsOnLine, task.key, 'unknown_dependency', `${task.key} depends on ${dependency}, which is not in the file`);
      } else {
        targets.push(dependency);
      }
    }
    edges.set(task.key, targets);
  }

  const cycle = findCycle([...first.values()], edges);
  if (cycle !== null) {
    const head = first.get(cycle[0] ?? '');
    issues.error(
      head?.dependsOnLine ?? 1,
      cycle[0] ?? null,
      'dependency_cycle',
      `dependency cycle (each task depends on the next): ${cycle.join(' -> ')}`,
    );
  }
}

/**
 * First cycle found by a depth-first walk in file order, or null. Returned as keys with the first
 * key repeated at the end, rotated to start at the task that is first in the file, so the same
 * file always names the same cycle: `T03 -> T07 -> T05 -> T03` means T03 depends on T07, T07 on
 * T05 and T05 on T03.
 */
function findCycle(tasks: readonly ParsedTask[], edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const order = new Map(tasks.map((task) => [task.key, task.ord] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (node: string): string[] | null => {
    state.set(node, 'visiting');
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const seen = state.get(next);
      if (seen === 'visiting') {
        return path.slice(path.indexOf(next));
      }
      if (seen === undefined) {
        const found = visit(next);
        if (found !== null) {
          return found;
        }
      }
    }
    path.pop();
    state.set(node, 'done');
    return null;
  };

  for (const task of tasks) {
    if (state.has(task.key)) {
      continue;
    }
    const members = visit(task.key);
    if (members !== null) {
      let start = 0;
      members.forEach((member, index) => {
        if ((order.get(member) ?? 0) < (order.get(members[start] ?? '') ?? 0)) {
          start = index;
        }
      });
      const rotated = [...members.slice(start), ...members.slice(0, start)];
      return [...rotated, rotated[0] ?? ''];
    }
  }
  return null;
}
