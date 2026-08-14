import type {
  AgentProvider,
  AgentProviderRequest,
  AgentProviderResponse,
} from "./types.js";

export interface OpenAIResponsesProviderOptions {
  apiKey: string | (() => string | Promise<string>);
  model?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  organization?: string;
  project?: string;
}

interface ResponsesApiResult {
  output_text?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  error?: {
    message?: unknown;
  };
}

const NOTE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pitch", "startTick", "durationTicks", "velocity"],
  properties: {
    pitch: { type: "integer", minimum: 0, maximum: 127 },
    startTick: { type: "integer", minimum: 0 },
    durationTicks: { type: "integer", minimum: 1 },
    velocity: { type: "integer", minimum: 1, maximum: 127 },
  },
} as const;

const TRACK_CHANGES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "role", "channel", "program", "muted", "solo"],
  properties: {
    name: { type: "string", minLength: 1 },
    role: { type: "string", enum: ["melody", "harmony", "bass", "drums", "other"] },
    channel: { type: "integer", minimum: 0, maximum: 15 },
    program: { type: "integer", minimum: 0, maximum: 127 },
    muted: { type: "boolean" },
    solo: { type: "boolean" },
  },
} as const;

const OPERATION_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "trackId", "notes"],
      properties: {
        type: { type: "string", const: "insert_notes" },
        trackId: { type: "string", minLength: 1 },
        notes: { type: "array", minItems: 1, items: NOTE_INPUT_SCHEMA },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "trackId", "noteIds"],
      properties: {
        type: { type: "string", const: "delete_notes" },
        trackId: { type: "string", minLength: 1 },
        noteIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "trackId", "changes"],
      properties: {
        type: { type: "string", const: "update_notes" },
        trackId: { type: "string", minLength: 1 },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["noteId", "pitch", "startTick", "durationTicks", "velocity"],
            properties: {
              noteId: { type: "string", minLength: 1 },
              pitch: { type: "integer", minimum: 0, maximum: 127 },
              startTick: { type: "integer", minimum: 0 },
              durationTicks: { type: "integer", minimum: 1 },
              velocity: { type: "integer", minimum: 1, maximum: 127 },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "track"],
      properties: {
        type: { type: "string", const: "create_track" },
        track: {
          ...TRACK_CHANGES_SCHEMA,
          required: [...TRACK_CHANGES_SCHEMA.required, "notes"],
          properties: {
            ...TRACK_CHANGES_SCHEMA.properties,
            notes: { type: "array", items: NOTE_INPUT_SCHEMA },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "trackId"],
      properties: {
        type: { type: "string", const: "delete_track" },
        trackId: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "trackId", "changes"],
      properties: {
        type: { type: "string", const: "update_track" },
        trackId: { type: "string", minLength: 1 },
        changes: TRACK_CHANGES_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "tick", "bpm"],
      properties: {
        type: { type: "string", const: "set_tempo" },
        tick: { type: "integer", minimum: 0 },
        bpm: { type: "number", minimum: 20, maximum: 400 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "tick", "numerator", "denominator"],
      properties: {
        type: { type: "string", const: "set_time_signature" },
        tick: { type: "integer", minimum: 0 },
        numerator: { type: "integer", minimum: 1, maximum: 32 },
        denominator: { type: "integer", enum: [1, 2, 4, 8, 16, 32] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "startTick", "endTick"],
      properties: {
        type: { type: "string", const: "set_loop" },
        startTick: { type: "integer", minimum: 0 },
        endTick: { type: "integer", minimum: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: { type: { type: "string", const: "clear_loop" } },
    },
  ],
} as const;

const CHANGE_SET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["analysis", "proposedChangeSets"],
  properties: {
    analysis: { type: "string" },
    proposedChangeSets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "summary",
          "operations",
          "validation",
          "estimatedAffectedNotes",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          operations: { type: "array", items: OPERATION_SCHEMA, minItems: 1 },
          validation: {
            type: "array",
            maxItems: 0,
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {},
            },
          },
          estimatedAffectedNotes: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractOutputText(result: ResponsesApiResult): string {
  if (typeof result.output_text === "string" && result.output_text.trim()) {
    return result.output_text;
  }
  if (!Array.isArray(result.output)) return "";
  const chunks: string[] = [];
  for (const item of result.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (typeof content.text === "string") chunks.push(content.text);
      if (isRecord(content.text) && typeof content.text.value === "string") {
        chunks.push(content.text.value);
      }
    }
  }
  return chunks.join("");
}

function parseProviderOutput(text: string): Pick<AgentProviderResponse, "analysis" | "proposedChangeSets"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new OpenAIResponsesProviderError(
      "INVALID_RESPONSE_JSON",
      error instanceof Error ? error.message : "The response was not valid JSON.",
    );
  }
  if (!isRecord(parsed) || typeof parsed.analysis !== "string" || !Array.isArray(parsed.proposedChangeSets)) {
    throw new OpenAIResponsesProviderError(
      "INVALID_RESPONSE_SHAPE",
      "The response did not contain analysis and proposedChangeSets.",
    );
  }
  return {
    analysis: parsed.analysis,
    proposedChangeSets: parsed.proposedChangeSets,
  };
}

export class OpenAIResponsesProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenAIResponsesProviderError";
  }
}

