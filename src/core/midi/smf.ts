import type {
  MidiExportOptions,
  MidiImportResult,
  MidiImportWarning,
  MidiNote,
  MidiProject,
  MidiTrack,
  TempoEvent,
  TimeSignatureEvent,
} from "../../shared/midi.js";
import { createMidiProject, type IdFactory } from "./project.js";
import { validateProject } from "./validation.js";

const HEADER_CHUNK = 0x4d546864;
const TRACK_CHUNK = 0x4d54726b;

export class MidiFileError extends Error {
  constructor(message: string, public readonly offset?: number) {
    super(offset === undefined ? message : `${message} (offset ${offset})`);
    this.name = "MidiFileError";
  }
}

export interface MidiImportOptions {
  title?: string;
  projectId?: string;
  idFactory?: IdFactory;
}

interface ParsedNote {
  channel: number;
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
  sequence: number;
}

interface ParsedTrack {
  name?: string;
  notes: ParsedNote[];
  programs: Map<number, number>;
  programChangeCounts: Map<number, number>;
  tempos: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  controllerEvents: Array<{ tick: number; channel: number; controller: number; value: number }>;
  pitchBends: Array<{ tick: number; channel: number; value: number }>;
  endTick: number;
}

interface RawEvent {
  tick: number;
  priority: number;
  sequence: number;
  bytes: number[];
}

export function importMidi(bytes: Uint8Array, options: MidiImportOptions = {}): MidiImportResult {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("MIDI input must be a Uint8Array.");
  const reader = new ByteReader(bytes);
  if (reader.readU32() !== HEADER_CHUNK) throw new MidiFileError("Missing MThd header chunk.", 0);
  const headerLength = reader.readU32();
  if (headerLength < 6) throw new MidiFileError("MIDI header is shorter than 6 bytes.", reader.offset - 4);
  const format = reader.readU16();
  const trackCount = reader.readU16();
  const division = reader.readU16();
  if (format !== 0 && format !== 1) throw new MidiFileError(`Unsupported MIDI format ${format}; only Type 0 and Type 1 are supported.`);
  if (format === 0 && trackCount !== 1) throw new MidiFileError("A Type 0 MIDI file must contain exactly one track.");
  if ((division & 0x8000) !== 0) throw new MidiFileError("SMPTE time division is not supported; use a PPQ MIDI file.");
  if (division === 0) throw new MidiFileError("MIDI PPQ division must be greater than zero.");
  reader.skip(headerLength - 6);

  const warnings: MidiImportWarning[] = [];
  const parsedTracks: ParsedTrack[] = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (reader.remaining < 8) throw new MidiFileError(`Missing track chunk ${trackIndex}.`, reader.offset);
    if (reader.readU32() !== TRACK_CHUNK) throw new MidiFileError(`Expected MTrk chunk ${trackIndex}.`, reader.offset - 4);
    const length = reader.readU32();
    const trackBytes = reader.readBytes(length);
    parsedTracks.push(parseTrack(trackBytes, trackIndex, warnings));
  }
  if (reader.remaining > 0) warnings.push({ code: "TRAILING_BYTES", message: `${reader.remaining} trailing byte(s) were ignored.` });

  const idFactory = options.idFactory ?? importedIdFactory();
  const project = createMidiProject({
    id: options.projectId,
    title: options.title ?? "Imported MIDI",
    ppq: division,
    idFactory,
  });
  const tempos = parsedTracks.flatMap((track) => track.tempos);
  const signatures = parsedTracks.flatMap((track) => track.timeSignatures);
  project.tempoMap = normalizedEvents(tempos.length ? tempos : [{ tick: 0, bpm: 120 }]);
  project.timeSignatures = normalizedEvents(
    signatures.length ? signatures : [{ tick: 0, numerator: 4, denominator: 4 }],
  );

  parsedTracks.forEach((parsed, trackIndex) => {
    const channels = [...new Set(parsed.notes.map((note) => note.channel))].sort((a, b) => a - b);
    channels.forEach((channel) => {
      const suffix = channels.length > 1 ? ` · Ch ${channel + 1}` : "";
      const name = `${parsed.name?.trim() || `Track ${trackIndex + 1}`}${suffix}`;
      const notes: MidiNote[] = parsed.notes
        .filter((note) => note.channel === channel)
        .map((note) => ({
          id: idFactory("note"),
          pitch: note.pitch,
          startTick: note.startTick,
          durationTicks: note.durationTicks,
          velocity: note.velocity,
        }))
        .sort(noteSort);
      project.tracks.push({
        id: idFactory("track"),
        name,
        role: channel === 9 ? "drums" : "other",
        channel,
        program: parsed.programs.get(channel) ?? 0,
        muted: false,
        solo: false,
        notes,
        controllerEvents: parsed.controllerEvents
          .filter((event) => event.channel === channel)
          .map((event) => ({ id: idFactory("cc"), tick: event.tick, controller: event.controller, value: event.value }))
          .sort((a, b) => a.tick - b.tick || a.controller - b.controller),
        pitchBends: parsed.pitchBends
          .filter((event) => event.channel === channel)
          .map((event) => ({ id: idFactory("pb"), tick: event.tick, value: event.value }))
          .sort((a, b) => a.tick - b.tick),
      });
      if ((parsed.programChangeCounts.get(channel) ?? 0) > 1) {
        warnings.push({
          code: "PROGRAM_CHANGES_COLLAPSED",
          message: `Track ${trackIndex + 1}, channel ${channel + 1} contains multiple program changes; the last program was retained.`,
          trackIndex,
        });
      }
    });
  });

  project.revisions.push({
    id: idFactory("revision"),
    label: "Imported MIDI",
    createdAt: new Date().toISOString(),
    source: "import",
  });
  return { project, format, warnings };
}

