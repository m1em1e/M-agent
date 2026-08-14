import { createId, createMidiProject, createMidiTrack, validateProject } from "../core/midi/index.js";
import type { MidiProject } from "../shared/midi.js";
import type { RendererProjectPayload } from "../shared/bridge.js";

export function rendererPayloadToProject(payload: RendererProjectPayload): MidiProject {
  assertRendererProjectPayload(payload);
  const project = createMidiProject({
    id: payload.id,
    title: payload.title ?? "Untitled",
    ppq: payload.ppq,
    bpm: payload.tempo,
  });
  if (payload.tempoMap) project.tempoMap = payload.tempoMap.map((event) => ({ ...event }));
  if (payload.timeSignatures) project.timeSignatures = payload.timeSignatures.map((event) => ({ ...event }));
  if (payload.loopRegion !== undefined) project.loopRegion = payload.loopRegion ? { ...payload.loopRegion } : null;
  if (payload.revisions) project.revisions = payload.revisions.map((revision) => ({ ...revision }));
  if (payload.agentSessions) {
    project.agentSessions = payload.agentSessions.map((session) => ({
      ...session,
      acceptedChangeSetIds: [...session.acceptedChangeSetIds],
    }));
  }
  project.tracks = payload.tracks.map((track, index) =>
    createMidiTrack({
      id: track.id || createId("track"),
      name: track.name,
      role: track.role,
      channel: track.channel ?? (track.role === "drums" ? 9 : Math.min(index, 15)),
      program: track.program,
      muted: track.muted,
      solo: track.solo,
      notes: track.notes,
    }),
  );
  const validation = validateProject(project);
  if (!validation.valid) {
    throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("; "));
  }
  return project;
}

export function assertProjectFile(value: unknown): asserts value is MidiProject {
  if (!isRecord(value)) throw new Error("工程文件不是有效的 JSON 对象。");
  if (typeof value.id !== "string" || typeof value.title !== "string") {
    throw new Error("工程文件缺少有效的工程标识或标题。");
  }
  if (!Array.isArray(value.tempoMap) || !Array.isArray(value.timeSignatures)
    || !Array.isArray(value.tracks) || !Array.isArray(value.revisions)
    || !Array.isArray(value.agentSessions)) {
    throw new Error("工程文件结构不完整。");
  }
  assertOptionalMetadata(value);
  assertTrackShapes(value.tracks, "工程文件");
  const validation = validateProject(value as unknown as MidiProject);
  if (!validation.valid) {
    throw new Error(`工程文件校验失败：${validation.issues.map((issue) => issue.message).join("；")}`);
  }
}

export function assertRendererProjectPayload(value: unknown): asserts value is RendererProjectPayload {
  if (!isRecord(value)) throw new Error("MIDI 工程载荷必须是对象。");
  if (value.title !== undefined && typeof value.title !== "string") {
    throw new Error("工程标题必须是字符串。");
  }
  if (typeof value.ppq !== "number" || typeof value.tempo !== "number" || !Array.isArray(value.tracks)) {
    throw new Error("MIDI 工程载荷缺少有效的 PPQ、速度或轨道列表。");
  }
  assertOptionalMetadata(value);
  assertTrackShapes(value.tracks, "MIDI 工程载荷");
}

function assertOptionalMetadata(value: Record<string, unknown>): void {
  if (value.id !== undefined && typeof value.id !== "string") throw new Error("工程标识必须是字符串。");
  if (value.tempoMap !== undefined) {
    if (!Array.isArray(value.tempoMap) || value.tempoMap.some((event) => !hasNumbers(event, "tick", "bpm"))) {
      throw new Error("速度图结构无效。");
    }
  }
  if (value.timeSignatures !== undefined) {
    if (!Array.isArray(value.timeSignatures)
      || value.timeSignatures.some((event) => !hasNumbers(event, "tick", "numerator", "denominator"))) {
      throw new Error("拍号图结构无效。");
    }
  }
  if (value.loopRegion !== undefined && value.loopRegion !== null
    && !hasNumbers(value.loopRegion, "startTick", "endTick")) throw new Error("循环区结构无效。");
  if (value.revisions !== undefined) {
    if (!Array.isArray(value.revisions) || value.revisions.some((revision) => !isRecord(revision)
      || typeof revision.id !== "string" || typeof revision.label !== "string"
      || typeof revision.createdAt !== "string" || typeof revision.source !== "string")) {
      throw new Error("修订历史结构无效。");
    }
  }
  if (value.agentSessions !== undefined) {
    if (!Array.isArray(value.agentSessions) || value.agentSessions.some((session) => !isRecord(session)
      || typeof session.id !== "string" || typeof session.mode !== "string"
      || typeof session.createdAt !== "string" || typeof session.prompt !== "string"
      || !Array.isArray(session.acceptedChangeSetIds)
      || session.acceptedChangeSetIds.some((id) => typeof id !== "string"))) {
      throw new Error("Agent 会话结构无效。");
    }
  }
}

function hasNumbers(value: unknown, ...keys: string[]): value is Record<string, number> {
  return isRecord(value) && keys.every((key) => typeof value[key] === "number");
}

function assertTrackShapes(tracks: unknown[], context: string): void {
  if (tracks.length > 256) throw new Error(`${context}的轨道数量超过上限。`);
  let noteCount = 0;
  for (const [trackIndex, value] of tracks.entries()) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string"
      || !isTrackRole(value.role) || typeof value.channel !== "number"
      || typeof value.program !== "number" || typeof value.muted !== "boolean"
      || typeof value.solo !== "boolean" || !Array.isArray(value.notes)) {
      throw new Error(`${context}的第 ${trackIndex + 1} 条轨道结构无效。`);
    }
    noteCount += value.notes.length;
    if (noteCount > 200_000) throw new Error(`${context}的音符数量超过上限。`);
    for (const [noteIndex, note] of value.notes.entries()) {
      if (!isRecord(note) || typeof note.id !== "string" || typeof note.pitch !== "number"
        || typeof note.startTick !== "number" || typeof note.durationTicks !== "number"
        || typeof note.velocity !== "number") {
        throw new Error(`${context}的第 ${trackIndex + 1} 条轨道中，第 ${noteIndex + 1} 个音符结构无效。`);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTrackRole(value: unknown): value is RendererProjectPayload["tracks"][number]["role"] {
  return value === "melody" || value === "harmony" || value === "bass" || value === "drums" || value === "other";
}
