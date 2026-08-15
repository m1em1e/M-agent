import type {
  MidiEditOperation,
  MidiProject,
  ProposedChangeSet,
  ValidationIssue,
  ValidationResult,
} from "../../shared/midi.js";
import {
  appendRevision,
  cloneMidiProject,
  createId,
  createMidiNote,
  createMidiTrack,
  type IdFactory,
} from "./project.js";
import { error, validateProject } from "./validation.js";

const TRACK_ROLES = new Set(["melody", "harmony", "bass", "drums", "other"]);

export interface ChangeSetLimits {
  maximumOperations?: number;
  maximumAffectedNotes?: number;
}

export interface ApplyChangeSetOptions extends ChangeSetLimits {
  idFactory?: IdFactory;
  revisionSource?: "user" | "agent";
  now?: () => string;
}

export interface ApplyChangeSetResult {
  project: MidiProject;
  validation: ValidationResult;
}

export class ChangeSetValidationError extends Error {
  constructor(public readonly validation: ValidationResult) {
    super(validation.issues.map((issue) => issue.message).join(" ") || "Invalid MIDI change set.");
    this.name = "ChangeSetValidationError";
  }
}

export function validateChangeSet(
  project: MidiProject,
  changeSet: ProposedChangeSet,
  limits: ChangeSetLimits = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  let affectedNotes = 0;
  const maximumOperations = limits.maximumOperations ?? 500;
  const maximumAffectedNotes = limits.maximumAffectedNotes ?? 10_000;

  if (!changeSet || typeof changeSet !== "object") {
    return { valid: false, issues: [error("INVALID_CHANGE_SET", "Change set must be an object.")], affectedNotes };
  }
  if (typeof changeSet.id !== "string" || changeSet.id.length === 0) {
    issues.push(error("INVALID_CHANGE_SET_ID", "Change-set ID must be a non-empty string.", "id"));
  }
  if (typeof changeSet.summary !== "string" || changeSet.summary.trim().length === 0) {
    issues.push(error("INVALID_CHANGE_SET_SUMMARY", "Change-set summary must not be empty.", "summary"));
  }
  if (!Array.isArray(changeSet.operations)) {
    issues.push(error("INVALID_OPERATIONS", "Change-set operations must be an array.", "operations"));
    return { valid: false, issues, affectedNotes };
  }
  if (changeSet.operations.length > maximumOperations) {
    issues.push(error("OPERATION_BUDGET_EXCEEDED", `Change set exceeds the ${maximumOperations}-operation limit.`, "operations"));
  }

  const shadow = cloneMidiProject(project);
  let validationId = 0;
  const validationIdFactory: IdFactory = (prefix) => `validation_${prefix}_${validationId++}`;
  changeSet.operations.forEach((operation, operationIndex) => {
    const before = issues.length;
    affectedNotes += countAffectedNotes(operation, shadow);
    inspectOperation(operation, shadow, issues, operationIndex);
    if (issues.length === before) {
      applyOperation(shadow, operation, validationIdFactory);
    }
  });
  if (affectedNotes > maximumAffectedNotes) {
    issues.push(error("NOTE_BUDGET_EXCEEDED", `Change set affects ${affectedNotes} notes, exceeding the ${maximumAffectedNotes}-note limit.`));
  }

  const projectValidation = validateProject(shadow);
  issues.push(...projectValidation.issues);
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    affectedNotes,
  };
}

export function applyChangeSet(
  project: MidiProject,
  changeSet: ProposedChangeSet,
  options: ApplyChangeSetOptions = {},
): ApplyChangeSetResult {
  const validation = validateChangeSet(project, changeSet, options);
  if (!validation.valid) {
    throw new ChangeSetValidationError(validation);
  }
  const next = cloneMidiProject(project);
  const idFactory = options.idFactory ?? createId;
  for (const operation of changeSet.operations) {
    applyOperation(next, operation, idFactory);
  }
  appendRevision(next, {
    id: idFactory("revision"),
    label: changeSet.summary,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    source: options.revisionSource ?? "user",
    changeSetId: changeSet.id,
  });
  return { project: next, validation };
}