export function exportMidi(project: MidiProject, options: MidiExportOptions = {}): Uint8Array {
  const validation = validateProject(project);
  if (!validation.valid) throw new MidiFileError(`Cannot export an invalid MIDI project: ${validation.issues.map((issue) => issue.message).join(" ")}`);
  const format = options.format ?? 1;
  if (format !== 0 && format !== 1) throw new MidiFileError("MIDI export format must be 0 or 1.");

  const trackChunks = format === 0
    ? [encodeTrack(buildTypeZeroEvents(project))]
    : [encodeTrack(buildConductorEvents(project)), ...project.tracks.map((track) => encodeTrack(buildTrackEvents(track, project.ppq)))];
  const header = new ByteWriter();
  header.u32(HEADER_CHUNK);
  header.u32(6);
  header.u16(format);
  header.u16(trackChunks.length);
  header.u16(project.ppq);
  return concatBytes([header.finish(), ...trackChunks]);
}

function parseTrack(bytes: Uint8Array, trackIndex: number, warnings: MidiImportWarning[]): ParsedTrack {
  const reader = new ByteReader(bytes);
  const track: ParsedTrack = {
    notes: [],
    programs: new Map(),
    programChangeCounts: new Map(),
    tempos: [],
    timeSignatures: [],
    controllerEvents: [],
    pitchBends: [],
    endTick: 0,
  };
  const activeNotes = new Map<string, Array<{ tick: number; velocity: number; sequence: number }>>();
  let tick = 0;
  let runningStatus: number | undefined;
  let sequence = 0;
  let foundEnd = false;
  const ignoredEventTypes = new Set<number>();

  while (reader.remaining > 0) {
    tick += reader.readVlq();
    track.endTick = Math.max(track.endTick, tick);
    let status = reader.peekU8();
    if (status >= 0x80) {
      status = reader.readU8();
      if (status < 0xf0) runningStatus = status;
      else runningStatus = undefined;
    } else if (runningStatus !== undefined) {
      status = runningStatus;
    } else {
      throw new MidiFileError("Running status was used before a channel status byte.", reader.offset);
    }

    if (status === 0xff) {
      const type = reader.readU8();
      const length = reader.readVlq();
      const data = reader.readBytes(length);
      if (type === 0x2f) {
        foundEnd = true;
        if (length !== 0) warnings.push({ code: "MALFORMED_END_OF_TRACK", message: "End-of-track meta event had data bytes.", trackIndex, tick });
        break;
      }
      if (type === 0x03) track.name = decodeText(data);
      else if (type === 0x51) {
        if (length === 3) {
          const microseconds = (data[0] << 16) | (data[1] << 8) | data[2];
          if (microseconds > 0) track.tempos.push({ tick, bpm: 60_000_000 / microseconds });
        } else warnings.push({ code: "MALFORMED_TEMPO", message: "Tempo meta event must contain 3 bytes.", trackIndex, tick });
      } else if (type === 0x58) {
        if (length >= 2 && data[1] <= 7) {
          track.timeSignatures.push({ tick, numerator: data[0], denominator: 2 ** data[1] });
        } else warnings.push({ code: "MALFORMED_TIME_SIGNATURE", message: "Invalid time-signature meta event was ignored.", trackIndex, tick });
      } else if (type === 0x05 && !ignoredEventTypes.has(0x100 | type)) {
        ignoredEventTypes.add(0x100 | type);
        warnings.push({ code: "LYRICS_IGNORED", message: "Lyric meta events are not represented in the project model.", trackIndex, tick });
      }
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const length = reader.readVlq();
      reader.skip(length);
      warnings.push({ code: "SYSEX_IGNORED", message: "System-exclusive data is not represented in the project model.", trackIndex, tick });
      continue;
    }
    if (status >= 0xf0) throw new MidiFileError(`Unsupported system status 0x${status.toString(16)}.`, reader.offset - 1);

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const data1 = reader.readU8();
    const data2 = eventType === 0xc0 || eventType === 0xd0 ? undefined : reader.readU8();
    if (data1 > 0x7f || (data2 !== undefined && data2 > 0x7f)) throw new MidiFileError("Channel event contains an invalid data byte.", reader.offset);

    if (eventType === 0xc0) {
      track.programs.set(channel, data1);
      track.programChangeCounts.set(channel, (track.programChangeCounts.get(channel) ?? 0) + 1);
    } else if (eventType === 0xb0) {
      track.controllerEvents.push({ tick, channel, controller: data1, value: data2! });
    } else if (eventType === 0xe0) {
      // 弯音：14bit 无符号 0..16383 → 有符号 -8192..8191。
      track.pitchBends.push({ tick, channel, value: ((data2! << 7) | data1) - 8192 });
    } else if (eventType === 0x90 && data2! > 0) {
      const key = `${channel}:${data1}`;
      const active = activeNotes.get(key) ?? [];
      active.push({ tick, velocity: data2!, sequence: sequence++ });
      activeNotes.set(key, active);
    } else if (eventType === 0x80 || (eventType === 0x90 && data2 === 0)) {
      const key = `${channel}:${data1}`;
      const active = activeNotes.get(key);
      const start = active?.shift();
      if (!start) {
        warnings.push({ code: "UNMATCHED_NOTE_OFF", message: `Unmatched note-off for pitch ${data1}.`, trackIndex, tick });
      } else {
        if (active?.length === 0) activeNotes.delete(key);
        if (tick === start.tick) warnings.push({ code: "ZERO_LENGTH_NOTE", message: `A zero-length note at tick ${tick} was ignored.`, trackIndex, tick });
        else track.notes.push({ channel, pitch: data1, startTick: start.tick, durationTicks: tick - start.tick, velocity: start.velocity, sequence: start.sequence });
      }
    } else if (!ignoredEventTypes.has(eventType)) {
      ignoredEventTypes.add(eventType);
      warnings.push({
        code: "CHANNEL_EVENT_IGNORED",
        message: `Channel event type 0x${eventType.toString(16)} is not represented in the project model.`,
        trackIndex,
        tick,
      });
    }
  }
  if (!foundEnd) warnings.push({ code: "MISSING_END_OF_TRACK", message: "Track did not contain an end-of-track meta event.", trackIndex, tick: track.endTick });
  for (const [key, active] of activeNotes) {
    const [, pitch] = key.split(":").map(Number);
    for (const start of active) warnings.push({ code: "UNTERMINATED_NOTE", message: `Unterminated note for pitch ${pitch} at tick ${start.tick} was ignored.`, trackIndex, tick: start.tick });
  }
  track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch || a.sequence - b.sequence);
  return track;
}

