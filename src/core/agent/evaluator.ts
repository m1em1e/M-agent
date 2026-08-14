import type { CandidateEvaluator, CandidateScore, ProposedChangeSet } from "./types.js";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** A provider-independent, deterministic baseline score for candidate ordering. */
export class DeterministicCandidateEvaluator implements CandidateEvaluator {
  evaluate(changeSet: Readonly<ProposedChangeSet>): CandidateScore {
    const errorCount = changeSet.validation.reduce(
      (total, result) =>
        total + result.issues.filter((issue) => issue.severity === "error").length,
      0,
    );
    const warningCount = changeSet.validation.reduce(
      (total, result) =>
        total + result.issues.filter((issue) => issue.severity === "warning").length,
      0,
    );
    const schema = 100;
    const safety = clamp(100 - errorCount * 40 - warningCount * 8);
    const coverage = clamp(
      50 + Math.min(changeSet.operations.length, 10) * 3 +
        Math.min(changeSet.estimatedAffectedNotes, 50),
    );
    return {
      schema,
      safety,
      coverage,
      overall: clamp(schema * 0.25 + safety * 0.5 + coverage * 0.25),
    };
  }
}
