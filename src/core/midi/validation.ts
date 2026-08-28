import type {
  MidiNote,
  MidiProject,
  MidiTrack,
  ValidationIssue,
  ValidationResult,
} from "../../shared/midi.js";
import { isPowerOfTwo } from "./project.js";

export function validateNote(note: MidiNote, path = "note"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  integerRange(issues, note.pitch, 0, 127, `${path}.pitch`, "INVALID_PITCH");
  integerRange(
    issues,
    note.startTick,
    0,
    Number.MAX_SAFE_INTEGER,
    `${path}.startTick`,
    "INVALID_START_TICK",
  );
  integerRange(
    issues,
    note.durationTicks,
    1,
    Number.MAX_SAFE_INTEGER,
    `${path}.durationTicks`,
    "INVALID_DURATION",
  );
  integerRange(issues, note.velocity, 1, 127, `${path}.velocity`, "INVALID_VELOCITY");
  optionalNumberRange(issues, note.pan, -100, 100, `${path}.pan`, "INVALID_NOTE_PAN");
  optionalNumberRange(issues, note.release, 0, 2, `${path}.release`, "INVALID_NOTE_RELEASE");
  optionalNumberRange(issues, note.cutoffHz, 0, 20_000, `${path}.cutoffHz`, "INVALID_NOTE_CUTOFF");
  optionalNumberRange(issues, note.resonanceQ, 0, 16.5, `${path}.resonanceQ`, "INVALID_NOTE_RESONANCE");
  optionalNumberRange(issues, note.finePitchCents, -100, 100, `${path}.finePitchCents`, "INVALID_NOTE_FINE_PITCH");
  optionalNumberRange(issues, note.sustainBeats, 0, 8, `${path}.sustainBeats`, "INVALID_NOTE_SUSTAIN");
  if (typeof note.id !== "string" || note.id.length === 0) {
    issues.push(error("INVALID_NOTE_ID", "Note ID must be a non-empty string.", `${path}.id`));
  }
  return issues;
}

export function validateTrack(track: MidiTrack, path = "track"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof track.id !== "string" || track.id.length === 0) {
    issues.push(error("INVALID_TRACK_ID", "Track ID must be a non-empty string.", `${path}.id`));
  }
  if (typeof track.name !== "string" || track.name.trim().length === 0) {
    issues.push(error("INVALID_TRACK_NAME", "Track name must not be empty.", `${path}.name`));
  }
  integerRange(issues, track.channel, 0, 15, `${path}.channel`, "INVALID_CHANNEL");
  integerRange(issues, track.program, 0, 127, `${path}.program`, "INVALID_PROGRAM");
  const noteIds = new Set<string>();
  track.notes.forEach((note, index) => {
    issues.push(...validateNote(note, `${path}.notes[${index}]`));
    if (noteIds.has(note.id)) {
      issues.push(
        error(
          "DUPLICATE_NOTE_ID",
          `Duplicate note ID '${note.id}' in track '${track.id}'.`,
          `${path}.notes[${index}].id`,
        ),
      );
    }
    noteIds.add(note.id);
  });
  if (
    track.loopRegion &&
    (!Number.isInteger(track.loopRegion.startTick) ||
      track.loopRegion.startTick < 0 ||
      !Number.isInteger(track.loopRegion.endTick) ||
      track.loopRegion.endTick <= track.loopRegion.startTick)
  ) {
    issues.push(
      error("INVALID_TRACK_LOOP", "Track loop end must be after a non-negative start tick.", `${path}.loopRegion`),
    );
  }
  const ccIds = new Set<string>();
  (track.controllerEvents ?? []).forEach((event, index) => {
    const eventPath = `${path}.controllerEvents[${index}]`;
    if (typeof event.id !== "string" || event.id.trim().length === 0) {
      issues.push(error("INVALID_CC_ID", "Controller event ID must not be empty.", `${eventPath}.id`));
    }
    if (ccIds.has(event.id)) {
      issues.push(error("DUPLICATE_CC_ID", `Duplicate controller event ID '${event.id}'.`, `${eventPath}.id`));
    }
    ccIds.add(event.id);
    integerRange(issues, event.tick, 0, Number.MAX_SAFE_INTEGER, `${eventPath}.tick`, "INVALID_CC_TICK");
    integerRange(issues, event.controller, 0, 127, `${eventPath}.controller`, "INVALID_CC_CONTROLLER");
    integerRange(issues, event.value, 0, 127, `${eventPath}.value`, "INVALID_CC_VALUE");
  });
  const pitchBendIds = new Set<string>();
  (track.pitchBends ?? []).forEach((event, index) => {
    const eventPath = `${path}.pitchBends[${index}]`;
    if (typeof event.id !== "string" || event.id.trim().length === 0) {
      issues.push(error("INVALID_PITCH_BEND_ID", "Pitch bend event ID must not be empty.", `${eventPath}.id`));
    }
    if (pitchBendIds.has(event.id)) {
      issues.push(error("DUPLICATE_PITCH_BEND_ID", `Duplicate pitch bend event ID '${event.id}'.`, `${eventPath}.id`));
    }
    pitchBendIds.add(event.id);
    integerRange(issues, event.tick, 0, Number.MAX_SAFE_INTEGER, `${eventPath}.tick`, "INVALID_PITCH_BEND_TICK");
    integerRange(issues, event.value, -8192, 8191, `${eventPath}.value`, "INVALID_PITCH_BEND_VALUE");
  });
  return issues;
}

