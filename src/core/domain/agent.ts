// AgentDefinition v2 (ADR 0021): capabilities, runtimes and an output contract.

/** Runtime-neutral capabilities. `read` is always implied. */
export const CAPABILITIES = ['read', 'edit', 'shell', 'web'] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Result contracts of ADR 0026. */
export const CONTRACT_NAMES = ['specialist', 'hr', 'analyst', 'architect', 'reviewer'] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

/** A parsed `agents/<slug>.md`. T05 builds it from v2 frontmatter or from a v1 file. */
export interface AgentDefinition {
  /** 2 for `schema: roster/agent@2`, 1 for a legacy file without `schema`. */
  readonly schemaVersion: 1 | 2;
  /** Equals the file slug. */
  readonly name: string;
  readonly description: string;
  /** Always contains `read`. */
  readonly capabilities: readonly Capability[];
  /** Skills approved in `skills/registry.md`. */
  readonly skills: readonly string[];
  /** Runtime names in preference order. */
  readonly runtimes: readonly string[];
  readonly contract: ContractName;
  /** `model.<runtime>` hints, keyed by runtime name. */
  readonly models: Readonly<Record<string, string>>;
  readonly maxTurns?: number;
  readonly timeoutMinutes?: number;
  /** Markdown after the frontmatter: the agent's instructions. */
  readonly body: string;
}
