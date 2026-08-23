import { randomUUID } from "node:crypto";
import {
  createSession,
  getSessionMeta,
  updateSessionMeta,
} from "../agent/session-store";
import { getBotProfileRecord } from "./bot-profile-service";
import type {
  BotSidecarBridgeRequest,
  BotSidecarBridgeResult,
  BotSidecarState,
  CloseBotSidecarInput,
  OpenBotSidecarInput,
} from "@tagent/shared";

const sidecars = new Map<string, BotSidecarState>();

function requireText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(label + " 不能为空");
  return text;
}

/** 为“主会话 + Bot”场景创建/恢复隐藏专属 session；不同主会话上下文严格隔离。 */
export function ensureBotSidecarSession(input: {
  sessionId: string;
  botProfileId: string;
}): string {
  const record = getBotProfileRecord(input.botProfileId);
  if (!record) throw new Error("Bot 不存在：" + input.botProfileId);
  const revision = record.revisions.find(
    (item) => item.id === record.profile.currentConfigRevisionId,
  );
  if (!revision) throw new Error("Bot 当前 revision 不存在");
  const safeSessionId = input.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeBotId = input.botProfileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const agentSessionId = "bot_sidecar_" + safeSessionId + "_" + safeBotId;
  const parentMeta = getSessionMeta(input.sessionId);
  // Bot revision 未显式配置渠道/模型时，旁路沿用打开它的主会话配置，
  // 确保角色库创建的 Bot 也能立即使用，而不需要先重复配置一遍模型。
  const channelId = revision.channelId ?? parentMeta?.channelId;
  const modelId =
    revision.modelId ?? (revision.channelId ? undefined : parentMeta?.modelId);
  const existing = getSessionMeta(agentSessionId);
  if (!existing) {
    createSession({
      id: agentSessionId,
      title: "Bot · " + record.profile.displayName,
      channelId,
      modelId,
      workspaceId: parentMeta?.workspaceId,
      executionMode: "chat",
    });
  }
  updateSessionMeta(agentSessionId, {
    hidden: true,
    botProfileIds: [input.botProfileId],
    channelId,
    modelId,
    workspaceId: parentMeta?.workspaceId,
  });
  return agentSessionId;
}

/**
 * Bot 旁路生命周期登记。
 *
 * 这里管理“旁路窗口与主会话的桥接关系”，Bot 自己的上下文由隐藏专属 session
 * 持久化；旁路文本仍需通过正式 steerAgent 才能写入主会话。
 */
export function openBotSidecar(input: OpenBotSidecarInput): BotSidecarState {
  const sessionId = requireText(input?.sessionId, "sessionId");
  const botProfileId = requireText(input?.botProfileId, "botProfileId");
  const now = Date.now();
  const agentSessionId = ensureBotSidecarSession({ sessionId, botProfileId });
  const existing = [...sidecars.values()].find(
    (state) =>
      state.sessionId === sessionId && state.botProfileId === botProfileId,
  );
  if (existing) {
    const updated = {
      ...existing,
      agentSessionId,
      lifecycle: "open" as const,
      updatedAt: now,
    };
    sidecars.set(existing.sidecarId, updated);
    return updated;
  }
  const state: BotSidecarState = {
    sidecarId: "sidecar_" + randomUUID(),
    sessionId,
    botProfileId,
    agentSessionId,
    lifecycle: "open",
    openedAt: now,
    updatedAt: now,
  };
  sidecars.set(state.sidecarId, state);
  return state;
}

export function closeBotSidecar(
  input: CloseBotSidecarInput,
): BotSidecarState | null {
  const sidecarId = requireText(input?.sidecarId, "sidecarId");
  const state = sidecars.get(sidecarId);
  if (!state) return null;
  const updated = {
    ...state,
    lifecycle: "closed" as const,
    updatedAt: Date.now(),
  };
  sidecars.set(sidecarId, updated);
  return updated;
}

export function minimizeBotSidecar(sidecarId: string): BotSidecarState | null {
  const id = requireText(sidecarId, "sidecarId");
  const state = sidecars.get(id);
  if (!state) return null;
  const updated = {
    ...state,
    lifecycle: "minimized" as const,
    updatedAt: Date.now(),
  };
  sidecars.set(id, updated);
  return updated;
}

export function bridgeBotSidecarRequest(
  input: BotSidecarBridgeRequest,
): BotSidecarBridgeResult {
  const state = sidecars.get(requireText(input?.sidecarId, "sidecarId"));
  if (!state || state.lifecycle === "closed") {
    return { ok: false, accepted: false, error: "旁路窗口已关闭或不存在" };
  }
  if (state.sessionId !== requireText(input?.sessionId, "sessionId")) {
    return { ok: false, accepted: false, error: "旁路窗口不属于当前会话" };
  }
  if (state.botProfileId !== requireText(input?.botProfileId, "botProfileId")) {
    return { ok: false, accepted: false, error: "旁路窗口不属于当前 Bot" };
  }
  if (!requireText(input?.content, "content")) {
    return { ok: false, accepted: false, error: "桥接内容为空" };
  }
  return { ok: true, accepted: true };
}

export function clearBotSidecars(): void {
  sidecars.clear();
}
