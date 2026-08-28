import type {
  MidiEditOperation,
  NoteInput,
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
  "define_pattern",
  "arrange_pattern",
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

/** 有限数值范围（音符级可选属性的边界，允许小数）。 */
function numberInRange(value: unknown, min: number, max: number): boolean {
  return finiteNumber(value) && Number(value) >= min && Number(value) <= max;
}

/** 校验音色引用的结构（soundfont 需 libraryId/bank/program；sfz 需 libraryId）。 */
function isInstrumentReferenceLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "soundfont") {
    return typeof value.libraryId === "string" && value.libraryId.length > 0
      && integerInRange(value.bank, 0, 16_383)
      && integerInRange(value.program, 0, 127);
  }
  if (value.type === "sfz") {
    return typeof value.libraryId === "string" && value.libraryId.length > 0;
  }
  return false;
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
  if (value.pan !== undefined && !numberInRange(value.pan, -100, 100)) {
    issues.push({ path: `${path}.pan`, message: "must be a number from -100 to 100" });
  }
  if (value.release !== undefined && !numberInRange(value.release, 0, 2)) {
    issues.push({ path: `${path}.release`, message: "must be a number from 0 to 2" });
  }
  if (value.cutoffHz !== undefined && !numberInRange(value.cutoffHz, 0, 20_000)) {
    issues.push({ path: `${path}.cutoffHz`, message: "must be a number from 0 to 20000" });
  }
  if (value.resonanceQ !== undefined && !numberInRange(value.resonanceQ, 0, 16.5)) {
    issues.push({ path: `${path}.resonanceQ`, message: "must be a number from 0 to 16.5" });
  }
  if (value.finePitchCents !== undefined && !numberInRange(value.finePitchCents, -100, 100)) {
    issues.push({ path: `${path}.finePitchCents`, message: "must be a number from -100 to 100" });
  }
  if (value.sustainBeats !== undefined && !numberInRange(value.sustainBeats, 0, 8)) {
    issues.push({ path: `${path}.sustainBeats`, message: "must be a number from 0 to 8" });
  }
}

function validateTrackId(operation: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  if (!nonEmptyString(operation.trackId)) {
    issues.push({ path: `${path}.trackId`, message: "must be a non-empty string" });
  }
}

/** 轨级 CC 事件数组（controllerEvents）：id 可选，tick 非负、controller/value 0–127，长度 ≤ 4000。 */
function validateControllerEventsLike(value: unknown, path: string, issues: SchemaIssue[]): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (value.length > 4000) {
    issues.push({ path, message: "must have at most 4000 events" });
    return;
  }
  value.forEach((event, eventIndex) => {
    const eventPath = `${path}[${eventIndex}]`;
    if (!isRecord(event)) {
      issues.push({ path: eventPath, message: "must be an object" });
      return;
    }
    if (event.id !== undefined && !nonEmptyString(event.id)) {
      issues.push({ path: `${eventPath}.id`, message: "must be a non-empty string" });
    }
    if (!integerInRange(event.tick, 0, Number.MAX_SAFE_INTEGER)) {
      issues.push({ path: `${eventPath}.tick`, message: "must be a non-negative integer" });
    }
    if (!integerInRange(event.controller, 0, 127)) {
      issues.push({ path: `${eventPath}.controller`, message: "must be an integer from 0 to 127" });
    }
    if (!integerInRange(event.value, 0, 127)) {
      issues.push({ path: `${eventPath}.value`, message: "must be an integer from 0 to 127" });
    }
  });
}

