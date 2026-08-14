import { validateChangeSet } from "../midi/edits.js";
import { DeterministicCandidateEvaluator } from "./evaluator.js";
import { parseProposedChangeSet } from "./schema.js";
import type {
  AgentProvider,
  CandidateEvaluator,
  GoalBudget,
  GoalCandidate,
  GoalRequest,
  GoalRunDiagnostic,
  GoalRunResult,
  PreviousCandidateSummary,
  ProposedChangeSet,
} from "./types.js";

export const DEFAULT_GOAL_BUDGET: Readonly<GoalBudget> = {
  maxIterations: 3,
  maxDurationMs: 30_000,
  maxCostUnits: 3,
  targetCandidateCount: 3,
};

export interface GoalRunnerOptions {
  budget?: Partial<GoalBudget>;
  evaluator?: CandidateEvaluator;
  now?: () => number;
  maximumOperationsPerCandidate?: number;
  maximumAffectedNotesPerCandidate?: number;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeBudget(input: Partial<GoalBudget> | undefined): GoalBudget {
  return {
    maxIterations: normalizePositiveInteger(input?.maxIterations, DEFAULT_GOAL_BUDGET.maxIterations),
    maxDurationMs: normalizePositiveNumber(input?.maxDurationMs, DEFAULT_GOAL_BUDGET.maxDurationMs),
    maxCostUnits: normalizePositiveNumber(input?.maxCostUnits, DEFAULT_GOAL_BUDGET.maxCostUnits),
    targetCandidateCount: normalizePositiveInteger(
      input?.targetCandidateCount,
      DEFAULT_GOAL_BUDGET.targetCandidateCount,
    ),
  };
}

function diagnosticFromError(
  code: string,
  error: unknown,
  iteration: number,
  candidateId?: string,
): GoalRunDiagnostic {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    iteration,
    candidateId,
  };
}

export class GoalRunner {
  private readonly budget: GoalBudget;
  private readonly evaluator: CandidateEvaluator;
  private readonly now: () => number;
  private readonly maximumOperationsPerCandidate: number;
  private readonly maximumAffectedNotesPerCandidate: number;

  constructor(
    private readonly provider: AgentProvider,
    options: GoalRunnerOptions = {},
  ) {
    this.budget = normalizeBudget(options.budget);
    this.evaluator = options.evaluator ?? new DeterministicCandidateEvaluator();
    this.now = options.now ?? Date.now;
    this.maximumOperationsPerCandidate = options.maximumOperationsPerCandidate ?? 500;
    this.maximumAffectedNotesPerCandidate = options.maximumAffectedNotesPerCandidate ?? 10_000;
  }

