// Approval requests of plan 002 section 5 (table `approval_requests`), ADR 0024 and ADR 0025.

export const APPROVAL_KINDS = ['dependencies', 'protected_path'] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_RESOLUTIONS = ['approved', 'consumed'] as const;

/**
 * `approved`: the human approved the request (`roster retry --approve-dependencies`).
 * `consumed`: a successful execution used the approval; later manifest changes need a new one (T26).
 */
export type ApprovalResolution = (typeof APPROVAL_RESOLUTIONS)[number];

/** Changed dependency manifests found by the policy check (ADR 0024). */
export interface DependenciesApprovalDetail {
  readonly kind: 'dependencies';
  readonly manifests: readonly string[];
  readonly diff: string;
}

/** Protected or disallowed paths found by the policy check, and the local branch (ADR 0025). */
export interface ProtectedPathApprovalDetail {
  readonly kind: 'protected_path';
  readonly paths: readonly string[];
  readonly branch: string;
}

export type ApprovalDetail = DependenciesApprovalDetail | ProtectedPathApprovalDetail;

/** Row of the `approval_requests` table. */
export interface ApprovalRequest {
  readonly id: number;
  readonly taskId: string;
  readonly kind: ApprovalKind;
  /** Parsed `detail_json`; its `kind` equals `kind`. */
  readonly detail: ApprovalDetail;
  /** SHA-256 of the manifests for `dependencies`; null for `protected_path`. */
  readonly contentHash: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: ApprovalResolution | null;
}
