import type {
  AgentProvider,
  AgentProviderRequest,
  AgentProviderResponse,
} from "./types.js";

export interface MockAgentProviderOptions {
  responses?: readonly AgentProviderResponse[];
  responseFactory?: (
    request: Readonly<AgentProviderRequest>,
  ) => AgentProviderResponse | Promise<AgentProviderResponse>;
}

/** Deterministic offline provider used by development, demos, and tests. */
export class MockAgentProvider implements AgentProvider {
  readonly id = "offline-mock";
  readonly requests: AgentProviderRequest[] = [];
  private cursor = 0;

  constructor(private readonly options: MockAgentProviderOptions = {}) {}

  async generate(
    request: Readonly<AgentProviderRequest>,
    signal?: AbortSignal,
  ): Promise<AgentProviderResponse> {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    this.requests.push({ ...request, previousCandidates: [...request.previousCandidates] });
    if (this.options.responseFactory) {
      return await this.options.responseFactory(request);
    }
    const configured = this.options.responses?.[this.cursor++];
    if (configured) return configured;

    const firstTrack = request.project.tracks[0];
    const candidateId = `${request.requestId}-mock-${request.iteration}`;
    const proposedChangeSets = firstTrack
      ? [
          {
            id: candidateId,
            summary: `Offline mock variation ${request.iteration}`,
            operations: [
              {
                type: "insert_notes",
                trackId: firstTrack.id,
                notes: [
                  {
                    pitch: 60 + ((request.iteration - 1) % 5),
                    startTick: request.project.ppq * (request.iteration - 1),
                    durationTicks: request.project.ppq,
                    velocity: 88,
                  },
                ],
              },
            ],
            validation: [],
            estimatedAffectedNotes: 1,
          },
        ]
      : [];
    return {
      analysis: firstTrack
        ? "Generated one deterministic offline note candidate."
        : "No track is available for an offline candidate.",
      proposedChangeSets,
      usage: { costUnits: 0 },
    };
  }
}