function buildConductorEvents(project: MidiProject): RawEvent[] {
  let sequence = 0;
  const events: RawEvent[] = [];
  for (const tempo of project.tempoMap) {
    const microseconds = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / tempo.bpm)));
    events.push({ tick: tempo.tick, priority: 0, sequence: sequence++, bytes: [0xff, 0x51, 0x03, (microseconds >>> 16) & 0xff, (microseconds >>> 8) & 0xff, microseconds & 0xff] });
  }
  for (const signature of project.timeSignatures) {
    events.push({ tick: signature.tick, priority: 1, sequence: sequence++, bytes: [0xff, 0x58, 0x04, signature.numerator, Math.log2(signature.denominator), 24, 8] });
  }
  return events;
}

function buildTrackEvents(track: MidiTrack, ppq: number): RawEvent[] {
  let sequence = 0;
  const events: RawEvent[] = [{ tick: 0, priority: 0, sequence: sequence++, bytes: metaText(0x03, track.name) }];
  // 音色引用（SoundFont）写出 bank select，保留音色 fidelity；SFZ/无引用轨道只写 program。
  if (track.instrument?.type === "soundfont") {
    events.push({ tick: 0, priority: 1, sequence: sequence++, bytes: [0xb0 | track.channel, 0, Math.floor(track.instrument.bank / 128)] });
    events.push({ tick: 0, priority: 1, sequence: sequence++, bytes: [0xb0 | track.channel, 32, track.instrument.bank % 128] });
  }
  events.push({ tick: 0, priority: 1, sequence: sequence++, bytes: [0xc0 | track.channel, track.program] });
  for (const event of track.controllerEvents ?? []) {
    events.push({ tick: event.tick, priority: 2, sequence: sequence++, bytes: [0xb0 | track.channel, event.controller, event.value] });
  }
  for (const event of track.pitchBends ?? []) {
    const bend = Math.max(0, Math.min(16383, event.value + 8192));
    events.push({ tick: event.tick, priority: 2, sequence: sequence++, bytes: [0xe0 | track.channel, bend & 0x7f, (bend >> 7) & 0x7f] });
  }
  for (const note of track.notes) {
    sequence = pushNoteAttributeEvents(events, sequence, track.channel, note, ppq);
    events.push({ tick: note.startTick, priority: 3, sequence: sequence++, bytes: [0x90 | track.channel, note.pitch, note.velocity] });
    events.push({ tick: note.startTick + note.durationTicks, priority: 2, sequence: sequence++, bytes: [0x80 | track.channel, note.pitch, 0] });
  }
  return events;
}

