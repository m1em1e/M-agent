import type { MidiEditOperation, MidiProject } from "../../../shared/midi.js";

/**
 * 多 Skill 结果的确定性合并引擎。
 * 规则：同 noteId 的 update/delete 冲突、delete 后 update、同位置重复 insert、
 * track delete 与 note 操作冲突、tick/循环范围冲突、超 operation/note 上限。
 * 合并原则：先到先得（父调用顺序即意图顺序），绝不「最后一个 Skill 获胜」；
 * 无法安全解决时记录 warning，不静默覆盖。
 */

export interface SkillOperationSource {
  source: string;
  operations: MidiEditOperation[];
  warnings?: string[];
}

export interface MergeResult {
  operations: MidiEditOperation[];
  warnings: string[];
  affectedNotes: number;
}

export function mergeSkillOperations(
  sources: SkillOperationSource[],
  project?: MidiProject,
  limits: { maximumOperations?: number; maximumAffectedNotes?: number } = {},
): MergeResult {
  const maximumOperations = limits.maximumOperations ?? 500;
  const maximumAffectedNotes = limits.maximumAffectedNotes ?? 10_000;
  const warnings: string[] = [];
  const accepted: MidiEditOperation[] = [];

  const deletedTracks = new Set<string>();
  const createdTracks = new Set<string>();
  const updatedTracks = new Set<string>();
  const deletedNotes = new Set<string>();
  const updatedNotes = new Set<string>();
  const insertedPositions = new Set<string>();
  const tempoTicks = new Set<number>();
  const signatureTicks = new Set<number>();
  const loopRanges: Array<[number, number]> = [];

  const warn = (source: string, message: string) => warnings.push(`[${source}] ${message}`);

  const dropTrackNoteState = (trackId: string) => {
    for (const key of [...deletedNotes]) if (key.startsWith(`${trackId}:`)) deletedNotes.delete(key);
    for (const key of [...updatedNotes]) if (key.startsWith(`${trackId}:`)) updatedNotes.delete(key);
    for (const key of [...insertedPositions]) if (key.startsWith(`${trackId}:`)) insertedPositions.delete(key);
  };

  for (const source of sources) {
    for (const operation of source.operations) {
      switch (operation.type) {
        case "insert_notes": {
          if (deletedTracks.has(operation.trackId)) {
            warn(source.source, `insert_notes 落在已删除轨道 ${operation.trackId} 上，已忽略`);
            break;
          }
          const notes = operation.notes.filter((note) => {
            const key = `${operation.trackId}:${note.pitch}:${note.startTick}`;
            if (insertedPositions.has(key)) {
              warn(source.source, `同位置重复 insert（轨道 ${operation.trackId} @${note.startTick} pitch ${note.pitch}），保留先到者`);
              return false;
            }
            insertedPositions.add(key);
            return true;
          });
          if (notes.length > 0) accepted.push({ ...operation, notes });
          break;
        }
        case "update_notes": {
          if (deletedTracks.has(operation.trackId)) {
            warn(source.source, `update_notes 落在已删除轨道 ${operation.trackId} 上，已忽略`);
            break;
          }
          const changes = operation.changes.filter((change) => {
            const key = `${operation.trackId}:${change.noteId}`;
            if (deletedNotes.has(key) || updatedNotes.has(key)) {
              warn(source.source, `音符 ${key} 已被删除或修改，冲突的 update_notes 已忽略`);
              return false;
            }
            updatedNotes.add(key);
            return true;
          });
          if (changes.length > 0) accepted.push({ ...operation, changes });
          break;
        }
        case "delete_notes": {
          if (deletedTracks.has(operation.trackId)) {
            warn(source.source, `delete_notes 落在已删除轨道 ${operation.trackId} 上，已忽略`);
            break;
          }
          const noteIds = operation.noteIds.filter((id) => {
            const key = `${operation.trackId}:${id}`;
            if (deletedNotes.has(key) || updatedNotes.has(key)) {
              warn(source.source, `音符 ${key} 已有先到的删除/修改，冲突的 delete_notes 已忽略`);
              return false;
            }
            deletedNotes.add(key);
            return true;
          });
          if (noteIds.length > 0) accepted.push({ ...operation, noteIds });
          break;
        }
        case "create_track": {
          if (operation.track?.id && createdTracks.has(operation.track.id)) {
            warn(source.source, `重复创建轨道 ${operation.track.id}，已忽略`);
            break;
          }
          if (operation.track?.id) createdTracks.add(operation.track.id);
          accepted.push(operation);
          break;
        }
        case "delete_track": {
          if (deletedTracks.has(operation.trackId)) {
            warn(source.source, `轨道 ${operation.trackId} 已被删除，重复 delete_track 已忽略`);
            break;
          }
          deletedTracks.add(operation.trackId);
          const removed = accepted.length;
          const filtered = accepted.filter((item) => !("trackId" in item && item.trackId === operation.trackId));
          const removedCount = removed - filtered.length;
          if (removedCount > 0) warn(source.source, `轨道 ${operation.trackId} 被删除，移除了 ${removedCount} 个冲突的音符/轨道操作`);
          dropTrackNoteState(operation.trackId);
          accepted.length = 0;
          accepted.push(...filtered);
          accepted.push(operation);
          break;
        }
        case "update_track": {
          if (deletedTracks.has(operation.trackId)) {
            warn(source.source, `update_track 落在已删除轨道 ${operation.trackId} 上，已忽略`);
            break;
          }
          if (updatedTracks.has(operation.trackId)) {
            warn(source.source, `轨道 ${operation.trackId} 已有先到的 update_track，冲突项已忽略`);
            break;
          }
          updatedTracks.add(operation.trackId);
          accepted.push(operation);
          break;
        }
        case "set_tempo": {
          if (tempoTicks.has(operation.tick)) {
            warn(source.source, `tick ${operation.tick} 已有先到的 set_tempo，冲突项已忽略`);
            break;
          }
          tempoTicks.add(operation.tick);
          accepted.push(operation);
          break;
        }
        case "set_time_signature": {
          if (signatureTicks.has(operation.tick)) {
            warn(source.source, `tick ${operation.tick} 已有先到的 set_time_signature，冲突项已忽略`);
            break;
          }
          signatureTicks.add(operation.tick);
          accepted.push(operation);
          break;
        }
        case "set_loop": {
          if (loopRanges.some(([start, end]) => operation.startTick < end && start < operation.endTick)) {
            warn(source.source, `循环区 ${operation.startTick}..${operation.endTick} 与已有循环区重叠，已忽略`);
            break;
          }
          loopRanges.push([operation.startTick, operation.endTick]);
          accepted.push(operation);
          break;
        }
        case "clear_loop": {
          if (loopRanges.length > 0) {
            warn(source.source, `已有 set_loop，冲突的 clear_loop 已忽略`);
            break;
          }
          accepted.push(operation);
          break;
        }
      }
    }
  }

  if (accepted.length > maximumOperations) {
    warnings.push(`合并后操作数 ${accepted.length} 超过上限 ${maximumOperations}，多余操作已截断`);
    accepted.length = maximumOperations;
  }

  const affectedNotes = countAffectedNotes(accepted, project);
  if (affectedNotes > maximumAffectedNotes) {
    warnings.push(`合并后受影响音符 ${affectedNotes} 超过上限 ${maximumAffectedNotes}`);
  }

  return { operations: accepted, warnings, affectedNotes };
}

function countAffectedNotes(operations: MidiEditOperation[], project?: MidiProject): number {
  let count = 0;
  for (const operation of operations) {
    switch (operation.type) {
      case "insert_notes": count += operation.notes.length; break;
      case "delete_notes": count += operation.noteIds.length; break;
      case "update_notes": count += operation.changes.length; break;
      case "create_track": count += operation.track?.notes?.length ?? 0; break;
      case "delete_track": {
        const track = project?.tracks.find((item) => item.id === operation.trackId);
        count += track?.notes.length ?? 0;
        break;
      }
      default: break;
    }
  }
  return count;
}
