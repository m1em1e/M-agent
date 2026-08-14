import { randomUUID } from "node:crypto";
import { runPiKernel } from "../core/agent/pi-kernel.js";
import type { AgentRequestPayload, AgentResponsePayload } from "../shared/bridge.js";
import {
  DEFAULT_CONVERSATION_SETTINGS,
  GOAL_MAX_TOKENS_RANGE,
  GOAL_MAX_TURNS_RANGE,
  PI_THINKING_LEVELS,
  type ConversationSettings,
} from "../shared/conversation-settings.js";
import { rendererPayloadToProject } from "./project-adapter.js";
import type { AgentAuthentication } from "./environment-service.js";
import { recordUsage } from "./usage-store.js";

/**
 * Main-process orchestration boundary. Every cloud or offline request runs
 * through the Pi Agent kernel; this service never calls a model API directly.
 */
export async function runAgent(
  input: unknown,
  authentication: AgentAuthentication,
  signal?: AbortSignal,
): Promise<AgentResponsePayload> {
  assertAgentRequestPayload(input);
  const payload = input;
  const conversation = payload.conversation ?? DEFAULT_CONVERSATION_SETTINGS;
  const result = await runPiKernel({
    requestId: randomUUID(),
    mode: payload.mode,
    objective: payload.objective.trim(),
    project: rendererPayloadToProject(payload.project),
    provider: authentication?.provider,
    apiKey: authentication?.provider === "openai" ? authentication.apiKey : undefined,
    credentials: authentication?.provider === "openai" || authentication?.provider === "openai-codex"
      ? authentication.credentials
      : undefined,
    customProvider: authentication?.provider === "custom" ? authentication.customProvider : undefined,
    modelId: authentication?.provider === "custom"
      ? (authentication.customProvider.activeModelId ?? authentication.customProvider.models[0]?.id)
      : authentication?.provider === "openai-codex" ? "gpt-5.4-mini" : "gpt-5-mini",
    maximumTurns: payload.mode === "goal" ? conversation.goalMaxTurns : 2,
    maximumOutputTokens: payload.mode === "goal" ? conversation.goalMaxTokens : DEFAULT_CONVERSATION_SETTINGS.goalMaxTokens,
    thinkingLevel: conversation.thinkingLevel,
    projectInjection: conversation.projectInjection,
    focusTrackId: payload.focusTrackId,
    signal,
  });
  if (result.provider !== "pi-offline") {
    recordUsage({
      timestamp: Date.now(),
      day: localDayKey(new Date()),
      modelId: result.modelId,
      modelName: result.modelId,
      turns: result.turns,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      cost: result.cost,
    });
  }
  return {
    analysis: result.analysis,
    candidates: result.candidates,
    kernel: "pi",
    provider: result.provider,
    turns: result.turns,
    thinking: result.thinking,
    effectiveThinkingLevel: result.effectiveThinkingLevel,
    modelId: result.modelId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    cost: result.cost,
  };
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function assertAgentRequestPayload(value: unknown): asserts value is AgentRequestPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Agent 请求必须是对象。");
  }
  const request = value as Partial<AgentRequestPayload>;
  if (request.mode !== "research" && request.mode !== "plan" && request.mode !== "goal") {
    throw new Error("Agent 模式无效。");
  }
  if (typeof request.objective !== "string" || request.objective.trim().length === 0) {
    throw new Error("Agent 目标不能为空。");
  }
  if (request.objective.length > 16_000) {
    throw new Error("Agent 目标过长。");
  }
  if (!request.project || typeof request.project !== "object") {
    throw new Error("Agent 请求缺少 MIDI 工程。");
  }
  if (request.conversation !== undefined) assertConversationSettings(request.conversation);
  if (request.focusTrackId !== undefined && (typeof request.focusTrackId !== "string" || !request.focusTrackId.trim())) {
    throw new Error("选中轨道 id 无效。");
  }
}

function assertConversationSettings(value: unknown): asserts value is ConversationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("对话设置必须是对象。");
  const settings = value as Partial<ConversationSettings>;
  if (typeof settings.showThinking !== "boolean") throw new Error("显示思考过程设置无效。");
  if (typeof settings.thinkingLevel !== "string" || !(PI_THINKING_LEVELS as readonly string[]).includes(settings.thinkingLevel)) {
    throw new Error("默认 thinking 设置无效。");
  }
  if (!Number.isSafeInteger(settings.goalMaxTurns)
    || settings.goalMaxTurns! < GOAL_MAX_TURNS_RANGE.minimum
    || settings.goalMaxTurns! > GOAL_MAX_TURNS_RANGE.maximum) {
    throw new Error(`目标最大轮次必须是 ${GOAL_MAX_TURNS_RANGE.minimum}–${GOAL_MAX_TURNS_RANGE.maximum} 的整数。`);
  }
  if (!Number.isSafeInteger(settings.goalMaxTokens)
    || settings.goalMaxTokens! < GOAL_MAX_TOKENS_RANGE.minimum
    || settings.goalMaxTokens! > GOAL_MAX_TOKENS_RANGE.maximum) {
    throw new Error(`目标最大 Token 必须是 ${GOAL_MAX_TOKENS_RANGE.minimum}–${GOAL_MAX_TOKENS_RANGE.maximum} 的整数。`);
  }
  if (settings.projectInjection !== undefined && settings.projectInjection !== "all" && settings.projectInjection !== "selected") {
    throw new Error("工程注入方式无效。");
  }
}