function inspectOperation(
  operation: MidiEditOperation,
  project: MidiProject,
  issues: ValidationIssue[],
  operationIndex: number,
): void {
  const path = `operations[${operationIndex}]`;
  if (!operation || typeof operation !== "object" || typeof operation.type !== "string") {
    addOperationIssue(issues, operationIndex, "INVALID_OPERATION", "Operation must have a type.", path);
    return;
  }
  const track = "trackId" in operation
    ? project.tracks.find((candidate) => candidate.id === operation.trackId)
    : undefined;

  switch (operation.type) {
    case "insert_notes": {
      if (!track) {
        addOperationIssue(issues, operationIndex, "UNKNOWN_TRACK", `Unknown track '${operation.trackId}'.`, `${path}.trackId`);
        return;
      }
      if (!Array.isArray(operation.notes) || operation.notes.length === 0) {
        addOperationIssue(issues, operationIndex, "EMPTY_NOTE_INSERT", "Insert operation must contain at least one note.", `${path}.notes`);
        return;
      }
      const ids = new Set(track.notes.map((note) => note.id));
      operation.notes.forEach((note, noteIndex) => {
        inspectNoteInput(note, issues, operationIndex, `${path}.notes[${noteIndex}]`);
        if (isRecord(note) && typeof note.id === "string" && note.id && ids.has(note.id)) {
          addOperationIssue(issues, operationIndex, "DUPLICATE_NOTE_ID", `Note ID '${note.id}' already exists.`, `${path}.notes[${noteIndex}].id`);
        }
        if (isRecord(note) && typeof note.id === "string" && note.id) ids.add(note.id);
      });
      return;
    }
    case "delete_notes": {
      if (!track) {
        addOperationIssue(issues, operationIndex, "UNKNOWN_TRACK", `Unknown track '${operation.trackId}'.`, `${path}.trackId`);
        return;
      }
      if (!Array.isArray(operation.noteIds) || operation.noteIds.length === 0) {
        addOperationIssue(issues, operationIndex, "EMPTY_NOTE_DELETE", "Delete operation must identify at least one note.", `${path}.noteIds`);
        return;
      }
      const ids = new Set(track.notes.map((note) => note.id));
      for (const noteId of operation.noteIds) {
        if (!ids.has(noteId)) {
          addOperationIssue(issues, operationIndex, "UNKNOWN_NOTE", `Unknown note '${noteId}'.`, `${path}.noteIds`);
        }
      }
      return;
    }
    case "update_notes": {
      if (!track) {
        addOperationIssue(issues, operationIndex, "UNKNOWN_TRACK", `Unknown track '${operation.trackId}'.`, `${path}.trackId`);
        return;
      }
      if (!Array.isArray(operation.changes) || operation.changes.length === 0) {
        addOperationIssue(issues, operationIndex, "EMPTY_NOTE_UPDATE", "Update operation must contain at least one change.", `${path}.changes`);
        return;
      }
      operation.changes.forEach((change, changeIndex) => {
        if (!isRecord(change) || typeof change.noteId !== "string" || !change.noteId) {
          addOperationIssue(issues, operationIndex, "INVALID_NOTE_CHANGE", "Note change must identify a note.", `${path}.changes[${changeIndex}].noteId`);
          return;
        }
        const existing = track.notes.find((note) => note.id === change.noteId);
        if (!existing) {
          addOperationIssue(issues, operationIndex, "UNKNOWN_NOTE", `Unknown note '${change.noteId}'.`, `${path}.changes[${changeIndex}].noteId`);
          return;
        }
        inspectNoteInput({ ...existing, ...change }, issues, operationIndex, `${path}.changes[${changeIndex}]`);
      });
      return;
    }
    case "create_track": {
      if (!operation.track || typeof operation.track !== "object") {
        addOperationIssue(issues, operationIndex, "INVALID_TRACK", "Track input must be an object.", `${path}.track`);
        return;
      }
      if (operation.track.id && project.tracks.some((candidate) => candidate.id === operation.track.id)) {
        addOperationIssue(issues, operationIndex, "DUPLICATE_TRACK_ID", `Track ID '${operation.track.id}' already exists.`, `${path}.track.id`);
      }
      inspectTrackFields(operation.track, issues, operationIndex, `${path}.track`);
      if (operation.track.notes !== undefined && !Array.isArray(operation.track.notes)) {
        addOperationIssue(issues, operationIndex, "INVALID_TRACK_NOTES", "Track notes must be an array.", `${path}.track.notes`);
      } else {
        operation.track.notes?.forEach((note, noteIndex) => inspectNoteInput(note, issues, operationIndex, `${path}.track.notes[${noteIndex}]`));
      }
      return;
    }
    case "delete_track":
      if (!track) addOperationIssue(issues, operationIndex, "UNKNOWN_TRACK", `Unknown track '${operation.trackId}'.`, `${path}.trackId`);
      return;
    case "update_track":
      if (!track) {
        addOperationIssue(issues, operationIndex, "UNKNOWN_TRACK", `Unknown track '${operation.trackId}'.`, `${path}.trackId`);
      } else if (!isRecord(operation.changes)) {
        addOperationIssue(issues, operationIndex, "INVALID_TRACK_CHANGE", "Track changes must be an object.", `${path}.changes`);
      } else {
        inspectTrackFields({ ...track, ...operation.changes }, issues, operationIndex, `${path}.changes`);
      }
      return;
    case "set_tempo":
      inspectTick(operation.tick, issues, operationIndex, `${path}.tick`);
      if (!Number.isFinite(operation.bpm) || operation.bpm <= 0 || operation.bpm > 1000) {
        addOperationIssue(issues, operationIndex, "INVALID_TEMPO", "Tempo must be greater than 0 and at most 1000 BPM.", `${path}.bpm`);
      }
      return;
    case "set_time_signature":
      inspectTick(operation.tick, issues, operationIndex, `${path}.tick`);
      if (!Number.isInteger(operation.numerator) || operation.numerator < 1 || operation.numerator > 255) {
        addOperationIssue(issues, operationIndex, "INVALID_TIME_SIGNATURE", "Numerator must be between 1 and 255.", `${path}.numerator`);
      }
      if (!Number.isInteger(operation.denominator) || operation.denominator < 1 || operation.denominator > 128 || (operation.denominator & (operation.denominator - 1)) !== 0) {
        addOperationIssue(issues, operationIndex, "INVALID_TIME_SIGNATURE", "Denominator must be a power of two up to 128.", `${path}.denominator`);
      }
      return;
    case "set_loop":
      inspectTick(operation.startTick, issues, operationIndex, `${path}.startTick`);
      if (!Number.isInteger(operation.endTick) || operation.endTick <= operation.startTick) {
        addOperationIssue(issues, operationIndex, "INVALID_LOOP", "Loop end must be after its start.", `${path}.endTick`);
      }
      return;
    case "clear_loop":
      return;
    default:
      addOperationIssue(issues, operationIndex, "UNKNOWN_OPERATION", `Unknown operation type '${String((operation as { type?: unknown }).type)}'.`, `${path}.type`);
  }
}

