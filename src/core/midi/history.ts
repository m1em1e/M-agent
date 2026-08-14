import type { MidiProject, ProposedChangeSet } from "../../shared/midi.js";
import { applyChangeSet, type ApplyChangeSetOptions, type ApplyChangeSetResult } from "./edits.js";
import { cloneMidiProject } from "./project.js";

export class MidiTransactionHistory {
  private past: MidiProject[] = [];
  private future: MidiProject[] = [];
  private current: MidiProject;

  constructor(initialProject: MidiProject, private readonly capacity = 50) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("History capacity must be a positive integer.");
    this.current = cloneMidiProject(initialProject);
  }

  get project(): MidiProject {
    return cloneMidiProject(this.current);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  apply(changeSet: ProposedChangeSet, options: ApplyChangeSetOptions = {}): ApplyChangeSetResult {
    const result = applyChangeSet(this.current, changeSet, options);
    this.past.push(cloneMidiProject(this.current));
    if (this.past.length > this.capacity) this.past.shift();
    this.current = result.project;
    this.future = [];
    return { project: this.project, validation: result.validation };
  }

  undo(): MidiProject | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(cloneMidiProject(this.current));
    this.current = previous;
    return this.project;
  }

  redo(): MidiProject | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(cloneMidiProject(this.current));
    this.current = next;
    return this.project;
  }

  reset(project: MidiProject): void {
    this.current = cloneMidiProject(project);
    this.past = [];
    this.future = [];
  }
}
