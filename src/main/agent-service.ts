import { randomUUID } from "node:crypto";
import { runPiKernel } from "../core/agent/pi-kernel.js";
import type { AgentLiveUpdate, AgentRequestPayload, AgentResponsePayload } from "../shared/bridge.js";
import type { SkillLoader } from "../core/agent/skills/loader.js";
import { createSkillLoader } from "./skill-loader.js";
import { createAgentLogSink } from "./agent-logger.js";
import { listSystemInstruments } from "./audio/library-store.js";
import {
  DEFAULT_CONVERSATION_SETTINGS,
  GOAL_MAX_TOKENS_RANGE,
  GOAL_MAX_TURNS_RANGE,
  PI_THINKING_LEVELS,
  SKILL_TIMEOUT_RANGE,
  type ConversationSettings,
} from "../shared/conversation-settings.js";
import { rendererPayloadToProject } from "./project-adapter.js";
import type { AgentAuthentication } from "./environment-service.js";
import { recordUsage } from "./usage-store.js";
import { isTransientAgentError, delayRetry } from "../core/agent/errors.js";

/**
 * Main-process orchestration boundary. Every cloud or offline request runs
 * through the Pi Agent kernel; this service never calls a model API directly.
 */
export async function runAgent(
  input: unknown,
  authentication: AgentAuthentication,
  signal?: AbortSignal,
  onLive?: (update: AgentLiveUpdate) => void,
): Promise<AgentResponsePayload> {
  assertAgentRequestPayload(input);
  const payload = input;
  const conversation = payload.conversation ?? DEFAULT_CONVERSATION_SETTINGS;
  const skillLoader = createSkillLoader();
  const skillMetas = await skillLoader.list();
  const logger = createAgentLogSink();
  const requestId = randomUUID();
  logger({
    type: "agent.request",
    requestId,
    mode: payload.mode,
    objective: payload.objective,
    focusTrackId: payload.focusTrackId ?? null,
    provider: authentication?.provider ?? null,
    modelId: authentication?.provider === "custom"
      ? (authentication.customProvider.activeModelId ?? authentication.customProvider.models[0]?.id)
      : authentication?.provider === "openai-codex" ? "gpt-5.4-mini" : authentication?.provider === "openai" ? "gpt-5-mini" : null,
    conversation,
    project: payload.project,
  });
  let instruments: Awaited<ReturnType<typeof listSystemInstruments>> = [];
  try {
    instruments = await listSystemInstruments();
  } catch {
    // 音源库不可用时，agent 仍可运行（instrument_search 为空）。
  }
  const { objective, skill } = await resolveTopLevelSkill(payload.objective.trim(), skillLoader);
  const buildRequest = (): Parameters<typeof runPiKernel>[0] => ({
    requestId,
    mode: payload.mode,
    objective,
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
    maximumTurns: payload.mode === "goal"
      ? conversation.goalMaxTurns
      : payload.mode === "research"
        ? conversation.researchMaxTurns
        : 2,
    maximumOutputTokens: payload.mode === "goal" ? conversation.goalMaxTokens : DEFAULT_CONVERSATION_SETTINGS.goalMaxTokens,
    thinkingLevel: conversation.thinkingLevel,
    projectInjection: conversation.projectInjection,
    focusTrackId: payload.focusTrackId,
    childTimeoutMs: conversation.skillTimeoutMs !== undefined
      ? conversation.skillTimeoutMs * 1000
      : undefined,
    skills: skillMetas,
    skillLoader,
    skill,
    instruments,
    onLive,
    logger,
    signal,
  });
  let result: Awaited<ReturnType<typeof runPiKernel>>;
  try {
    result = await runPiKernel(buildRequest());
  } catch (error) {
    // 超时/窗口关闭等中止：runPiKernel 已把原因 + 运行诊断抛回；直接透出，不再用原始流错误。
    if (signal?.aborted) {
      console.warn(`[agent] 请求已中止，上层错误：${error instanceof Error ? error.message : String(error)}`);
      logger({ type: "agent.abort", requestId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    // 瞬时流/网络错误：失败且未产出任何候选时自动重试一次（无副作用，仅重复 token 成本）。
    if (!isTransientAgentError(error)) {
      logger({ type: "agent.error", requestId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const firstMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[agent] 检测到瞬时流错误，重试一次：${firstMessage}`);
    logger({ type: "agent.retry", requestId, error: firstMessage });
    await delayRetry();
    try {
      result = await runPiKernel(buildRequest());
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      logger({ type: "agent.retry_failed", requestId, firstError: firstMessage, error: message });
      console.warn(`[agent] 重试后仍失败：${message}`);
      throw secondError;
    }
  }
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
  const response: AgentResponsePayload = {
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
    projectVersion: payload.projectVersion,
    skillTrace: result.skillTrace,
  };
  logger({ type: "agent.response", requestId, response });
  return response;
}

/**
 * 解析 objective 开头的 @skill-name：解析为顶层 Skill 作用域，并剥掉提及。
 * 未知 Skill 抛错；无 @ 时保持原目标与无 Skill 作用域。
 * 顶层 Skill 的完整 SKILL.md 经 loader 按需加载（progressive disclosure）。
 */
export async function resolveTopLevelSkill(
  objective: string,
  loader: SkillLoader,
): Promise<{ objective: string; skill?: NonNullable<Parameters<typeof runPiKernel>[0]["skill"]> }> {
  const match = /^@([A-Za-z0-9_-]+)(\s+|$)/.exec(objective);
  if (!match) return { objective };
  const name = match[1];
  const skill = await loader.load(name);
  if (!skill) throw new Error(`未找到 Skill：${name}`);
  return {
    objective: objective.slice(match[0].length).trim(),
    skill: { name: skill.name, instructions: skill.instructions, depth: 0 },
  };
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export { isTransientAgentError };

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
  if (settings.skillTimeoutMs !== undefined
    && (!Number.isSafeInteger(settings.skillTimeoutMs)
      || settings.skillTimeoutMs < SKILL_TIMEOUT_RANGE.minimum
      || settings.skillTimeoutMs > SKILL_TIMEOUT_RANGE.maximum)) {
    throw new Error(`子 Skill 超时必须留空或为 ${SKILL_TIMEOUT_RANGE.minimum}–${SKILL_TIMEOUT_RANGE.maximum} 的整数秒。`);
  }
}
