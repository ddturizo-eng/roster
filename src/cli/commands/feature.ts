// `roster feature import <project> <NNN-slug>` (plan 002 section 7.3, ADR 0019): fetches, reads the
// registrations, and adopts the feature (or re-imports its `tasks.md`) from `origin/<baseBranch>`.
// `feature new` belongs to a later task.

import { formatTasksMdIssue } from '../../core/dag/issue.ts';
import { importFeature } from '../../core/orchestrator/import.ts';
import type { ImportDeps, ImportRejection, ImportSuccess } from '../../core/orchestrator/import.ts';
import { readProjects } from '../../core/orchestrator/projects.ts';
import type { RegistryDeps } from '../../core/orchestrator/projects.ts';
import type { ConsolePort } from '../../ports/console.ts';
import { describeError } from '../describe-error.ts';

export const FEATURE_USAGE = 'Usage: roster feature import <project> <NNN-slug>';

export interface FeatureCommandDeps extends ImportDeps, RegistryDeps {
  readonly console: ConsolePort;
}

function rejectionLines(rejection: ImportRejection): string[] {
  switch (rejection.reason) {
    case 'invalid_feature_name':
      return ['The feature name must look like NNN-slug, for example 002-local-core.'];
    case 'files_missing':
      return [`Not on ${rejection.ref}: ${rejection.missing.join(', ')}.`];
    case 'invalid_tasks':
      return ['tasks.md has errors:', ...rejection.errors.map((issue) => `  ${formatTasksMdIssue(issue)}`)];
    case 'feature_not_in_execution':
      return [`The feature is in stage ${rejection.stage}, not execution; its stages move through the gates, not through import.`];
    case 'reimport_blocked':
      return [
        'Re-import rejected: tasks that are running or in review were removed from tasks.md:',
        ...rejection.blockers.map((blocker) => `  ${blocker.key} (${blocker.status})`),
      ];
  }
}

function successLines(result: ImportSuccess): string[] {
  const keys = (label: string, list: readonly string[]): string[] => (list.length === 0 ? [] : [`  ${label}: ${list.join(', ')}`]);
  return [
    `${result.mode === 'created' ? 'Imported' : 'Re-imported'} ${result.featureId} from commit ${result.commit}.`,
    ...keys('added', result.added),
    ...keys('added already done', result.addedDone),
    ...keys('updated', result.updated),
    ...keys('cancelled', result.cancelled),
    ...keys('text changed, state kept', result.textChanged),
    ...keys('removed, done kept', result.removedKept),
    ...result.warnings.map((issue) => `  warning ${formatTasksMdIssue(issue)}`),
    ...result.reimportWarnings.map((warning) => `  warning ${warning.key}: ${warning.code}`),
  ];
}

/** Returns 0 on a successful import, 1 on a usage error, an unknown project or a rejected import. */
export async function runFeature(args: readonly string[], deps: FeatureCommandDeps): Promise<number> {
  const out = deps.console;
  const [action, projectName, featureName, ...rest] = args;
  if (action !== 'import' || projectName === undefined || featureName === undefined || rest.length > 0) {
    out.printError(FEATURE_USAGE);
    return 1;
  }
  try {
    await deps.vcs.fetch(deps.rosterRepoPath);
    const registry = await readProjects(deps);
    const loaded = registry.projects.find((candidate) => candidate.project.name === projectName);
    if (loaded === undefined) {
      out.printError(`Project ${projectName} is not registered at origin/main of the Roster repo, or its registration is invalid.`);
      for (const issue of registry.issues.filter((candidate) => candidate.file === `projects/${projectName}.json`)) {
        out.printError(`${issue.file}: ${issue.field} ${issue.message}`);
      }
      return 1;
    }
    if (!loaded.isRosterRepo) await deps.vcs.fetch(loaded.project.repoPath);
    const result = await importFeature(deps, loaded, featureName);
    if (!result.ok) {
      for (const line of rejectionLines(result)) out.printError(line);
      return 1;
    }
    for (const line of successLines(result)) out.print(line);
    return 0;
  } catch (error) {
    out.printError(`Import failed: ${describeError(error)}`);
    return 1;
  }
}
