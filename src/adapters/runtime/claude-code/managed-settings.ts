// Managed settings of every Claude Code job (ADR 0016, ADR 0021, ADR 0023, ADR 0024, plan 002
// section 9.5, spike T14 findings 4 and 5).
// Protected path (ADR 0025): only the human pushes changes to this file. It is written once, in T16,
// and covers every runtime job profile (`agent` and `review`; `setup` and `verify` run no Claude Code
// and get no managed settings), so later tasks use it without touching it. Upgrading the pinned CLI
// (container/runtime-claude/Dockerfile, also protected) must refresh `KNOWN_TOOLS` in the same PR.
//
// The file is mounted read-only at `/etc/claude-code/managed-settings.json`, where it outranks every
// settings file of the work tree (`.claude/settings.json` is untrusted repository content):
// - `allowManagedPermissionRulesOnly` and `allowManagedHooksOnly`: only the rules below apply and no
//   work tree hook runs (H4 confirmed: a planted `SessionStart` hook did not run);
// - `permissions.defaultMode: "dontAsk"`: a tool that is not allowed is refused, never prompted, so a
//   headless run never waits; `disableBypassPermissionsMode: "disable"`: a work tree cannot ask for
//   `bypassPermissions`;
// - `disableClaudeAiConnectors`: no claude.ai connectors (MCP servers are also off through
//   `--strict-mcp-config`, see invocation.ts);
// - allow rules from the agent's capabilities, each gated by the policy's operation class:
//   `read` -> Read, Grep, Glob; `edit` -> Edit, Write; `shell` -> Bash; `web` -> WebSearch;
// - deny rules for every tool of the pinned CLI that is not allowed (finding 5: unlisted tools stay
//   available under `dontAsk`), `WebFetch` always (egress allows only the provider API), and the
//   command rules of plan section 9.5 as a second line behind the container (finding 4: a deny rule
//   on a bare tool name removes the tool from the session).
// The `Skill` tool is always denied, but skills still reach the agent: the approved skills listed in
// its `skills:` are inlined into `/roster/in/agent.md` (skills.ts, human decision on T16), so no
// skill directory is loaded and no skill script can run.

import { CAPABILITIES } from '../../../core/domain/agent.ts';
import type { Capability } from '../../../core/domain/agent.ts';
import { RuntimeInputError } from './errors.ts';

/** Claude Code CLI version the tool list below was taken from (spike T14, runtime Dockerfile). */
export const PINNED_CLI_VERSION = '2.1.314';

/**
 * Every tool in the `system` `init` line's `tools` of the pinned CLI, union of the spike runs (the
 * unrestricted run lists `Bash`, `Edit`, `Monitor`, `WebFetch`, `Write`; the restricted runs list
 * `Glob` and `Grep`). Sorted. A tool missing here would stay available to every agent.
 */
export const KNOWN_TOOLS = [
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterWorktree',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'Monitor',
  'NotebookEdit',
  'Read',
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
] as const;

/** Claude Code tools granted by each capability (plan 002 section 9.5, ADR 0021). */
export const CAPABILITY_TOOLS: Readonly<Record<Capability, readonly string[]>> = {
  read: ['Read', 'Grep', 'Glob'],
  edit: ['Edit', 'Write'],
  shell: ['Bash'],
  web: ['WebSearch'],
};

/**
 * Operation class of the policy (ADR 0024, `policies/mvp.json`) that must be `allow` for a
 * capability's tools to be allowed. `web` has no class: egress (ADR 0023) bounds it.
 */
export const CAPABILITY_OPERATION: Readonly<Record<Capability, string | undefined>> = {
  read: 'read',
  edit: 'write_worktree',
  shell: 'run_commands',
  web: undefined,
};

/** Denied whatever the capabilities: egress allows only the provider API (plan 002 section 9.5). */
export const ALWAYS_DENIED_TOOLS = ['WebFetch'] as const;

/**
 * Command rules of plan 002 section 9.5: `vcs_write` is Roster-only and `install_dependencies` needs
 * approval (ADR 0024). Defense in depth; the boundary is the container (no git, no registry egress).
 */
export const COMMAND_DENY_RULES = [
  'Bash(git push *)',
  'Bash(npm install *)',
  'Bash(npm i *)',
  'Bash(pnpm add *)',
  'Bash(yarn add *)',
] as const;

export interface ManagedSettings {
  readonly allowManagedPermissionRulesOnly: true;
  readonly allowManagedHooksOnly: true;
  readonly disableClaudeAiConnectors: true;
  readonly permissions: {
    readonly defaultMode: 'dontAsk';
    readonly disableBypassPermissionsMode: 'disable';
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
}

export interface ManagedSettingsInput {
  /** The agent's capabilities (ADR 0021). `read` is implied even when absent. */
  readonly capabilities: readonly Capability[];
  /**
   * Operation classes of the policy (ADR 0024), for example `Policy.operations` of `core/policy`.
   * A class that is missing or not `allow` withholds the tools of its capability (fail closed).
   */
  readonly operations: Readonly<Record<string, string>>;
}

/** The tools allowed for these capabilities under these operation classes, in `KNOWN_TOOLS` order. */
export function allowedTools(input: ManagedSettingsInput): string[] {
  if (!Array.isArray(input.capabilities)) throw new RuntimeInputError('capabilities', 'must be a list');
  if (typeof input.operations !== 'object' || input.operations === null) {
    throw new RuntimeInputError('policy operations', 'must be an object');
  }
  for (const capability of input.capabilities) {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) {
      throw new RuntimeInputError('capabilities', `${JSON.stringify(String(capability).slice(0, 40))} is not a known capability`);
    }
  }
  const granted = new Set<string>();
  for (const capability of CAPABILITIES) {
    if (capability !== 'read' && !input.capabilities.includes(capability)) continue;
    const operation = CAPABILITY_OPERATION[capability];
    if (operation !== undefined && input.operations[operation] !== 'allow') continue;
    for (const tool of CAPABILITY_TOOLS[capability]) granted.add(tool);
  }
  for (const tool of ALWAYS_DENIED_TOOLS) granted.delete(tool);
  return KNOWN_TOOLS.filter((tool) => granted.has(tool));
}

/** The managed settings of one job (plan 002 section 9.5). Pure; key order is stable. */
export function generateManagedSettings(input: ManagedSettingsInput): ManagedSettings {
  const allow = allowedTools(input);
  const deny = [...KNOWN_TOOLS.filter((tool) => !allow.includes(tool)), ...COMMAND_DENY_RULES];
  for (const tool of ALWAYS_DENIED_TOOLS) if (!deny.includes(tool)) deny.unshift(tool);
  return {
    allowManagedPermissionRulesOnly: true,
    allowManagedHooksOnly: true,
    disableClaudeAiConnectors: true,
    permissions: {
      defaultMode: 'dontAsk',
      disableBypassPermissionsMode: 'disable',
      allow,
      deny,
    },
  };
}

/** The content of `/roster/in/managed-settings.json`: two-space JSON with a final newline. */
export function renderManagedSettings(input: ManagedSettingsInput): string {
  return `${JSON.stringify(generateManagedSettings(input), null, 2)}\n`;
}
