import type {
  MidiEditOperation,
  MidiProject,
  ProposedChangeSet as SharedProposedChangeSet,
  ValidationResult,
} from "../../shared/midi.js";

export const AGENT_MODES = ["research", "plan", "goal"] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * Every capability exposed to a model must have a name in this union. The
 * permission gate works on these capabilities instead of trusting a prompt.
 */
export const AGENT_TOOL_NAMES = [
  "project.read",
  "project.analyze",
  "playback.preview",
  "changes.propose",
  "changes.simulate",
  "changes.validate",
  "candidate.score",
  "changes.apply",
  "project.write",
  "midi.export",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface ProposedChangeSet extends SharedProposedChangeSet {
  operations: MidiEditOperation[];
  validation: ValidationResult[];
  estimatedAffectedNotes: number;
}

export interface ProviderUsage {
  /** Provider-neutral accounting unit. A cloud adapter may map this to cost. */
  costUnits: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface PreviousCandidateSummary {
  id: string;
  summary: string;
  score: number;
}

export interface AgentProviderRequest {
  requestId: string;
  mode: AgentMode;
  objective: string;
  project: Readonly<MidiProject>;
  iteration: number;
  maxCandidates: number;
  constraints?: Readonly<Record<string, unknown>>;
  previousCandidates: readonly PreviousCandidateSummary[];
  remainingBudget?: Readonly<{
    iterations: number;
    durationMs: number;
    costUnits: number;
  }>;
}

export interface AgentProviderResponse {
  analysis: string;
  proposedChangeSets?: readonly unknown[];
  usage?: ProviderUsage;
}

/** Implement this interface to add a local or cloud-backed model provider. */
export interface AgentProvider {
  readonly id: string;
  generate(
    request: Readonly<AgentProviderRequest>,
    signal?: AbortSignal,
  ): Promise<AgentProviderResponse>;
}

export interface CandidateScore {
  overall: number;
  schema: number;
  safety: number;
  coverage: number;
}

export interface GoalCandidate {
  changeSet: ProposedChangeSet;
  score: CandidateScore;
  iteration: number;
}

export interface GoalBudget {
  maxIterations: number;
  maxDurationMs: number;
  maxCostUnits: number;
  targetCandidateCount: number;
}

export type GoalRunStatus =
  | "completed"
  | "budget_exhausted"
  | "cancelled"
  | "provider_error";

export interface GoalRunDiagnostic {
  code: string;
  message: string;
  iteration?: number;
  candidateId?: string;
}

export interface GoalRunResult {
  status: GoalRunStatus;
  candidates: GoalCandidate[];
  iterations: number;
  elapsedMs: number;
  usedCostUnits: number;
  diagnostics: GoalRunDiagnostic[];
}

export interface GoalRequest {
  requestId: string;
  objective: string;
  project: Readonly<MidiProject>;
  constraints?: Readonly<Record<string, unknown>>;
}

export interface CandidateEvaluator {
  evaluate(changeSet: Readonly<ProposedChangeSet>): CandidateScore;
}