function applyOperation(project: MidiProject, operation: MidiEditOperation, idFactory: IdFactory): void {
  switch (operation.type) {
    case "insert_notes": {
      const track = project.tracks.find((candidate) => candidate.id === operation.trackId)!;
      track.notes.push(...operation.notes.map((note) => createMidiNote(note, idFactory)));
      sortNotes(track.notes);
      break;
    }
    case "delete_notes": {
      const track = project.tracks.find((candidate) => candidate.id === operation.trackId)!;
      const deleted = new Set(operation.noteIds);
      track.notes = track.notes.filter((note) => !deleted.has(note.id));
      break;
    }
    case "update_notes": {
      const track = project.tracks.find((candidate) => candidate.id === operation.trackId)!;
      for (const change of operation.changes) {
        const { noteId: _noteId, ...fields } = change;
        Object.assign(track.notes.find((note) => note.id === change.noteId)!, withoutUndefined(fields));
      }
      sortNotes(track.notes);
      break;
    }
    case "create_track":
      project.tracks.push(createMidiTrack(operation.track, idFactory));
      break;
    case "delete_track":
      project.tracks = project.tracks.filter((track) => track.id !== operation.trackId);
      break;
    case "update_track": {
      const track = project.tracks.find((candidate) => candidate.id === operation.trackId)!;
      const changes: Record<string, unknown> = { ...operation.changes };
      if (changes.instrument === null) {
        delete changes.instrument;
        track.instrument = undefined;
      }
      Object.assign(track, withoutUndefined(changes));
      break;
    }
    case "set_tempo":
      upsertAtTick(project.tempoMap, { tick: operation.tick, bpm: operation.bpm });
      break;
    case "set_time_signature":
      upsertAtTick(project.timeSignatures, {
        tick: operation.tick,
        numerator: operation.numerator,
        denominator: operation.denominator,
      });
      break;
    case "set_loop":
      project.loopRegion = { startTick: operation.startTick, endTick: operation.endTick };
      break;
    case "clear_loop":
      project.loopRegion = null;
      break;
  }
}