/** OpenAI Responses API adapter. It has no credential persistence responsibility. */
export class OpenAIResponsesProvider implements AgentProvider {
  readonly id = "openai-responses";
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    this.model = options.model ?? "gpt-5-mini";
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation) {
      throw new OpenAIResponsesProviderError("FETCH_UNAVAILABLE", "A fetch implementation is required.");
    }
  }

  async generate(
    request: Readonly<AgentProviderRequest>,
    signal?: AbortSignal,
  ): Promise<AgentProviderResponse> {
    const apiKey = typeof this.options.apiKey === "function"
      ? await this.options.apiKey()
      : this.options.apiKey;
    if (!apiKey.trim()) {
      throw new OpenAIResponsesProviderError("MISSING_API_KEY", "An OpenAI API key is required.");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.options.organization) headers["OpenAI-Organization"] = this.options.organization;
    if (this.options.project) headers["OpenAI-Project"] = this.options.project;

    const response = await this.fetchImplementation(this.endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: this.model,
        instructions:
          "You are a game-music MIDI planning agent. Return proposed structured edit operations only. Never claim to write, apply, export, or overwrite files. Keep all MIDI values within legal bounds.",
        input: JSON.stringify({
          mode: request.mode,
          objective: request.objective,
          project: request.project,
          constraints: request.constraints ?? {},
          iteration: request.iteration,
          maxCandidates: request.maxCandidates,
          previousCandidates: request.previousCandidates,
          remainingBudget: request.remainingBudget,
        }),
        text: {
          format: {
            type: "json_schema",
            name: "midi_agent_candidates",
            strict: true,
            schema: CHANGE_SET_SCHEMA,
          },
        },
      }),
    });

    let result: ResponsesApiResult;
    try {
      result = (await response.json()) as ResponsesApiResult;
    } catch {
      throw new OpenAIResponsesProviderError(
        "INVALID_HTTP_RESPONSE",
        `OpenAI returned a non-JSON response (${response.status}).`,
        response.status,
      );
    }
    if (!response.ok) {
      const message = typeof result.error?.message === "string"
        ? result.error.message
        : `OpenAI request failed with status ${response.status}.`;
      throw new OpenAIResponsesProviderError("HTTP_ERROR", message, response.status);
    }

    const output = extractOutputText(result);
    if (!output) {
      throw new OpenAIResponsesProviderError("EMPTY_RESPONSE", "OpenAI returned no text output.");
    }
    const parsed = parseProviderOutput(output);
    const inputTokens = typeof result.usage?.input_tokens === "number"
      ? result.usage.input_tokens
      : undefined;
    const outputTokens = typeof result.usage?.output_tokens === "number"
      ? result.usage.output_tokens
      : undefined;
    return {
      ...parsed,
      usage: {
        costUnits: 1,
        inputTokens,
        outputTokens,
      },
    };
  }
}
