// Reader of `agents/<slug>.md` (ADR 0021): flat frontmatter, v2 and the v1 compatibility mapping.
//
// Pure: takes the text, the file slug and the approved skill names, never a path. Handles LF, CRLF
// and a leading BOM. Nothing here throws on bad input: problems are returned as `errors` (the file
// is not a usable definition, `definition` is null) and `warnings` (reported, definition returned).

import { CAPABILITIES, CONTRACT_NAMES } from '../domain/agent.ts';
import type { AgentDefinition, Capability, ContractName } from '../domain/agent.ts';
import { RosterError } from '../domain/errors.ts';
import { SLUG_PATTERN } from '../domain/ids.ts';

export const AGENT_SCHEMA_V2 = 'roster/agent@2';

export type AgentIssueCode =
  | 'invalid_slug'
  | 'missing_frontmatter'
  | 'unterminated_frontmatter'
  | 'invalid_syntax'
  | 'duplicate_key'
  | 'missing_field'
  | 'invalid_value'
  | 'name_mismatch'
  | 'unknown_capability'
  | 'unknown_tool'
  | 'unknown_contract'
  | 'unknown_skill'
  | 'unsupported_schema'
  | 'unknown_key'
  | 'legacy_definition';

export interface AgentIssue {
  /** 1-based line in the parsed text; 0 when the problem belongs to the file as a whole. */
  readonly line: number;
  readonly code: AgentIssueCode;
  /** English description of the rule that failed. */
  readonly message: string;
}

export interface ParseAgentOptions {
  /** The file name without `.md`. `name` must equal it. */
  readonly slug: string;
  /** Skill names with status `approved` in `skills/registry.md`. */
  readonly approvedSkills: readonly string[];
}

export interface ParseAgentResult {
  readonly ok: boolean;
  /** Null when `errors` is not empty. */
  readonly definition: AgentDefinition | null;
  readonly errors: readonly AgentIssue[];
  readonly warnings: readonly AgentIssue[];
}

export class AgentDefinitionError extends RosterError {
  override readonly name = 'AgentDefinitionError';
  readonly issues: readonly AgentIssue[];

  constructor(slug: string, issues: readonly AgentIssue[]) {
    const shown = issues.slice(0, 5).map(formatAgentIssue).join('; ');
    const more = issues.length > 5 ? `; and ${issues.length - 5} more` : '';
    super(`Invalid agent definition ${slug}: ${shown}${more}`);
    this.issues = issues;
  }
}

export function formatAgentIssue(issue: AgentIssue): string {
  return issue.line > 0 ? `line ${issue.line}: ${issue.message}` : issue.message;
}

/** v1 `tools` to capabilities (ADR 0021). */
const V1_TOOL_CAPABILITIES: Readonly<Record<string, Capability>> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  Write: 'edit',
  Edit: 'edit',
  Bash: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
};

const V1_DEFAULT_RUNTIME = 'claude-code';
const V1_DEFAULT_CONTRACT: ContractName = 'specialist';

const V2_KEYS = new Set([
  'schema',
  'name',
  'description',
  'capabilities',
  'skills',
  'runtimes',
  'contract',
  'max-turns',
  'timeout-minutes',
]);
const V1_KEYS = new Set(['name', 'description', 'tools', 'skills', 'model']);

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)?$/;
const MODEL_KEY_PATTERN = /^model\.(.+)$/;

interface Entry {
  readonly value: string;
  readonly line: number;
}