/** 写音符级属性的近似 MIDI 事件（在音符起点：CC10/71/74/72、0xE0 弯音；延音→CC64 对）。返回更新后的序号。 */
function pushNoteAttributeEvents(
  events: RawEvent[],
  sequence: number,
  channel: number,
  note: MidiNote,
  ppq: number,
): number {
  const acc = (value: number) => Math.max(0, Math.min(127, Math.round(value)));
  if (note.pan !== undefined && note.pan !== 0) {
    events.push({ tick: note.startTick, priority: 1, sequence: sequence++, bytes: [0xb0 | channel, 10, acc((note.pan + 100) / 2)] });
  }
  if (note.cutoffHz !== undefined && note.cutoffHz > 0) {
    const cc = Math.log(note.cutoffHz / 200) / Math.log(100) * 127;
    events.push({ tick: note.startTick, priority: 1, sequence: sequence++, bytes: [0xb0 | channel, 74, acc(cc)] });
  }
  if (note.resonanceQ !== undefined && note.resonanceQ > 0) {
    events.push({ tick: note.startTick, priority: 1, sequence: sequence++, bytes: [0xb0 | channel, 71, acc((note.resonanceQ / 16.5) * 127)] });
  }
  if (note.release !== undefined && note.release > 0) {
    events.push({ tick: note.startTick, priority: 1, sequence: sequence++, bytes: [0xb0 | channel, 72, acc((note.release / 2) * 127)] });
  }
  if (note.finePitchCents !== undefined && note.finePitchCents !== 0) {
    const bend = Math.max(0, Math.min(16383, Math.round((note.finePitchCents / 200) * 8192) + 8192));
    events.push({ tick: note.startTick, priority: 1, sequence: sequence++, bytes: [0xe0 | channel, bend & 0x7f, (bend >> 7) & 0x7f] });
  }
  if ((note.sustainBeats ?? 0) > 0) {
    events.push({ tick: note.startTick, priority: 1, sequence: sequence++, bytes: [0xb0 | channel, 64, 127] });
    events.push({
      tick: note.startTick + note.durationTicks + Math.round((note.sustainBeats ?? 0) * ppq),
      priority: 3,
      sequence: sequence++,
      bytes: [0xb0 | channel, 64, 0],
    });
  }
  return sequence;
}

