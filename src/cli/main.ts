// Composition root of the roster CLI: the only place that builds real adapters and hands them to the
// commands (ADR 0017). Commands: `auth`, `run`, `feature import`, `sync`, `doctor`. Other commands
// belong to later tasks of spec 002 and print usage.

import { win32 } from 'node:path';
import { createTtyConsole } from '../adapters/console/tty/index.ts';
import { createGitHubForge } from '../adapters/forge/github/index.ts';
import { createClaudeCodeRuntime } from '../adapters/runtime/claude-code/index.ts';
import { createDockerSandbox } from '../adapters/sandbox/docker/index.ts';
import { createDpapiSecrets } from '../adapters/secrets/dpapi/index.ts';
import { openSqliteStore } from '../adapters/store/sqlite/index.ts';
import { createGitVcs } from '../adapters/vcs/git/index.ts';
import { createPushGuard } from '../adapters/vcs/push-guard.ts';
import { RosterError } from '../core/domain/errors.ts';
import type { ConsolePort } from '../ports/console.ts';
import type { SandboxPort } from '../ports/sandbox.ts';
import type { SecretsPort } from '../ports/secrets.ts';
import type { StorePort } from '../ports/store.ts';
import type { VcsPort } from '../ports/vcs.ts';
import { runAuth } from './commands/auth.ts';
import { runDoctor } from './commands/doctor.ts';
import { runFeature } from './commands/feature.ts';
import { runRun } from './commands/run.ts';
import { runSyncCommand } from './commands/sync.ts';
import { defaultConfigPath, defaultInstallRoot, loadConfig, loadHumanLanguage } from './config.ts';
import type { RosterConfig } from './config.ts';
import { describeError } from './describe-error.ts';
import { createFileLock, guardLockOnExit } from './lock.ts';
import { createNodeFileSystem, createSystemClock, isProcessAlive } from './node-ports.ts';

const USAGE = `roster: local orchestration of agent specialists

Usage:
  roster <command> [options]

Commands:
  auth set claude|github                 Store a secret (read from the terminal, never echoed).
  run [--dry-run]                        Run one unit of work (sync, pick a task, execute it).
  feature import <project> <NNN-slug>    Adopt a feature whose spec, plan and tasks are on the base branch.
  sync                                   Fetch, refresh registrations and read pull request states.
  doctor                                 Check this machine.

Other commands are not available yet.
`;

interface Machine {
  readonly config: RosterConfig;
  readonly dataDir: string;
  readonly store: StorePort;
  readonly vcs: VcsPort;
  readonly secrets: SecretsPort;
  readonly console: ConsolePort;
}

function openMachine(console: ConsolePort): Machine {
  const configPath = defaultConfigPath();
  const config = loadConfig(configPath);
  const dataDir = win32.dirname(configPath);
  return {
    config,
    dataDir,
    store: openSqliteStore(win32.join(dataDir, 'data', 'roster.db')),
    vcs: createGitVcs({ workspaceRoot: config.workspaceRoot, pushGuard: createPushGuard }),
    secrets: createDpapiSecrets(),
    console,
  };
}

function createForge(machine: Machine) {
  return createGitHubForge({ token: () => machine.secrets.get('github-token'), configDir: win32.join(machine.dataDir, 'gh') });
}

/** Image tags are the commit of the pinned install (ADR 0025). */
async function pinnedCommit(machine: Machine): Promise<string> {
  return machine.vcs.resolveRef(defaultInstallRoot(), 'HEAD');
}

async function createSandbox(machine: Machine, commit: string): Promise<SandboxPort> {
  const redactValues: string[] = [];
  if (await machine.secrets.has('github-token')) redactValues.push(await machine.secrets.get('github-token'));
  return createDockerSandbox({ proxyImage: `roster/egress-proxy:${commit}`, redactValues });
}

async function dispatch(command: string, args: readonly string[], machine: Machine): Promise<number> {
  const clock = createSystemClock();
  const language = loadHumanLanguage();
  const { config, store, vcs, secrets, console } = machine;
  const base = { vcs, store, clock, rosterRepoPath: config.rosterRepo };

  switch (command) {
    case 'sync':
      return runSyncCommand(args, { ...base, forge: createForge(machine), language, console });
    case 'feature':
      return runFeature(args, { ...base, console });
    case 'doctor': {
      // The image tag does not matter for `available()`; an install without git still gets a report.
      const commit = await pinnedCommit(machine).catch(() => 'unknown');
      return runDoctor(args, {
        ...base,
        forge: createForge(machine),
        sandbox: await createSandbox(machine, commit),
        secrets,
        console,
        nodeVersion: process.versions.node,
      });
    }
    case 'run': {
      const commit = await pinnedCommit(machine);
      const lock = createFileLock({ path: win32.join(machine.dataDir, 'run.lock'), pid: process.pid, isProcessAlive });
      const removeGuard = guardLockOnExit(lock, process, {
        onUncaught: (name) => console.printError(`Unexpected error: ${name}`),
      });
      try {
        return await runRun(args, {
          ...base,
          forge: createForge(machine),
          sandbox: await createSandbox(machine, commit),
          fs: createNodeFileSystem(),
          secrets,
          console,
          language,
          logRoot: win32.join(machine.dataDir, 'logs'),
          commitAuthor: config.commitAuthor,
          pid: process.pid,
          quotaCooldownMinutes: config.quotaCooldownMinutes,
          maxRunsPerNight: config.maxRunsPerNight,
          nightWindow: config.nightWindow,
          lock,
          isProcessAlive,
          runtimeFor: (policy) =>
            createClaudeCodeRuntime({ image: `roster/runtime-claude:${commit}`, operations: policy.operations }),
        });
      } finally {
        removeGuard();
        lock.release();
      }
    }
    default:
      return 1;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const console = createTtyConsole();

  if (command === 'auth') {
    try {
      return await runAuth(rest, { secrets: createDpapiSecrets(), console });
    } catch (error) {
      if (error instanceof RosterError) {
        console.printError(error.message);
        return 1;
      }
      throw error;
    }
  }

  const known = command === 'run' || command === 'sync' || command === 'feature' || command === 'doctor';
  if (!known) {
    process.stdout.write(USAGE);
    return 0;
  }

  let machine: Machine | undefined;
  try {
    machine = openMachine(console);
    return await dispatch(command, rest, machine);
  } catch (error) {
    console.printError(error instanceof RosterError ? describeError(error) : `Unexpected error: ${describeError(error)}`);
    return 1;
  } finally {
    machine?.store.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