export function parseAgentDefinition(text: string, options: ParseAgentOptions): ParseAgentResult {
  const errors: AgentIssue[] = [];
  const warnings: AgentIssue[] = [];
  const error = (line: number, code: AgentIssueCode, message: string): void => {
    errors.push({ line, code, message });
  };
  const warn = (line: number, code: AgentIssueCode, message: string): void => {
    warnings.push({ line, code, message });
  };
  const finish = (definition: AgentDefinition | null): ParseAgentResult => ({
    ok: errors.length === 0,
    definition: errors.length === 0 ? definition : null,
    errors,
    warnings,
  });

  if (!SLUG_PATTERN.test(options.slug)) {
    error(0, 'invalid_slug', 'The file slug must match ^[a-z0-9-]+$.');
  }

  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    error(1, 'missing_frontmatter', 'The file must start with a "---" frontmatter line.');
    return finish(null);
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end === -1) {
    error(1, 'unterminated_frontmatter', 'The frontmatter has no closing "---" line.');
    return finish(null);
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd();

  const entries = new Map<string, Entry>();
  for (let i = 1; i < end; i++) {
    const raw = lines[i] as string;
    const lineNo = i + 1;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (/^\s/.test(raw) || raw.startsWith('- ')) {
      error(lineNo, 'invalid_syntax', 'Nesting and YAML lists are not allowed; use "key: value" lines.');
      continue;
    }
    const colon = raw.indexOf(':');
    const key = colon === -1 ? '' : raw.slice(0, colon);
    if (!KEY_PATTERN.test(key)) {
      error(lineNo, 'invalid_syntax', 'Expected a "key: value" line.');
      continue;
    }
    const value = raw.slice(colon + 1).trim();
    if (/^[[{|>&*!]/.test(value)) {
      error(lineNo, 'invalid_syntax', `The value of "${key}" uses YAML syntax; write plain text or a comma list.`);
      continue;
    }
    if (entries.has(key)) {
      error(lineNo, 'duplicate_key', `Duplicate key "${key}".`);
      continue;
    }
    entries.set(key, { value, line: lineNo });
  }

  const schema = entries.get('schema');
  const isV2 = schema !== undefined;
  if (isV2 && schema.value !== AGENT_SCHEMA_V2) {
    error(schema.line, 'unsupported_schema', `Unsupported schema; expected "${AGENT_SCHEMA_V2}".`);
    return finish(null);
  }
  if (!isV2) {
    warn(0, 'legacy_definition', 'v1 definition (no "schema"): tools mapped to capabilities, default runtimes and contract.');
  }

  const known = isV2 ? V2_KEYS : V1_KEYS;
  for (const [key, entry] of entries) {
    if (known.has(key) || (isV2 && MODEL_KEY_PATTERN.test(key))) continue;
    warn(entry.line, 'unknown_key', `Unknown key "${key}" is ignored.`);
  }

  const required = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined || entry.value === '') {
      error(entry?.line ?? 0, 'missing_field', `Missing required key "${key}".`);
      return undefined;
    }
    return entry;
  };
  const list = (entry: Entry | undefined): string[] =>
    entry === undefined
      ? []
      : [...new Set(entry.value.split(',').map((s) => s.trim()).filter((s) => s !== ''))];

  const name = required('name');
  if (name !== undefined && name.value !== options.slug) {
    error(name.line, 'name_mismatch', `"name" must equal the file slug "${options.slug}".`);
  }
  const description = required('description');

  let capabilities: Capability[] = [];
  let runtimes: string[] = [V1_DEFAULT_RUNTIME];
  let contract: ContractName = V1_DEFAULT_CONTRACT;
  const models: Record<string, string> = {};

  if (isV2) {
    const capsEntry = required('capabilities');
    for (const c of list(capsEntry)) {
      if ((CAPABILITIES as readonly string[]).includes(c)) capabilities.push(c as Capability);
      else error(capsEntry?.line ?? 0, 'unknown_capability', `Unknown capability "${c}".`);
    }
    const runtimesEntry = required('runtimes');
    runtimes = list(runtimesEntry);
    for (const r of runtimes) {
      if (!SLUG_PATTERN.test(r)) {
        error(runtimesEntry?.line ?? 0, 'invalid_value', `Runtime name "${r}" must match ^[a-z0-9-]+$.`);
      }
    }
    const contractEntry = required('contract');
    if (contractEntry !== undefined) {
      if ((CONTRACT_NAMES as readonly string[]).includes(contractEntry.value)) {
        contract = contractEntry.value as ContractName;
      } else {
        error(contractEntry.line, 'unknown_contract', `Unknown contract "${contractEntry.value}".`);
      }
    }
    for (const [key, entry] of entries) {
      const m = MODEL_KEY_PATTERN.exec(key);
      if (m === null) continue;
      if (entry.value === '' || !SLUG_PATTERN.test(m[1] as string)) {
        error(entry.line, 'invalid_value', `"${key}" needs a runtime name and a model value.`);
      } else {
        models[m[1] as string] = entry.value;
      }
    }
  } else {
    const toolsEntry = entries.get('tools');
    if (toolsEntry === undefined || toolsEntry.value === '') {
      // Claude Code gives a subagent without `tools` every tool; keep that meaning, loudly.
      capabilities.push(...CAPABILITIES);
      warn(0, 'legacy_definition', 'v1 definition without "tools" inherits every tool: all capabilities granted.');
    }
    for (const t of list(toolsEntry)) {
      const cap = V1_TOOL_CAPABILITIES[t];
      if (cap === undefined) error(toolsEntry?.line ?? 0, 'unknown_tool', `Unknown v1 tool "${t}".`);
      else capabilities.push(cap);
    }
    const model = entries.get('model');
    if (model !== undefined && model.value !== '') models[V1_DEFAULT_RUNTIME] = model.value;
  }
  capabilities = CAPABILITIES.filter((c) => c === 'read' || capabilities.includes(c));

  const skillsEntry = entries.get('skills');
  const skills = list(skillsEntry);
  for (const s of skills) {
    if (!options.approvedSkills.includes(s)) {
      error(skillsEntry?.line ?? 0, 'unknown_skill', `Skill "${s}" is not approved in skills/registry.md.`);
    }
  }

  const positiveInt = (key: string): number | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(entry.value)) {
      error(entry.line, 'invalid_value', `"${key}" must be a positive integer.`);
      return undefined;
    }
    return Number(entry.value);
  };
  const maxTurns = isV2 ? positiveInt('max-turns') : undefined;
  const timeoutMinutes = isV2 ? positiveInt('timeout-minutes') : undefined;

  if (errors.length > 0) return finish(null);
  return finish({
    schemaVersion: isV2 ? 2 : 1,
    name: (name as Entry).value,
    description: (description as Entry).value,
    capabilities,
    skills,
    runtimes,
    contract,
    models,
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    body,
  });
}

/** Returns the definition or throws `AgentDefinitionError` with every error. */
export function parseAgentDefinitionStrict(
  text: string,
  options: ParseAgentOptions,
): { readonly definition: AgentDefinition; readonly warnings: readonly AgentIssue[] } {
  const result = parseAgentDefinition(text, options);
  if (result.definition === null) throw new AgentDefinitionError(options.slug, result.errors);
  return { definition: result.definition, warnings: result.warnings };
}
