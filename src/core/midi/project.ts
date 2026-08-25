import type {
  MidiNote,
  MidiProject,
  MidiTrack,
  NoteInput,
  Revision,
  TrackInput,
} from "../../shared/midi.js";

export type IdFactory = (prefix: string) => string;

let fallbackId = 0;

export const createId: IdFactory = (prefix) => {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return randomUUID ? `${prefix}_${randomUUID()}` : `${prefix}_${Date.now()}_${fallbackId++}`;
};

export interface CreateProjectOptions {
  id?: string;
  title?: string;
  ppq?: number;
  bpm?: number;
  numerator?: number;
  denominator?: number;
  idFactory?: IdFactory;
}

export function createMidiProject(options: CreateProjectOptions = {}): MidiProject {
  const idFactory = options.idFactory ?? createId;
  const ppq = options.ppq ?? 480;
  const bpm = options.bpm ?? 120;
  const numerator = options.numerator ?? 4;
  const denominator = options.denominator ?? 4;

  if (!Number.isInteger(ppq) || ppq < 1 || ppq > 0x7fff) {
    throw new RangeError("PPQ must be an integer between 1 and 32767.");
  }
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError("BPM must be greater than zero.");
  }
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 255) {
    throw new RangeError("Time-signature numerator must be between 1 and 255.");
  }
  if (!isPowerOfTwo(denominator) || denominator > 128) {
    throw new RangeError("Time-signature denominator must be a power of two up to 128.");
  }

  return {
    id: options.id ?? idFactory("project"),
    title: options.title?.trim() || "Untitled",
    ppq,
    tempoMap: [{ tick: 0, bpm }],
    timeSignatures: [{ tick: 0, numerator, denominator }],
    loopRegion: null,
    tracks: [],
    revisions: [],
    agentSessions: [],
  };
}

export function createMidiNote(input: NoteInput, idFactory: IdFactory = createId): MidiNote {
  return {
    id: input.id ?? idFactory("note"),
    pitch: input.pitch,
    startTick: input.startTick,
    durationTicks: input.durationTicks,
    velocity: input.velocity,
  };
}

export function createMidiTrack(input: TrackInput, idFactory: IdFactory = createId): MidiTrack {
  return {
    id: input.id ?? idFactory("track"),
    name: input.name.trim() || "Track",
    role: input.role ?? (input.channel === 9 ? "drums" : "other"),
    channel: input.channel ?? 0,
    program: input.program ?? 0,
    muted: input.muted ?? false,
    solo: input.solo ?? false,
    volume: input.volume,
    instrument: input.instrument,
    loopRegion: input.loopRegion,
    notes: (input.notes ?? []).map((note) => createMidiNote(note, idFactory)),
    controllerEvents: input.controllerEvents?.map((event) => ({ ...event, id: event.id ?? idFactory("cc") })),
  };
}

export function cloneMidiProject(project: MidiProject): MidiProject {
  return {
    ...project,
    tempoMap: project.tempoMap.map((event) => ({ ...event })),
    timeSignatures: project.timeSignatures.map((event) => ({ ...event })),
    loopRegion: project.loopRegion ? { ...project.loopRegion } : null,
    tracks: project.tracks.map((track) => ({
      ...track,
      loopRegion: track.loopRegion === null || track.loopRegion === undefined
        ? track.loopRegion
        : { ...track.loopRegion },
      notes: track.notes.map((note) => ({ ...note })),
      controllerEvents: track.controllerEvents?.map((event) => ({ ...event })),
    })),
    revisions: project.revisions.map((revision) => ({ ...revision })),
    agentSessions: project.agentSessions.map((session) => ({
      ...session,
      acceptedChangeSetIds: [...session.acceptedChangeSetIds],
    })),
    instruments: project.instruments?.map((instrument) => ({
      ...instrument,
      presets: instrument.presets?.map((preset) => ({ ...preset })),
      sfzRegions: instrument.sfzRegions?.map((region) => ({ ...region })),
    })),
  };
}

export function appendRevision(
  project: MidiProject,
  revision: Revision,
  maximum = 50,
): void {
  project.revisions.push(revision);
  if (project.revisions.length > maximum) {
    project.revisions.splice(0, project.revisions.length - maximum);
  }
}

export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}
