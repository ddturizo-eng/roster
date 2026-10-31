import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_DENY_RULES,
  KNOWN_TOOLS,
  PINNED_CLI_VERSION,
  RuntimeInputError,
  allowedTools,
  generateManagedSettings,
  renderManagedSettings,
} from '../../../../src/adapters/runtime/claude-code/index.ts';
import type { Capability } from '../../../../src/core/domain/agent.ts';
import { parsePolicy } from '../../../../src/core/policy/policy.ts';

// Protected managed settings (plan 002 section 9.5, spike T14 findings 4 and 5): exact allow and deny
// lists per capability set, checked against the init `tools` of the pinned CLI.

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(repoFile(path), 'utf8'));

const POLICY = parsePolicy(readJson('policies/mvp.json'), readJson('policies/protected-paths.json'));
const OPERATIONS = POLICY.operations;

/** Every subset of the optional capabilities; `read` is implied. */
const CAPABILITY_SETS: readonly (readonly Capability[])[] = [
  ['read'],
  ['read', 'edit'],
  ['read', 'shell'],
  ['read', 'web'],
  ['read', 'edit', 'shell'],
  ['read', 'edit', 'web'],
  ['read', 'shell', 'web'],
  ['read', 'edit', 'shell', 'web'],
];

/** `tools` of the `system` `init` line of a fixture recorded with the pinned CLI. */
function initTools(fixture: string): { version: string; tools: string[] } {
  const lines = readFileSync(repoFile(`test/fixtures/claude/${fixture}`), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') continue;
    const parsed = JSON.parse(line) as { type?: string; subtype?: string; tools?: string[]; claude_code_version?: string };
    if (parsed.type === 'system' && parsed.subtype === 'init') return { version: parsed.claude_code_version ?? '', tools: parsed.tools ?? [] };
  }
  throw new Error(`no init line in ${fixture}`);
}

const SPIKE_FIXTURES = ['success-pong.jsonl', 'managed-settings-denials.jsonl', 'error-max-turns.jsonl'];

