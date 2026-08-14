import type { AgentMode, AgentToolName } from "./types.js";

const READ_TOOLS: ReadonlySet<AgentToolName> = new Set([
  "project.read",
  "project.analyze",
  "playback.preview",
]);

const PLAN_TOOLS: ReadonlySet<AgentToolName> = new Set([
  ...READ_TOOLS,
  "changes.propose",
  "changes.simulate",
  "changes.validate",
]);

const GOAL_TOOLS: ReadonlySet<AgentToolName> = new Set([
  ...PLAN_TOOLS,
  "candidate.score",
]);

const PERMISSIONS: Readonly<Record<AgentMode, ReadonlySet<AgentToolName>>> = {
  research: READ_TOOLS,
  plan: PLAN_TOOLS,
  goal: GOAL_TOOLS,
};

export class AgentToolPermissionError extends Error {
  readonly code = "AGENT_TOOL_FORBIDDEN";

  constructor(
    readonly mode: AgentMode,
    readonly tool: AgentToolName,
  ) {
    super(`Agent mode "${mode}" is not allowed to use tool "${tool}".`);
    this.name = "AgentToolPermissionError";
  }
}

export function canAgentUseTool(mode: AgentMode, tool: AgentToolName): boolean {
  return PERMISSIONS[mode].has(tool);
}

export function assertAgentToolAllowed(
  mode: AgentMode,
  tool: AgentToolName,
): void {
  if (!canAgentUseTool(mode, tool)) {
    throw new AgentToolPermissionError(mode, tool);
  }
}

export function allowedToolsForMode(mode: AgentMode): readonly AgentToolName[] {
  return [...PERMISSIONS[mode]];
}

export type AgentToolHandler<TInput = unknown, TResult = unknown> = (
  input: TInput,
  signal?: AbortSignal,
) => Promise<TResult> | TResult;

/**
 * The only model-facing tool dispatcher. Authorization happens before handler
 * lookup and execution, so even a registered mutation handler cannot be used
 * by an agent accidentally.
 */
export class AgentToolExecutor {
  private readonly handlers = new Map<AgentToolName, AgentToolHandler>();

  register<TInput, TResult>(
    name: AgentToolName,
    handler: AgentToolHandler<TInput, TResult>,
  ): void {
    this.handlers.set(name, handler as AgentToolHandler);
  }

  async execute<TResult>(
    mode: AgentMode,
    name: AgentToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<TResult> {
    assertAgentToolAllowed(mode, name);
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Agent tool "${name}" is not registered.`);
    }
    return (await handler(input, signal)) as TResult;
  }
}