export function validateProject(project: MidiProject): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!Number.isInteger(project.ppq) || project.ppq < 1 || project.ppq > 0x7fff) {
    issues.push(error("INVALID_PPQ", "PPQ must be an integer between 1 and 32767.", "ppq"));
  }
  const trackIds = new Set<string>();
  project.tracks.forEach((track, index) => {
    issues.push(...validateTrack(track, `tracks[${index}]`));
    if (trackIds.has(track.id)) {
      issues.push(error("DUPLICATE_TRACK_ID", `Duplicate track ID '${track.id}'.`, `tracks[${index}].id`));
    }
    trackIds.add(track.id);
  });

  project.tempoMap.forEach((event, index) => {
    if (!Number.isInteger(event.tick) || event.tick < 0) {
      issues.push(error("INVALID_TEMPO_TICK", "Tempo tick must be a non-negative integer.", `tempoMap[${index}].tick`));
    }
    if (!Number.isFinite(event.bpm) || event.bpm <= 0 || event.bpm > 1000) {
      issues.push(error("INVALID_TEMPO", "Tempo must be greater than 0 and at most 1000 BPM.", `tempoMap[${index}].bpm`));
    }
  });
  project.timeSignatures.forEach((event, index) => {
    if (!Number.isInteger(event.tick) || event.tick < 0) {
      issues.push(error("INVALID_TIME_SIGNATURE_TICK", "Time-signature tick must be non-negative.", `timeSignatures[${index}].tick`));
    }
    if (!Number.isInteger(event.numerator) || event.numerator < 1 || event.numerator > 255) {
      issues.push(error("INVALID_TIME_SIGNATURE", "Numerator must be between 1 and 255.", `timeSignatures[${index}].numerator`));
    }
    if (!isPowerOfTwo(event.denominator) || event.denominator > 128) {
      issues.push(error("INVALID_TIME_SIGNATURE", "Denominator must be a power of two up to 128.", `timeSignatures[${index}].denominator`));
    }
  });
  if (
    project.loopRegion &&
    (!Number.isInteger(project.loopRegion.startTick) ||
      project.loopRegion.startTick < 0 ||
      !Number.isInteger(project.loopRegion.endTick) ||
      project.loopRegion.endTick <= project.loopRegion.startTick)
  ) {
    issues.push(error("INVALID_LOOP", "Loop end must be after a non-negative start tick.", "loopRegion"));
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    affectedNotes: 0,
  };
}

export function error(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, severity: "error", path };
}

function integerRange(
  issues: ValidationIssue[],
  value: number,
  minimum: number,
  maximum: number,
  path: string,
  code: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push(error(code, `${path} must be an integer between ${minimum} and ${maximum}.`, path));
  }
}

/** 可选数值字段的范围校验（未定义时跳过；需为有限数字）。 */
function optionalNumberRange(
  issues: ValidationIssue[],
  value: number | undefined,
  minimum: number,
  maximum: number,
  path: string,
  code: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    issues.push(error(code, `${path} must be a number between ${minimum} and ${maximum}.`, path));
  }
}
