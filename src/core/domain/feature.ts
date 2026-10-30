// Feature lifecycle stages and steps (ADR 0020) and the feature rows of the store (plan 002 section 5).

export const STAGES = ['idea', 'analysis', 'spec_approved', 'plan_approved', 'execution', 'delivered'] as const;

export type Stage = (typeof STAGES)[number];

/** Steps inside each stage, in the order of ADR 0020. */
export const STAGE_STEPS = {
  idea: ['recorded'],
  analysis: ['questions_pending', 'answers_recorded', 'drafting', 'spec_pr_open'],
  spec_approved: ['plan_job_pending', 'plan_running', 'plan_pr_open'],
  plan_approved: ['importing', 'import_failed'],
  execution: ['running'],
  delivered: ['done'],
} as const satisfies { readonly [S in Stage]: readonly string[] };

export type StepOf<S extends Stage> = (typeof STAGE_STEPS)[S][number];

export type Step = StepOf<Stage>;

/** True when `step` belongs to `stage` in ADR 0020. */
export function isStepOf(stage: Stage, step: string): step is Step {
  return (STAGE_STEPS[stage] as readonly string[]).includes(step);
}

/** Row of the `features` table. */
export interface Feature {
  /** `<project>:<NNN>` */
  readonly id: string;
  readonly project: string;
  /** `NNN` */
  readonly number: string;
  readonly slug: string;
  readonly stage: Stage;
  readonly step: Step;
  readonly ideaText: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Row of the `feature_events` table: one per transition, with its evidence. */
export interface FeatureEvent {
  readonly id: number;
  readonly featureId: string;
  readonly fromStage: Stage | null;
  readonly toStage: Stage;
  readonly step: Step;
  readonly at: string;
  readonly prUrl: string | null;
  readonly mergedAt: string | null;
  readonly evidenceCommit: string | null;
  readonly reason: string | null;
}

/** Row of the `grilling` table. Answers are recorded as typed. */
export interface GrillingEntry {
  readonly id: number;
  readonly featureId: string;
  readonly round: number;
  readonly questionHuman: string;
  readonly questionEn: string;
  readonly answerHuman: string | null;
  readonly askedAt: string;
  readonly answeredAt: string | null;
}
