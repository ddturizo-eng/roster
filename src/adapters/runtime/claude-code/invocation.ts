// The container invocation of one Claude Code job (ADR 0016, ADR 0022, plan 002 section 9.5, spike
// T14 findings 1 and 2). Pure: the sandbox (SandboxPort) writes the files, mounts them and runs it.
//
//   claude -p --output-format stream-json --verbose
//          --append-system-prompt-file /roster/in/agent.md
//          --max-turns <n> --no-session-persistence
//          [--model <alias>]
//          --strict-mcp-config --mcp-config {"mcpServers":{}}      < /roster/in/prompt.md
//
// - Never `--bare`: it ignores `CLAUDE_CODE_OAUTH_TOKEN` (ADR 0016). `assertNoBare` checks every argv.
// - The prompt goes on stdin (`stdinFile`, `docker run -i`), never as a positional argument: the
//   variadic `--mcp-config` would read it as a config path (finding 1). For the same reason
//   `--mcp-config` and its one value are always the last arguments.
// - `--max-turns` works although `claude --help` does not list it (finding 2).
// - `/roster/in/agent.md` is the agent body followed by the approved skills listed in its `skills:`,
//   inlined as delimited sections (skills.ts); skills are never mounted or run.
// - The environment names are those of the `agent` and `review` profiles of the sandbox (plan 002
//   section 9.4); values never appear here.

import type { ContainerInvocation, InFile, RuntimeJob } from '../../../core/domain/runtime.ts';
import { RuntimeInputError } from './errors.ts';
import { renderManagedSettings } from './managed-settings.ts';
import { composeAgentInstructions } from './skills.ts';

/** Registry name of this runtime (ADR 0022). */
export const RUNTIME_NAME = 'claude-code';

/** Container path of the read-only input directory (plan 002 section 9.3). */
export const IN_DIR = '/roster/in';

/** Files written into `/roster/in` (plan 002 sections 8 and 9.5). */
export const IN_FILES = {
  prompt: 'prompt.md',
  agent: 'agent.md',
  managedSettings: 'managed-settings.json',
} as const;

/** The MCP configuration with no server; with `--strict-mcp-config` no other config is loaded. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/** Environment names of runtime jobs, in the sandbox's profile order (plan 002 section 9.4). */
export const RUNTIME_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_AUTOUPDATER',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'LANG',
] as const;

/** Upper bound for `--max-turns`; the policy caps it lower (`limitsFor`, T08). */
export const MAX_TURNS_LIMIT = 1000;

const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
// Model aliases and names: `sonnet`, `opus`, `claude-sonnet-5-5`, `sonnet[1m]`. Never starts with `-`.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,99}$/;

/** Throws when any argument is `--bare` or `--bare=<value>`. Called on every argv built here. */
export function assertNoBare(argv: readonly string[]): void {
  if (argv.some((arg) => arg === '--bare' || arg.startsWith('--bare='))) {
    throw new RuntimeInputError('argv', '--bare is never used: it ignores CLAUDE_CODE_OAUTH_TOKEN (ADR 0016)');
  }
}

/** Validates a runtime image reference such as `roster/runtime-claude:<commit>`. */
export function checkRuntimeImage(image: string): string {
  if (typeof image !== 'string' || !IMAGE.test(image)) {
    throw new RuntimeInputError('image', 'must be a lowercase image reference such as roster/runtime-claude:<commit>');
  }
  return image;
}

/** `claude` and its arguments for one job. */
export function claudeArgv(maxTurns: number, model: string | undefined): string[] {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS_LIMIT) {
    throw new RuntimeInputError('max turns', `must be an integer from 1 to ${MAX_TURNS_LIMIT}`);
  }
  if (model !== undefined && (typeof model !== 'string' || !MODEL.test(model))) {
    throw new RuntimeInputError('model', 'must be a model alias or name such as sonnet');
  }
  const argv = [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt-file',
    `${IN_DIR}/${IN_FILES.agent}`,
    '--max-turns',
    String(maxTurns),
    '--no-session-persistence',
    ...(model === undefined ? [] : ['--model', model]),
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP_CONFIG,
  ];
  assertNoBare(argv);
  return argv;
}

export interface InvocationOptions {
  /** `roster/runtime-claude:<roster-commit>`, built by the pinned install. */
  readonly image: string;
  /** Operation classes of the policy (`Policy.operations`), for the managed settings. */
  readonly operations: Readonly<Record<string, string>>;
}

/** Image, argv, environment names and `/roster/in` files of one agent or review job. */
export function buildClaudeInvocation(job: RuntimeJob, options: InvocationOptions): ContainerInvocation {
  if (job.profile !== 'agent' && job.profile !== 'review') {
    throw new RuntimeInputError('profile', 'must be agent or review for a runtime job');
  }
  if (typeof job.prompt !== 'string' || job.prompt.trim().length === 0) throw new RuntimeInputError('prompt', 'must be non-empty text');
  if (typeof job.agent.body !== 'string') throw new RuntimeInputError('agent body', 'must be text');
  const image = checkRuntimeImage(options.image);
  const argv = claudeArgv(job.limits.maxTurns, job.agent.models[RUNTIME_NAME]);
  const instructions = composeAgentInstructions(job.agent.body, job.agent.skills, job.skills);
  const inFiles: InFile[] = [
    { name: IN_FILES.prompt, content: job.prompt },
    { name: IN_FILES.agent, content: instructions },
    {
      name: IN_FILES.managedSettings,
      content: renderManagedSettings({ capabilities: job.agent.capabilities, operations: options.operations }),
    },
  ];
  return { image, argv, env: [...RUNTIME_ENV], inFiles, stdinFile: IN_FILES.prompt };
}
