// English templates, also the fallback for any unsupported `human_language`.

import type { Catalog } from './catalog.ts';

const list = (items: readonly string[]): string => items.join(', ');

export const EN: Catalog = {
  'stop.invalidResult': ({ contract, problems }) =>
    `The ${contract} result is missing or invalid: ${list(problems)}.`,
  'stop.noChanges': () => 'The agent finished without changing any file.',
  'stop.protectedPath': ({ paths, branch, workspace }) =>
    `The changes touch protected or disallowed paths: ${list(paths)}. ` +
    `The commit is kept on local branch ${branch} in ${workspace}. Nothing was pushed; only the human may push it.`,
  'stop.dependencyApproval': ({ manifests, hash, task }) =>
    `Dependency manifests changed: ${list(manifests)} (hash ${hash}). Nothing was pushed. ` +
    `Review the change and approve it with: roster retry ${task} --approve-dependencies`,
  'stop.verificationFailed': ({ command, exitCode, branch, tail }) =>
    `Verification failed: ${command} exited with code ${exitCode === null ? 'none' : exitCode}. ` +
    `The branch ${branch} is pushed without a PR.` +
    (tail === '' ? '' : `\nLast lines:\n${tail}`),
  'stop.timeout': ({ job, minutes }) => `The ${job} job reached its time limit of ${minutes} minutes.`,
  'stop.error': ({ job, reason }) => `The ${job} job failed: ${reason}.`,
  'stop.interrupted': () =>
    'The execution was interrupted: the roster run process ended before it finished.',
  'stop.stopped': () => 'Stopped by the human with roster stop. Nothing was pushed; the workspace is kept.',
  'stop.dockerUnavailable': ({ reason }) =>
    `Docker is not reachable: ${reason}. Start Docker Desktop and check with roster doctor.`,
  'stop.quotaCooldown': ({ runtime, branch, until, window }) =>
    `The ${runtime} quota is exhausted. Work in progress was pushed to ${branch} and the task is back in todo. ` +
    (window === null
      ? `No runs on ${runtime} until ${until} (estimated).`
      : `No runs on ${runtime} until ${until}, when the ${window} window resets.`),
  'stop.hirePrOpened': ({ agent, prUrl }) =>
    `Waiting for the hire PR of agent ${agent}: ${prUrl}. Merge it to continue the task.`,
  'stop.prClosedUnmerged': ({ prUrl, task }) =>
    `The PR ${prUrl} was closed without merging; the task is rejected. To try again: roster retry ${task}`,

  'run.busy': ({ pid }) => `Another roster process (PID ${pid}) holds the lock. Exiting.`,
  'run.recoveredInterrupted': ({ executionId }) =>
    `Execution ${executionId} was left running by a process that ended; marked interrupted.`,
  'run.nightLimitReached': ({ started, max }) =>
    `${started} of ${max} runs already started in this night window. Exiting.`,
  'run.dockerUnavailable': ({ reason }) => `Docker is not reachable: ${reason}. Exiting with code 2.`,
  'run.syncing': () => 'Syncing the Roster repo, projects and pull requests...',
  'run.syncDone': ({ projects, pullRequests }) =>
    `Sync done: ${projects} projects, ${pullRequests} pull requests checked.`,
  'run.nothingToDo': () => 'Nothing to do.',
  'run.selectedTask': ({ task, title }) => `Selected task ${task}: ${title}`,
  'run.selectedStageJob': ({ feature, job }) => `Selected the ${job} job of feature ${feature}.`,
  'run.hiring': ({ task }) => `Task ${task} has no approved agent; starting the hiring step.`,
  'run.agentReused': ({ agent, task }) => `Reusing approved agent ${agent} for task ${task}.`,
  'run.noRuntime': ({ agent }) =>
    `No runtime is available for agent ${agent} (not enabled, missing capabilities or in quota cooldown). Exiting.`,
  'run.runtimeCooldown': ({ runtime, until }) => `Runtime ${runtime} is in quota cooldown until ${until}.`,
  'run.executionStarted': ({ executionId, task, agent, runtime }) =>
    `Execution ${executionId} started: task ${task}, agent ${agent}, runtime ${runtime}.`,
  'run.resuming': ({ branch }) => `Resuming from the existing branch ${branch}.`,
  'run.stepStarted': ({ step }) => `Step: ${step}`,
  'run.prOpened': ({ prUrl }) => `PR opened: ${prUrl}`,
  'run.executionFinished': ({ executionId, status }) => `Execution ${executionId} finished: ${status}.`,
  'run.stopReason': ({ reason }) => `Reason: ${reason}`,
  'run.dryRun': () => 'Dry run: nothing is written except the sync cache.',
  'run.dryRunPlan': ({ steps }) => `Planned steps: ${list(steps)}.`,
};
