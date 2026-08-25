/**
 * 工程内容哈希：用于候选绑定工程版本（P1-4）。
 * 对工程载荷做稳定 FNV-1a 哈希，同一内容始终得到同一版本号，
 * 内容变化则版本号变化；应用候选前比对，拒绝过期候选。
 */

export interface ProjectVersionTrackSource {
  id: string;
  name: string;
  role: string;
  channel?: number;
  program: number;
  muted: boolean;
  solo: boolean;
  loopRegion?: { startTick: number; endTick: number } | null;
  notes: Array<{ id?: string; pitch: number; startTick: number; durationTicks: number; velocity: number }>;
  controllerEvents?: Array<{ id?: string; tick: number; controller: number; value: number }>;
}

export interface ProjectVersionSource {
  id?: string;
  title?: string;
  ppq: number;
  tempo: number;
  tracks: ProjectVersionTrackSource[];
  tempoMap?: Array<{ tick: number; bpm: number }>;
  timeSignatures?: Array<{ tick: number; numerator: number; denominator: number }>;
  loopRegion?: { startTick: number; endTick: number } | null;
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 计算工程内容哈希（稳定、与轨道顺序相关）。 */
export function projectVersionOf(payload: ProjectVersionSource): string {
  const canonical: ProjectVersionSource = {
    id: payload.id ?? "",
    title: payload.title ?? "",
    ppq: payload.ppq,
    tempo: payload.tempo,
    tracks: payload.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      role: track.role,
      channel: track.channel,
      program: track.program,
      muted: track.muted,
      solo: track.solo,
      loopRegion: track.loopRegion ? { ...track.loopRegion } : track.loopRegion ?? undefined,
      notes: track.notes.map((note) => ({
        pitch: note.pitch,
        startTick: note.startTick,
        durationTicks: note.durationTicks,
        velocity: note.velocity,
      })),
      controllerEvents: (track.controllerEvents ?? []).map((event) => ({
        tick: event.tick,
        controller: event.controller,
        value: event.value,
      })),
    })),
    tempoMap: (payload.tempoMap ?? []).map((event) => ({ tick: event.tick, bpm: event.bpm })),
    timeSignatures: (payload.timeSignatures ?? []).map((event) => ({
      tick: event.tick,
      numerator: event.numerator,
      denominator: event.denominator,
    })),
    loopRegion: payload.loopRegion ? { ...payload.loopRegion } : null,
  };
  return hashString(JSON.stringify(canonical));
}