function countAffectedNotes(operation: MidiEditOperation, project: MidiProject): number {
  if (!operation || typeof operation !== "object") return 0;
  switch (operation.type) {
    case "insert_notes": return Array.isArray(operation.notes) ? operation.notes.length : 0;
    case "delete_notes": return Array.isArray(operation.noteIds) ? operation.noteIds.length : 0;
    case "update_notes": return Array.isArray(operation.changes) ? operation.changes.length : 0;
    case "create_track": return Array.isArray(operation.track?.notes) ? operation.track.notes.length : 0;
    case "delete_track": return project.tracks.find((track) => track.id === operation.trackId)?.notes.length ?? 0;
    default: return 0;
  }
}

function inspectNoteInput(
  note: unknown,
  issues: ValidationIssue[],
  operationIndex: number,
  path: string,
): void {
  if (!isRecord(note)) {
    addOperationIssue(issues, operationIndex, "INVALID_NOTE", "Note must be an object.", path);
    return;
  }
  inspectInteger(note.pitch, 0, 127, issues, operationIndex, "INVALID_PITCH", `${path}.pitch`);
  inspectInteger(note.startTick, 0, Number.MAX_SAFE_INTEGER, issues, operationIndex, "INVALID_START_TICK", `${path}.startTick`);
  inspectInteger(note.durationTicks, 1, Number.MAX_SAFE_INTEGER, issues, operationIndex, "INVALID_DURATION", `${path}.durationTicks`);
  inspectInteger(note.velocity, 1, 127, issues, operationIndex, "INVALID_VELOCITY", `${path}.velocity`);
}

function inspectTrackFields(
  track: unknown,
  issues: ValidationIssue[],
  operationIndex: number,
  path: string,
): void {
  if (!isRecord(track)) {
    addOperationIssue(issues, operationIndex, "INVALID_TRACK", "Track must be an object.", path);
    return;
  }
  if (typeof track.name !== "string" || !track.name.trim()) addOperationIssue(issues, operationIndex, "INVALID_TRACK_NAME", "Track name must not be empty.", `${path}.name`);
  if (track.role !== undefined && !TRACK_ROLES.has(String(track.role))) addOperationIssue(issues, operationIndex, "INVALID_TRACK_ROLE", `Unknown track role '${String(track.role)}'.`, `${path}.role`);
  if (track.channel !== undefined) inspectInteger(track.channel, 0, 15, issues, operationIndex, "INVALID_CHANNEL", `${path}.channel`);
  if (track.program !== undefined) inspectInteger(track.program, 0, 127, issues, operationIndex, "INVALID_PROGRAM", `${path}.program`);
}

function inspectInteger(value: unknown, min: number, max: number, issues: ValidationIssue[], operationIndex: number, code: string, path: string): void {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) addOperationIssue(issues, operationIndex, code, `${path} must be an integer between ${min} and ${max}.`, path);
}

function inspectTick(value: unknown, issues: ValidationIssue[], operationIndex: number, path: string): void {
  inspectInteger(value, 0, Number.MAX_SAFE_INTEGER, issues, operationIndex, "INVALID_TICK", path);
}

function addOperationIssue(issues: ValidationIssue[], operationIndex: number, code: string, message: string, path: string): void {
  issues.push({ ...error(code, message, path), operationIndex });
}

function sortNotes<T extends { startTick: number; pitch: number; id: string }>(notes: T[]): void {
  notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch || a.id.localeCompare(b.id));
}

function upsertAtTick<T extends { tick: number }>(events: T[], event: T): void {
  const index = events.findIndex((candidate) => candidate.tick === event.tick);
  if (index >= 0) events[index] = { ...event };
  else events.push({ ...event });
  events.sort((a, b) => a.tick - b.tick);
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
