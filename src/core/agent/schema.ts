import type {
  MidiEditOperation,
  ValidationIssue,
  ValidationResult,
} from "../../shared/midi.js";
import type { ProposedChangeSet } from "./types.js";

export interface SchemaIssue {
  path: string;
  message: string;
}

export class ChangeSetSchemaError extends Error {
  readonly code = "INVALID_PROPOSED_CHANGE_SET";

  constructor(readonly issues: readonly SchemaIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ChangeSetSchemaError";
  }
}

const OPERATION_TYPES = new Set([
  "insert_notes",
  "delete_notes",
  "update_notes",
  "create_track",
  "delete_track",
  "update_track",
  "set_tempo",
  "set_time_signature",
  "set_loop",
  "clear_loop",
]);

const TRACK_ROLES = new Set(["melody", "harmony", "bass", "drums", "other"]);
const SEVERITIES = new Set(["warning", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integerInRange(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function validateNote(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
  requireId = false,
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  if (requireId && !nonEmptyString(value.id)) {
    issues.push({ path: `${path}.id`, message: "must be a non-empty string" });
  }
  if (!integerInRange(value.pitch, 0, 127)) {
    issues.push({ path: `${path}.pitch`, message: "must be an integer from 0 to 127" });
  }
  if (!integerInRange(value.startTick, 0, Number.MAX_SAFE_INTEGER)) {
    issues.push({ path: `${path}.startTick`, message: "must be a non-negative integer" });
  }
  if (!integerInRange(value.durationTicks, 1, Number.MAX_SAFE_INTEGER)) {
    issues.push({ path: `${path}.durationTicks`, message: "must be a positive integer" });
  }
  if (!integerInRange(value.velocity, 1, 127)) {
    issues.push({ path: `${path}.velocity`, message: "must be an integer from 1 to 127" });
  }
}

function validateTrackId(operation: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  if (!nonEmptyString(operation.trackId)) {
    issues.push({ path: `${path}.trackId`, message: "must be a non-empty string" });
  }
}

function validateOperation(value: unknown, index: number, issues: SchemaIssue[]): void {
  const path = `operations[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  if (!nonEmptyString(value.type) || !OPERATION_TYPES.has(value.type)) {
    issues.push({ path: `${path}.type`, message: "is not a supported operation type" });
    return;
  }

  switch (value.type) {
    case "insert_notes": {
      validateTrackId(value, path, issues);
      if (!Array.isArray(value.notes) || value.notes.length === 0) {
        issues.push({ path: `${path}.notes`, message: "must contain at least one note" });
      } else {
        value.notes.forEach((note, noteIndex) =>
          validateNote(note, `${path}.notes[${noteIndex}]`, issues),
        );
      }
      break;
    }
    case "delete_notes": {
      validateTrackId(value, path, issues);
      if (
        !Array.isArray(value.noteIds) ||
        value.noteIds.length === 0 ||
        value.noteIds.some((id) => !nonEmptyString(id))
      ) {
        issues.push({ path: `${path}.noteIds`, message: "must contain non-empty note ids" });
      }
      break;
    }
    case "update_notes": {
      validateTrackId(value, path, issues);
      if (!Array.isArray(value.changes) || value.changes.length === 0) {
        issues.push({ path: `${path}.changes`, message: "must contain at least one change" });
        break;
      }
      value.changes.forEach((change, changeIndex) => {
        const changePath = `${path}.changes[${changeIndex}]`;
        if (!isRecord(change)) {
          issues.push({ path: changePath, message: "must be an object" });
          return;
        }
        const noteId = change.noteId ?? change.id;
        if (!nonEmptyString(noteId)) {
          issues.push({ path: `${changePath}.noteId`, message: "must be a non-empty string" });
        }
        const patch = isRecord(change.patch) ? change.patch : change;
        const editableKeys = ["pitch", "startTick", "durationTicks", "velocity"];
        if (!editableKeys.some((key) => patch[key] !== undefined)) {
          issues.push({ path: changePath, message: "must change at least one note property" });
          return;
        }
        if (patch.pitch !== undefined && !integerInRange(patch.pitch, 0, 127)) {
          issues.push({ path: `${changePath}.pitch`, message: "must be an integer from 0 to 127" });
        }
        if (patch.startTick !== undefined && !integerInRange(patch.startTick, 0, Number.MAX_SAFE_INTEGER)) {
          issues.push({ path: `${changePath}.startTick`, message: "must be a non-negative integer" });
        }
        if (patch.durationTicks !== undefined && !integerInRange(patch.durationTicks, 1, Number.MAX_SAFE_INTEGER)) {
          issues.push({ path: `${changePath}.durationTicks`, message: "must be a positive integer" });
        }
        if (patch.velocity !== undefined && !integerInRange(patch.velocity, 1, 127)) {
          issues.push({ path: `${changePath}.velocity`, message: "must be an integer from 1 to 127" });
        }
      });
      break;
    }
    case "create_track": {
      if (!isRecord(value.track)) {
        issues.push({ path: `${path}.track`, message: "must be an object" });
        break;
      }
      if (!nonEmptyString(value.track.name)) {
        issues.push({ path: `${path}.track.name`, message: "must be a non-empty string" });
      }
      if (value.track.role !== undefined && !TRACK_ROLES.has(String(value.track.role))) {
        issues.push({ path: `${path}.track.role`, message: "must be a supported track role" });
      }
      if (value.track.channel !== undefined && !integerInRange(value.track.channel, 0, 15)) {
        issues.push({ path: `${path}.track.channel`, message: "must be an integer from 0 to 15" });
      }
      if (value.track.program !== undefined && !integerInRange(value.track.program, 0, 127)) {
        issues.push({ path: `${path}.track.program`, message: "must be an integer from 0 to 127" });
      }
      if (value.track.notes !== undefined) {
        if (!Array.isArray(value.track.notes)) {
          issues.push({ path: `${path}.track.notes`, message: "must be an array" });
        } else {
          value.track.notes.forEach((note, noteIndex) =>
            validateNote(note, `${path}.track.notes[${noteIndex}]`, issues, true),
          );
        }
      }
      break;
    }
    case "delete_track": {
      validateTrackId(value, path, issues);
      break;
    }
    case "update_track": {
      validateTrackId(value, path, issues);
      if (!isRecord(value.changes)) {
        issues.push({ path: `${path}.changes`, message: "must be an object" });
        break;
      }
      const changes = value.changes;
      const allowed = ["name", "role", "channel", "program", "muted", "solo"];
      if (!allowed.some((key) => changes[key] !== undefined)) {
        issues.push({ path: `${path}.changes`, message: "must update at least one track property" });
      }
      if (changes.name !== undefined && !nonEmptyString(changes.name)) {
        issues.push({ path: `${path}.changes.name`, message: "must be a non-empty string" });
      }
      if (changes.role !== undefined && !TRACK_ROLES.has(String(changes.role))) {
        issues.push({ path: `${path}.changes.role`, message: "must be a supported track role" });
      }
      if (changes.channel !== undefined && !integerInRange(changes.channel, 0, 15)) {
        issues.push({ path: `${path}.changes.channel`, message: "must be an integer from 0 to 15" });
      }
      if (changes.program !== undefined && !integerInRange(changes.program, 0, 127)) {
        issues.push({ path: `${path}.changes.program`, message: "must be an integer from 0 to 127" });
      }
      if (changes.muted !== undefined && typeof changes.muted !== "boolean") {
        issues.push({ path: `${path}.changes.muted`, message: "must be a boolean" });
      }
      if (changes.solo !== undefined && typeof changes.solo !== "boolean") {
        issues.push({ path: `${path}.changes.solo`, message: "must be a boolean" });
      }
      break;
    }
    case "set_tempo": {
      if (!integerInRange(value.tick, 0, Number.MAX_SAFE_INTEGER)) {
        issues.push({ path: `${path}.tick`, message: "must be a non-negative integer" });
      }
      if (!finiteNumber(value.bpm) || value.bpm < 20 || value.bpm > 400) {
        issues.push({ path: `${path}.bpm`, message: "must be from 20 to 400" });
      }
      break;
    }
    case "set_time_signature": {
      if (!integerInRange(value.tick, 0, Number.MAX_SAFE_INTEGER)) {
        issues.push({ path: `${path}.tick`, message: "must be a non-negative integer" });
      }
      if (!integerInRange(value.numerator, 1, 32)) {
        issues.push({ path: `${path}.numerator`, message: "must be an integer from 1 to 32" });
      }
      if (![1, 2, 4, 8, 16, 32].includes(Number(value.denominator))) {
        issues.push({ path: `${path}.denominator`, message: "must be a supported power of two" });
      }
      break;
    }
    case "set_loop": {
      if (!integerInRange(value.startTick, 0, Number.MAX_SAFE_INTEGER)) {
        issues.push({ path: `${path}.startTick`, message: "must be a non-negative integer" });
      }
      if (!integerInRange(value.endTick, 1, Number.MAX_SAFE_INTEGER)) {
        issues.push({ path: `${path}.endTick`, message: "must be a positive integer" });
      } else if (finiteNumber(value.startTick) && Number(value.endTick) <= value.startTick) {
        issues.push({ path: `${path}.endTick`, message: "must be greater than startTick" });
      }
      break;
    }
    case "clear_loop":
      break;
  }
}

function parseValidationIssue(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): ValidationIssue | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  if (!nonEmptyString(value.code)) {
    issues.push({ path: `${path}.code`, message: "must be a non-empty string" });
  }
  if (!nonEmptyString(value.message)) {
    issues.push({ path: `${path}.message`, message: "must be a non-empty string" });
  }
  if (typeof value.severity !== "string" || !SEVERITIES.has(value.severity)) {
    issues.push({ path: `${path}.severity`, message: "must be warning or error" });
  }
  if (value.operationIndex !== undefined && !integerInRange(value.operationIndex, 0, Number.MAX_SAFE_INTEGER)) {
    issues.push({ path: `${path}.operationIndex`, message: "must be a non-negative integer" });
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    issues.push({ path: `${path}.path`, message: "must be a string" });
  }
  return value as unknown as ValidationIssue;
}

function parseValidation(value: unknown, index: number, issues: SchemaIssue[]): ValidationResult | undefined {
  const path = `validation[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  if (typeof value.valid !== "boolean") {
    issues.push({ path: `${path}.valid`, message: "must be a boolean" });
  }
  const parsedIssues: ValidationIssue[] = [];
  if (!Array.isArray(value.issues)) {
    issues.push({ path: `${path}.issues`, message: "must be an array" });
  } else {
    value.issues.forEach((issue, issueIndex) => {
      const parsed = parseValidationIssue(issue, `${path}.issues[${issueIndex}]`, issues);
      if (parsed) parsedIssues.push(parsed);
    });
  }
  if (!integerInRange(value.affectedNotes, 0, Number.MAX_SAFE_INTEGER)) {
    issues.push({ path: `${path}.affectedNotes`, message: "must be a non-negative integer" });
  }
  return {
    valid: value.valid as boolean,
    issues: parsedIssues,
    affectedNotes: value.affectedNotes as number,
  };
}

export function parseProposedChangeSet(input: unknown): ProposedChangeSet {
  const issues: SchemaIssue[] = [];
  if (!isRecord(input)) {
    throw new ChangeSetSchemaError([{ path: "$", message: "must be an object" }]);
  }
  if (!nonEmptyString(input.id)) {
    issues.push({ path: "id", message: "must be a non-empty string" });
  }
  if (!nonEmptyString(input.summary)) {
    issues.push({ path: "summary", message: "must be a non-empty string" });
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    issues.push({ path: "operations", message: "must contain at least one operation" });
  } else if (input.operations.length > 10_000) {
    issues.push({ path: "operations", message: "must not exceed 10,000 operations" });
  } else {
    input.operations.forEach((operation, index) => validateOperation(operation, index, issues));
  }
  const parsedValidation: ValidationResult[] = [];
  if (!Array.isArray(input.validation)) {
    issues.push({ path: "validation", message: "must be an array" });
  } else {
    input.validation.forEach((item, index) => {
      const parsed = parseValidation(item, index, issues);
      if (parsed) parsedValidation.push(parsed);
    });
  }
  if (!integerInRange(input.estimatedAffectedNotes, 0, Number.MAX_SAFE_INTEGER)) {
    issues.push({ path: "estimatedAffectedNotes", message: "must be a non-negative integer" });
  }
  if (issues.length > 0) {
    throw new ChangeSetSchemaError(issues);
  }

  return {
    id: input.id as string,
    summary: input.summary as string,
    operations: [...(input.operations as unknown as MidiEditOperation[])],
    validation: parsedValidation,
    estimatedAffectedNotes: input.estimatedAffectedNotes as number,
  };
}

export function isProposedChangeSet(input: unknown): input is ProposedChangeSet {
  try {
    parseProposedChangeSet(input);
    return true;
  } catch {
    return false;
  }
}
