import {
  pattern,
  PPQ,
  TRACK_COLORS,
  uid,
} from "./app-utils";
import type { Candidate, MidiTrack } from "./app-utils";

const initialTracks: MidiTrack[] = [
  {
    id: "track-melody",
    name: "Glass Thread",
    role: "melody",
    color: TRACK_COLORS[0],
    channel: 0,
    program: 11,
    muted: false,
    solo: false,
    notes: pattern([72, 76, 79, 81, 79, 76, 74, 71], PPQ, PPQ * 0.76, 4, 92),
  },
  {
    id: "track-harmony",
    name: "Soft Chords",
    role: "harmony",
    color: TRACK_COLORS[1],
    channel: 1,
    program: 89,
    muted: false,
    solo: false,
    notes: [48, 52, 55, 45, 48, 52, 41, 45, 48, 43, 47, 50].map((pitch, index) => ({
      id: uid("note"),
      pitch,
      startTick: Math.floor(index / 3) * PPQ * 4,
      durationTicks: Math.round(PPQ * 3.7),
      velocity: 58 + (index % 3) * 4,
    })),
  },
  {
    id: "track-bass",
    name: "Night Bass",
    role: "bass",
    color: TRACK_COLORS[2],
    channel: 2,
    program: 38,
    muted: false,
    solo: false,
    notes: pattern([48, 48, 45, 45, 41, 41, 43, 43], PPQ * 2, PPQ * 1.55, 8, 76),
  },
  {
    id: "track-drums",
    name: "Dust Kit",
    role: "drums",
    color: TRACK_COLORS[3],
    channel: 9,
    program: 0,
    muted: false,
    solo: false,
    notes: pattern([36, 42, 38, 42], PPQ / 2, PPQ * 0.16, 2, 72),
  },
];

const seedCandidates: Candidate[] = [
  {
    id: "candidate-a",
    title: "A · 更克制的结尾",
    description: "收窄旋律音域，在第 8 小节留出呼吸，并用上行二度衔接循环起点。",
    score: 92,
    notesAdded: 7,
    notesChanged: 4,
    notesDeleted: 0,
    loopScore: "无缝",
    supported: true,
    sourceMode: "goal",
    changeSet: {
      id: "candidate-a",
      summary: "更克制的结尾",
      operations: [{ type: "insert_notes", trackId: "track-melody", notes: [
        { pitch: 71, startTick: PPQ * 28, durationTicks: Math.round(PPQ * 0.75), velocity: 78 },
        { pitch: 72, startTick: PPQ * 29, durationTicks: Math.round(PPQ * 0.75), velocity: 82 },
        { pitch: 74, startTick: PPQ * 30, durationTicks: Math.round(PPQ * 0.75), velocity: 74 },
        { pitch: 71, startTick: PPQ * 31, durationTicks: Math.round(PPQ * 0.7), velocity: 68 },
      ] }],
      estimatedAffectedNotes: 4,
    },
  },
  {
    id: "candidate-b",
    title: "B · 增加探索感",
    description: "低音改为切分节奏，旋律保留长音，让场景更空旷但不失推进感。",
    score: 86,
    notesAdded: 12,
    notesChanged: 8,
    notesDeleted: 0,
    loopScore: "良好",
    supported: true,
    sourceMode: "goal",
    changeSet: {
      id: "candidate-b",
      summary: "增加探索感",
      operations: [{ type: "insert_notes", trackId: "track-bass", notes: [
        { pitch: 43, startTick: Math.round(PPQ * 24.5), durationTicks: PPQ, velocity: 72 },
        { pitch: 47, startTick: PPQ * 26, durationTicks: Math.round(PPQ * 0.8), velocity: 68 },
        { pitch: 48, startTick: Math.round(PPQ * 27.5), durationTicks: Math.round(PPQ * 1.2), velocity: 75 },
      ] }],
      estimatedAffectedNotes: 3,
    },
  },
];

export { initialTracks, seedCandidates };