  async run(request: GoalRequest, signal?: AbortSignal): Promise<GoalRunResult> {
    const startTime = this.now();
    let iterations = 0;
    let usedCostUnits = 0;
    const diagnostics: GoalRunDiagnostic[] = [];
    const byId = new Map<string, GoalCandidate>();
    let providerFailed = false;
    let deadlineExceeded = false;

    while (iterations < this.budget.maxIterations) {
      const elapsed = Math.max(0, this.now() - startTime);
      if (
        signal?.aborted ||
        elapsed >= this.budget.maxDurationMs ||
        usedCostUnits >= this.budget.maxCostUnits ||
        byId.size >= this.budget.targetCandidateCount
      ) {
        break;
      }

      const iteration = iterations + 1;
      iterations = iteration;
      let response;
      try {
        response = await invokeWithDeadline(
          this.provider,
          {
            requestId: request.requestId,
            mode: "goal",
            objective: request.objective,
            project: request.project,
            constraints: request.constraints,
            iteration,
            maxCandidates: this.budget.targetCandidateCount - byId.size,
            previousCandidates: [...byId.values()].map<PreviousCandidateSummary>((candidate) => ({
              id: candidate.changeSet.id,
              summary: candidate.changeSet.summary,
              score: candidate.score.overall,
            })),
            remainingBudget: {
              iterations: this.budget.maxIterations - iterations,
              durationMs: Math.max(0, this.budget.maxDurationMs - elapsed),
              costUnits: Math.max(0, this.budget.maxCostUnits - usedCostUnits),
            },
          },
          signal,
          Math.max(1, this.budget.maxDurationMs - elapsed),
        );
      } catch (error) {
        if (signal?.aborted) break;
        if (error instanceof GoalDeadlineError) {
          diagnostics.push({
            code: "TIME_BUDGET_EXHAUSTED",
            message: "The provider call exceeded the remaining goal time budget.",
            iteration,
          });
          deadlineExceeded = true;
          break;
        }
        diagnostics.push(diagnosticFromError("PROVIDER_ERROR", error, iteration));
        providerFailed = true;
        break;
      }
      const reportedCost = response.usage?.costUnits ?? 1;
      if (!Number.isFinite(reportedCost) || reportedCost < 0) {
        diagnostics.push({
          code: "INVALID_PROVIDER_USAGE",
          message: "Provider returned an invalid cost value; the iteration was charged one unit.",
          iteration,
        });
        usedCostUnits += 1;
      } else {
        usedCostUnits += reportedCost;
      }

      for (const rawChangeSet of response.proposedChangeSets ?? []) {
        let parsed: ProposedChangeSet;
        try {
          parsed = parseProposedChangeSet(rawChangeSet);
        } catch (error) {
          diagnostics.push(diagnosticFromError("INVALID_CANDIDATE_SCHEMA", error, iteration));
          continue;
        }

        const domainValidation = validateChangeSet(request.project, parsed, {
          maximumOperations: this.maximumOperationsPerCandidate,
          maximumAffectedNotes: this.maximumAffectedNotesPerCandidate,
        });
        const validated: ProposedChangeSet = {
          ...parsed,
          validation: [...parsed.validation, domainValidation],
          estimatedAffectedNotes: domainValidation.affectedNotes,
        };
        if (!domainValidation.valid) {
          diagnostics.push({
            code: "INVALID_CANDIDATE_DOMAIN",
            message: domainValidation.issues.map((issue) => issue.message).join(" "),
            iteration,
            candidateId: parsed.id,
          });
          continue;
        }

        const candidate: GoalCandidate = {
          changeSet: validated,
          score: this.evaluator.evaluate(validated),
          iteration,
        };
        const previous = byId.get(parsed.id);
        if (!previous || candidate.score.overall > previous.score.overall) {
          byId.set(parsed.id, candidate);
        }
        if (byId.size >= this.budget.targetCandidateCount) break;
      }
    }

    const elapsedMs = Math.max(0, this.now() - startTime);
    const cancelled = Boolean(signal?.aborted);
    const exhausted =
      !cancelled &&
      !providerFailed &&
      byId.size < this.budget.targetCandidateCount &&
      (deadlineExceeded ||
        iterations >= this.budget.maxIterations ||
        elapsedMs >= this.budget.maxDurationMs ||
        usedCostUnits >= this.budget.maxCostUnits);

    return {
      status: cancelled
        ? "cancelled"
        : providerFailed
          ? "provider_error"
          : exhausted
            ? "budget_exhausted"
            : "completed",
      candidates: [...byId.values()]
        .sort((left, right) =>
          right.score.overall - left.score.overall ||
          left.changeSet.id.localeCompare(right.changeSet.id),
        )
        .slice(0, this.budget.targetCandidateCount),
      iterations,
      elapsedMs,
      usedCostUnits,
      diagnostics,
    };
  }
}

class GoalDeadlineError extends Error {
  constructor() {
    super("Goal time budget exhausted.");
    this.name = "GoalDeadlineError";
  }
}

async function invokeWithDeadline(
  provider: AgentProvider,
  request: Parameters<AgentProvider["generate"]>[0],
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Awaited<ReturnType<AgentProvider["generate"]>>> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let outerAbortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(new GoalDeadlineError());
      reject(new GoalDeadlineError());
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (!outerSignal) return;
    outerAbortListener = () => {
      const reason = outerSignal.reason ?? new DOMException("Aborted", "AbortError");
      controller.abort(reason);
      reject(reason);
    };
    if (outerSignal.aborted) outerAbortListener();
    else outerSignal.addEventListener("abort", outerAbortListener, { once: true });
  });
  try {
    return await Promise.race([
      provider.generate(request, controller.signal),
      deadline,
      cancellation,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (outerSignal && outerAbortListener) {
      outerSignal.removeEventListener("abort", outerAbortListener);
    }
  }
}
