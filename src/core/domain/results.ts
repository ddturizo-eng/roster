// Result contracts of ADR 0026 (plan 002 section 14). Every agent job writes `/roster/out/result.json`;
// Roster validates it with `validateResult` (result-validators.ts) before doing anything else.
// All text is in English unless stated; free text is untrusted data, length-limited, and never
// interpreted as commands or paths.

export const SPECIALIST_STATUSES = ['done', 'blocked'] as const;
export const ANALYST_STATUSES = ['questions', 'done'] as const;
export const ARCHITECT_STATUSES = ['done', 'blocked'] as const;
export const REVIEW_VERDICTS = ['approve', 'comment', 'request_changes'] as const;
export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** A question for the human, written in `human_language`. */
export interface ResultQuestion {
  readonly text: string;
}

/** Contract `specialist`. `questions` is present and non-empty when `status` is `blocked`. */
export interface SpecialistResult {
  readonly status: (typeof SPECIALIST_STATUSES)[number];
  readonly summary: string;
  readonly verification: string;
  readonly questions?: readonly ResultQuestion[];
  readonly notes?: string;
}

/** Contract `hr` (hr-director, ADR 0027). */
export interface HrResult {
  /** Agent slug, `^[a-z0-9-]+$` (ADR 0021). */
  readonly slug: string;
  readonly skills: readonly string[];
  readonly reason: string;
  readonly needsHuman: boolean;
}

/** An analyst question: `text` in `human_language`, `textEn` its English translation. */
export interface AnalystQuestion {
  readonly id: string;
  readonly text: string;
  readonly textEn: string;
}

/** Contract `analyst`. `questions` is present and non-empty when `status` is `questions`. */
export interface AnalystResult {
  readonly status: (typeof ANALYST_STATUSES)[number];
  readonly questions?: readonly AnalystQuestion[];
  readonly summary?: string;
}

/** Contract `architect`. `questions` is present and non-empty when `status` is `blocked`. */
export interface ArchitectResult {
  readonly status: (typeof ARCHITECT_STATUSES)[number];
  readonly summary: string;
  /** Paths of the ADRs written or changed. Display data only. */
  readonly adrs: readonly string[];
  readonly questions?: readonly ResultQuestion[];
}

export interface ReviewFinding {
  readonly severity: FindingSeverity;
  /** Display data only; never used to open a file. */
  readonly path?: string;
  readonly line?: number;
  readonly text: string;
}

/** Contract `reviewer` (code-reviewer). */
export interface ReviewerResult {
  readonly verdict: (typeof REVIEW_VERDICTS)[number];
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface ResultByContract {
  readonly specialist: SpecialistResult;
  readonly hr: HrResult;
  readonly analyst: AnalystResult;
  readonly architect: ArchitectResult;
  readonly reviewer: ReviewerResult;
}

/** Length limits, in UTF-16 code units, and item limits of the result contracts. */
export const RESULT_LIMITS = {
  /** Whole `result.json` text, checked by `parseResult` before parsing. */
  fileLength: 256 * 1024,
  summary: 4000,
  verification: 4000,
  notes: 4000,
  questionText: 2000,
  questionId: 64,
  questions: 20,
  slug: 64,
  skillName: 100,
  skills: 20,
  reason: 2000,
  adrPath: 300,
  adrs: 50,
  findingText: 2000,
  findingPath: 500,
  findings: 200,
} as const;
