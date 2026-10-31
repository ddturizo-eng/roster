// Projects: the registration file in git (plan 002 section 6, ADR 0018) and its cached row in the
// store (table `projects`, plan 002 section 5).

/** Content of `projects/<name>.json` on `origin/main` of the Roster repo. T09 validates it. */
export interface ProjectRegistration {
  readonly name: string;
  readonly repoPath: string;
  /** `https://github.com/<owner>/<repo>` */
  readonly remote: string;
  /** ADR 0032; default `main`. Always set after parsing. */
  readonly baseBranch: string;
  /** ADR 0032; default `agent`. Always set after parsing. */
  readonly branchPrefix: string;
  readonly setup: readonly string[];
  readonly verify: readonly string[];
  /** Added to the default dependency manifests of the policy; never removes a default. */
  readonly dependencyManifests: readonly string[];
  /** Added to the default protected paths of the policy; never removes a default. */
  readonly protectedPaths: readonly string[];
  readonly image: string;
}

/** Row of the `projects` table: a cache of the registration read from `origin/main`. */
export interface Project {
  readonly name: string;
  readonly repoPath: string;
  readonly remoteUrl: string;
  /** `<owner>/<repo>` */
  readonly ownerRepo: string;
  /** Roster repo commit the registration was read at. */
  readonly registrationCommit: string;
  /** ISO 8601 UTC. */
  readonly syncedAt: string;
}