/** 轨级弯音事件数组（pitchBends，0xE0）：id 可选，tick 非负、value -8192..8191，长度 ≤ 4000。 */
function validatePitchBendsLike(value: unknown, path: string, issues: SchemaIssue[]): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (value.length > 4000) {
    issues.push({ path, message: "must have at most 4000 events" });
    return;
  }
  value.forEach((event, eventIndex) => {
    const eventPath = `${path}[${eventIndex}]`;
    if (!isRecord(event)) {
      issues.push({ path: eventPath, message: "must be an object" });
      return;
    }
    if (event.id !== undefined && !nonEmptyString(event.id)) {
      issues.push({ path: `${eventPath}.id`, message: "must be a non-empty string" });
    }
    if (!integerInRange(event.tick, 0, Number.MAX_SAFE_INTEGER)) {
      issues.push({ path: `${eventPath}.tick`, message: "must be a non-negative integer" });
    }
    if (!integerInRange(event.value, -8192, 8191)) {
      issues.push({ path: `${eventPath}.value`, message: "must be an integer from -8192 to 8191" });
    }
  });
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
      if (value.track.id !== undefined && !nonEmptyString(value.track.id)) {
        issues.push({ path: `${path}.track.id`, message: "must be a non-empty string" });
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
      if (value.track.instrument !== undefined && value.track.instrument !== null && !isInstrumentReferenceLike(value.track.instrument)) {
        issues.push({ path: `${path}.track.instrument`, message: "must be a valid instrument reference or null" });
      }
      validateControllerEventsLike(value.track.controllerEvents, `${path}.track.controllerEvents`, issues);
      validatePitchBendsLike(value.track.pitchBends, `${path}.track.pitchBends`, issues);
      if (value.track.notes !== undefined) {
        if (!Array.isArray(value.track.notes)) {
          issues.push({ path: `${path}.track.notes`, message: "must be an array" });
        } else {
          // 音符 id 可选：应用层 createMidiNote 会自动生成，避免模型为大量音符逐一编 id
          // 而被迫缩小规模（此前强制要求 id 导致完整编排 payload 被拒）。
          value.track.notes.forEach((note, noteIndex) =>
            validateNote(note, `${path}.track.notes[${noteIndex}]`, issues),
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
      const allowed = ["name", "role", "channel", "program", "muted", "solo", "instrument", "controllerEvents", "pitchBends"];
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
      if (changes.instrument !== undefined && changes.instrument !== null && !isInstrumentReferenceLike(changes.instrument)) {
        issues.push({ path: `${path}.changes.instrument`, message: "must be a valid instrument reference or null" });
      }
      validateControllerEventsLike(changes.controllerEvents, `${path}.changes.controllerEvents`, issues);
      validatePitchBendsLike(changes.pitchBends, `${path}.changes.pitchBends`, issues);
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
    case "define_pattern": {
      if (!nonEmptyString(value.patternId)) {
        issues.push({ path: `${path}.patternId`, message: "must be a non-empty string" });
      }
      validateTrackId(value, path, issues);
      if (!integerInRange(value.lengthTicks, 1, Number.MAX_SAFE_INTEGER)) {
        issues.push({ path: `${path}.lengthTicks`, message: "must be a positive integer" });
      }
      if (!Array.isArray(value.notes) || value.notes.length === 0) {
        issues.push({ path: `${path}.notes`, message: "must contain at least one note" });
      } else {
        value.notes.forEach((note, noteIndex) =>
          validateNote(note, `${path}.notes[${noteIndex}]`, issues),
        );
      }
      break;
    }
    case "arrange_pattern": {
      validateTrackId(value, path, issues);
      if (!Array.isArray(value.parts) || value.parts.length === 0) {
        issues.push({ path: `${path}.parts`, message: "must contain at least one part" });
        break;
      }
      value.parts.forEach((part, partIndex) => {
        const partPath = `${path}.parts[${partIndex}]`;
        if (!isRecord(part)) {
          issues.push({ path: partPath, message: "must be an object" });
          return;
        }
        if (!nonEmptyString(part.patternId)) {
          issues.push({ path: `${partPath}.patternId`, message: "must be a non-empty string" });
        }
        if (!integerInRange(part.startTick, 0, Number.MAX_SAFE_INTEGER)) {
          issues.push({ path: `${partPath}.startTick`, message: "must be a non-negative integer" });
        }
        if (part.repeats !== undefined && !integerInRange(part.repeats, 1, 200)) {
          issues.push({ path: `${partPath}.repeats`, message: "must be an integer from 1 to 200" });
        }
        if (part.transpose !== undefined && !integerInRange(part.transpose, -127, 127)) {
          issues.push({ path: `${partPath}.transpose`, message: "must be an integer from -127 to 127" });
        }
        if (part.velocityOffset !== undefined && !integerInRange(part.velocityOffset, -127, 127)) {
          issues.push({ path: `${partPath}.velocityOffset`, message: "must be an integer from -127 to 127" });
        }
      });
      break;
    }
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

  const operations = expandPatternOperations(input.operations as unknown as MidiEditOperation[], issues);
  if (issues.length > 0) {
    throw new ChangeSetSchemaError(issues);
  }

  return {
    id: input.id as string,
    summary: input.summary as string,
    operations,
    validation: parsedValidation,
    estimatedAffectedNotes: input.estimatedAffectedNotes as number,
  };
}

/** 展开 define_pattern / arrange_pattern 为具体 insert_notes（应用变奏），下游只看到 insert_notes。 */
function expandPatternOperations(
  operations: MidiEditOperation[],
  issues: SchemaIssue[],
): MidiEditOperation[] {
  const patterns = new Map<string, { trackId: string; lengthTicks: number; notes: NoteInput[] }>();
  const expanded: MidiEditOperation[] = [];

  for (const operation of operations) {
    if (operation.type === "define_pattern") {
      if (patterns.has(operation.patternId)) {
        issues.push({ path: "operations", message: `重复的 patternId：${operation.patternId}` });
        continue;
      }
      patterns.set(operation.patternId, {
        trackId: operation.trackId,
        lengthTicks: operation.lengthTicks,
        notes: operation.notes,
      });
      continue;
    }
    if (operation.type === "arrange_pattern") {
      for (const part of operation.parts) {
        const pattern = patterns.get(part.patternId);
        if (!pattern) {
          issues.push({ path: "operations", message: `arrange_pattern 引用了未定义的 patternId：${part.patternId}` });
          continue;
        }
        const repeats = part.repeats ?? 1;
        for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
          const offset = part.startTick + repeatIndex * pattern.lengthTicks;
          const notes = applyPatternVariation(pattern.notes, repeatIndex, part);
          if (notes.length > 0) {
            const shifted = notes.map((note) => ({ ...note, startTick: note.startTick + offset }));
            expanded.push({ type: "insert_notes", trackId: pattern.trackId, notes: shifted });
          }
        }
      }
      continue;
    }
    expanded.push(operation);
  }
  return expanded;
}

/** 对 pattern 音符应用变奏：转调 / 力度 / 密度递进。 */
function applyPatternVariation(
  notes: NoteInput[],
  repeatIndex: number,
  part: { transpose?: number; velocityOffset?: number; densityGrow?: boolean },
): NoteInput[] {
  const transpose = part.transpose ?? 0;
  const velocityOffset = part.velocityOffset ?? 0;
  let result = notes.map((note) => ({
    pitch: clamp(note.pitch + transpose, 0, 127),
    startTick: note.startTick,
    durationTicks: note.durationTicks,
    velocity: clamp(note.velocity + velocityOffset, 1, 127),
  }));
  if (part.densityGrow && repeatIndex > 0 && result.length > 1) {
    // 密度递进：每次重复额外补插各相邻音符的中点，使节奏密度随 repeatIndex 增加。
    for (let grow = 0; grow < repeatIndex; grow += 1) {
      const filled: NoteInput[] = [];
      for (let index = 0; index < result.length; index += 1) {
        filled.push(result[index]);
        const next = result[index + 1];
        if (!next) continue;
        filled.push({
          pitch: result[index].pitch,
          startTick: Math.floor((result[index].startTick + next.startTick) / 2),
          durationTicks: Math.max(1, Math.floor(result[index].durationTicks / 2)),
          velocity: result[index].velocity,
        });
      }
      result = filled;
    }
  }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function isProposedChangeSet(input: unknown): input is ProposedChangeSet {
  try {
    parseProposedChangeSet(input);
    return true;
  } catch {
    return false;
  }
}
