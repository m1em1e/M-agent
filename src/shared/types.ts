/**
 * Compatibility entry point for application layers. New MIDI-only code may
 * import from `shared/midi`; cross-cutting layers can keep using this module.
 */
export * from "./midi.js";