function buildTypeZeroEvents(project: MidiProject): RawEvent[] {
  const events = buildConductorEvents(project);
  let sequence = events.length;
  const channelPrograms = new Map<number, number>();
  for (const track of project.tracks) {
    const existing = channelPrograms.get(track.channel);
    if (existing !== undefined && existing !== track.program) throw new MidiFileError(`Cannot export Type 0: channel ${track.channel + 1} uses multiple programs.`);
    if (existing === undefined) {
      channelPrograms.set(track.channel, track.program);
      events.push({ tick: 0, priority: 1, sequence: sequence++, bytes: [0xc0 | track.channel, track.program] });
    }
    for (const note of track.notes) {
      sequence = pushNoteAttributeEvents(events, sequence, track.channel, note, project.ppq);
      events.push({ tick: note.startTick, priority: 3, sequence: sequence++, bytes: [0x90 | track.channel, note.pitch, note.velocity] });
      events.push({ tick: note.startTick + note.durationTicks, priority: 2, sequence: sequence++, bytes: [0x80 | track.channel, note.pitch, 0] });
    }
    for (const event of track.controllerEvents ?? []) {
      events.push({ tick: event.tick, priority: 2, sequence: sequence++, bytes: [0xb0 | track.channel, event.controller, event.value] });
    }
    for (const event of track.pitchBends ?? []) {
      const bend = Math.max(0, Math.min(16383, event.value + 8192));
      events.push({ tick: event.tick, priority: 2, sequence: sequence++, bytes: [0xe0 | track.channel, bend & 0x7f, (bend >> 7) & 0x7f] });
    }
  }
  return events;
}

function encodeTrack(events: RawEvent[]): Uint8Array {
  const writer = new ByteWriter();
  let previousTick = 0;
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority || a.sequence - b.sequence);
  for (const event of events) {
    writer.vlq(event.tick - previousTick);
    writer.bytes(event.bytes);
    previousTick = event.tick;
  }
  writer.vlq(0);
  writer.bytes([0xff, 0x2f, 0]);
  const content = writer.finish();
  const chunk = new ByteWriter();
  chunk.u32(TRACK_CHUNK);
  chunk.u32(content.length);
  chunk.bytes(content);
  return chunk.finish();
}

function metaText(type: number, text: string): number[] {
  const data = new TextEncoder().encode(text);
  return [0xff, type, ...encodeVlq(data.length), ...data];
}

function decodeText(data: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return new TextDecoder("windows-1252").decode(data); }
}

function normalizedEvents<T extends { tick: number }>(events: T[]): T[] {
  const byTick = new Map<number, T>();
  for (const event of events) byTick.set(event.tick, { ...event });
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

function importedIdFactory(): IdFactory {
  let value = 0;
  return (prefix) => `${prefix}_import_${value++}`;
}

function noteSort(a: MidiNote, b: MidiNote): number {
  return a.startTick - b.startTick || a.pitch - b.pitch || a.id.localeCompare(b.id);
}

function encodeVlq(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) throw new MidiFileError("MIDI delta time must be an integer between 0 and 268435455.");
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>>= 7)) buffer = (buffer << 8) | ((value & 0x7f) | 0x80);
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>>= 8;
    else break;
  }
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

class ByteReader {
  offset = 0;
  constructor(private readonly data: Uint8Array) {}
  get remaining(): number { return this.data.length - this.offset; }
  peekU8(): number { this.ensure(1); return this.data[this.offset]; }
  readU8(): number { this.ensure(1); return this.data[this.offset++]; }
  readU16(): number { return (this.readU8() << 8) | this.readU8(); }
  readU32(): number { return ((this.readU8() * 0x1000000) + (this.readU8() << 16) + (this.readU8() << 8) + this.readU8()) >>> 0; }
  readBytes(length: number): Uint8Array { this.ensure(length); const result = this.data.subarray(this.offset, this.offset + length); this.offset += length; return result; }
  skip(length: number): void { this.ensure(length); this.offset += length; }
  readVlq(): number {
    let value = 0;
    for (let count = 0; count < 4; count += 1) {
      const byte = this.readU8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new MidiFileError("Variable-length value exceeds four bytes.", this.offset - 4);
  }
  private ensure(length: number): void { if (!Number.isInteger(length) || length < 0 || this.remaining < length) throw new MidiFileError("Unexpected end of MIDI data.", this.offset); }
}

class ByteWriter {
  private data: number[] = [];
  u16(value: number): void { this.data.push((value >>> 8) & 0xff, value & 0xff); }
  u32(value: number): void { this.data.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff); }
  vlq(value: number): void { this.data.push(...encodeVlq(value)); }
  bytes(value: ArrayLike<number>): void { for (let index = 0; index < value.length; index += 1) this.data.push(value[index]); }
  finish(): Uint8Array { return Uint8Array.from(this.data); }
}