describe('generateManagedSettings', () => {
  it.each(CAPABILITY_SETS.map((set) => [set.join('-'), set] as const))('matches the snapshot for %s', async (label, capabilities) => {
    const rendered = renderManagedSettings({ capabilities, operations: OPERATIONS });
    await expect(rendered).toMatchFileSnapshot(`../../../fixtures/claude/managed-settings/${label}.json`);
  });

  it('builds the read-only settings exactly', () => {
    expect(generateManagedSettings({ capabilities: ['read'], operations: OPERATIONS })).toEqual({
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
      disableClaudeAiConnectors: true,
      permissions: {
        defaultMode: 'dontAsk',
        disableBypassPermissionsMode: 'disable',
        allow: ['Glob', 'Grep', 'Read'],
        deny: [
          'Bash',
          'CronCreate',
          'CronDelete',
          'CronList',
          'Edit',
          'EnterWorktree',
          'ExitWorktree',
          'ListAgents',
          'Monitor',
          'NotebookEdit',
          'RemoteTrigger',
          'ReportFindings',
          'ScheduleWakeup',
          'SendMessage',
          'Skill',
          'Task',
          'TaskStop',
          'ToolSearch',
          'WebFetch',
          'WebSearch',
          'Workflow',
          'Write',
          'Bash(git push *)',
          'Bash(npm install *)',
          'Bash(npm i *)',
          'Bash(pnpm add *)',
          'Bash(yarn add *)',
        ],
      },
    });
  });

  it('builds the settings of every capability exactly', () => {
    const settings = generateManagedSettings({ capabilities: ['read', 'edit', 'shell', 'web'], operations: OPERATIONS });
    expect(settings.permissions.allow).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebSearch', 'Write']);
    expect(settings.permissions.deny).toEqual([
      'CronCreate',
      'CronDelete',
      'CronList',
      'EnterWorktree',
      'ExitWorktree',
      'ListAgents',
      'Monitor',
      'NotebookEdit',
      'RemoteTrigger',
      'ReportFindings',
      'ScheduleWakeup',
      'SendMessage',
      'Skill',
      'Task',
      'TaskStop',
      'ToolSearch',
      'WebFetch',
      'Workflow',
      ...COMMAND_DENY_RULES,
    ]);
  });

  it.each(CAPABILITY_SETS.map((set) => [set.join('-'), set] as const))(
    'for %s, allow and deny partition every known tool and always deny WebFetch',
    (_label, capabilities) => {
      const { permissions } = generateManagedSettings({ capabilities, operations: OPERATIONS });
      const deniedTools = permissions.deny.filter((rule) => !rule.includes('('));
      expect([...permissions.allow, ...deniedTools].sort()).toEqual([...KNOWN_TOOLS].sort());
      expect(permissions.allow.filter((tool) => deniedTools.includes(tool))).toEqual([]);
      expect(permissions.deny).toContain('WebFetch');
      expect(permissions.allow).not.toContain('WebFetch');
      expect(permissions.deny.slice(-COMMAND_DENY_RULES.length)).toEqual([...COMMAND_DENY_RULES]);
    },
  );

  it('implies read when the capability list leaves it out', () => {
    expect(allowedTools({ capabilities: ['edit'], operations: OPERATIONS })).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
    expect(allowedTools({ capabilities: [], operations: OPERATIONS })).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('always sets the managed-only switches, dontAsk and the disabled bypass and connectors', () => {
    for (const capabilities of CAPABILITY_SETS) {
      const settings = generateManagedSettings({ capabilities, operations: OPERATIONS });
      expect(Object.keys(settings)).toEqual(['allowManagedPermissionRulesOnly', 'allowManagedHooksOnly', 'disableClaudeAiConnectors', 'permissions']);
      expect(settings.allowManagedPermissionRulesOnly).toBe(true);
      expect(settings.allowManagedHooksOnly).toBe(true);
      expect(settings.disableClaudeAiConnectors).toBe(true);
      expect(settings.permissions.defaultMode).toBe('dontAsk');
      expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    }
  });

  it('renders two-space JSON with a final newline that parses back to the settings', () => {
    const input = { capabilities: ['read', 'shell'] as Capability[], operations: OPERATIONS };
    const rendered = renderManagedSettings(input);
    expect(rendered.endsWith('}\n')).toBe(true);
    expect(JSON.parse(rendered)).toEqual(generateManagedSettings(input));
  });
});

describe('policy gates the allow rules (fail closed)', () => {
  it('withholds Bash when run_commands is not allow', () => {
    const operations = { ...OPERATIONS, run_commands: 'deny' };
    const settings = generateManagedSettings({ capabilities: ['read', 'shell'], operations });
    expect(settings.permissions.allow).toEqual(['Glob', 'Grep', 'Read']);
    expect(settings.permissions.deny).toContain('Bash');
  });

  it('withholds Edit and Write when write_worktree is missing', () => {
    const { write_worktree: _removed, ...operations } = OPERATIONS;
    expect(allowedTools({ capabilities: ['read', 'edit'], operations })).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('allows nothing when read is not allow', () => {
    expect(allowedTools({ capabilities: ['read'], operations: { ...OPERATIONS, read: 'approve' } })).toEqual([]);
  });

  it('allows WebSearch for web whatever the operations, and never WebFetch', () => {
    expect(allowedTools({ capabilities: ['web'], operations: {} })).toEqual(['WebSearch']);
  });
});

describe('input validation', () => {
  it('rejects an unknown capability', () => {
    expect(() => generateManagedSettings({ capabilities: ['root' as Capability], operations: OPERATIONS })).toThrow(RuntimeInputError);
  });

  it('rejects missing operations', () => {
    expect(() =>
      generateManagedSettings({ capabilities: ['read'], operations: null as unknown as Readonly<Record<string, string>> }),
    ).toThrow(RuntimeInputError);
  });
});

describe('tool list of the pinned CLI (spike finding 5)', () => {
  it.each(SPIKE_FIXTURES)('%s was recorded with the pinned version and lists only known tools', (fixture) => {
    const { version, tools } = initTools(fixture);
    expect(version).toBe(PINNED_CLI_VERSION);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((tool) => !(KNOWN_TOOLS as readonly string[]).includes(tool))).toEqual([]);
  });

  it('KNOWN_TOOLS is exactly the union of the init tools of the spike fixtures', () => {
    const union = new Set(SPIKE_FIXTURES.flatMap((fixture) => initTools(fixture).tools));
    expect([...KNOWN_TOOLS]).toEqual([...union].sort());
  });

  it.each(CAPABILITY_SETS.map((set) => [set.join('-'), set] as const))(
    'for %s, every init tool of the pinned CLI is either allowed or denied',
    (_label, capabilities) => {
      const { permissions } = generateManagedSettings({ capabilities, operations: OPERATIONS });
      for (const fixture of SPIKE_FIXTURES) {
        for (const tool of initTools(fixture).tools) {
          expect(permissions.allow.includes(tool) || permissions.deny.includes(tool), `${fixture}: ${tool}`).toBe(true);
        }
      }
    },
  );

  it('denies, for a read-only agent, every tool the spike saw still available under dontAsk', () => {
    const stillAvailable = initTools('managed-settings-denials.jsonl').tools.filter((tool) => !['Read', 'Grep', 'Glob'].includes(tool));
    const { permissions } = generateManagedSettings({ capabilities: ['read'], operations: OPERATIONS });
    expect(stillAvailable.filter((tool) => !permissions.deny.includes(tool))).toEqual([]);
  });
});
