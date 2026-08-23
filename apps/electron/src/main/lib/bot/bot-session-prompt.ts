import type { BotMemoryRecord, BotProfileRecord } from "@tagent/shared";
import {
  parseFusionBotMentions,
  resolveSessionFusionRoute,
} from "@tagent/shared";
import { getActiveBotMemories } from "./bot-memory-service";
import { getBotProfileRecord } from "./bot-profile-service";

function currentRevision(record: BotProfileRecord) {
  return (
    record.revisions.find(
      (revision) => revision.id === record.profile.currentConfigRevisionId,
    ) ?? record.revisions[record.revisions.length - 1]
  );
}

function renderMemory(memory: BotMemoryRecord): string {
  return `- ${memory.text.trim()}`;
}

function renderBot(
  record: BotProfileRecord,
  memories: BotMemoryRecord[],
): string {
  const revision = currentRevision(record);
  const role = revision?.roleSnapshot;
  const sections = [
    `### ${record.profile.displayName}`,
    role?.description ? `职责：${role.description.trim()}` : "",
    role?.systemPrompt ? `角色指令：\n${role.systemPrompt.trim()}` : "",
    memories.length > 0
      ? `已确认长期记忆（仅供本会话参考）：\n${memories.map(renderMemory).join("\n")}`
      : "",
  ];
  return sections.filter(Boolean).join("\n");
}

/**
 * 构造普通会话中的 Bot 身份追加段。
 *
 * - 没有 Bot：返回空字符串，保持普通会话完全不变。
 * - 一个 Bot：注入当前 revision + active memory，走现有单 Agent loop。
 * - 多个 Bot：由当前会话的默认协调者/显式 @ 目标承接，提示词明确当前执行边界。
 */
export function buildBotSessionPromptAppend(
  botProfileIds?: string[],
  prompt?: string,
  preferredCoordinatorBotProfileId?: string,
): string {
  const ids = [...new Set(botProfileIds ?? [])].filter(Boolean);
  if (ids.length === 0) return "";

  const records = ids
    .map((id) => getBotProfileRecord(id))
    .filter((record): record is BotProfileRecord => Boolean(record));
  if (records.length === 0) return "";

  if (records.length > 1) {
    const targets = records.map((record) => ({
      id: record.profile.id,
      displayName: record.profile.displayName,
    }));
    const mentionedIds = parseFusionBotMentions(prompt ?? "", targets).map(
      (hit) => hit.botProfileId,
    );
    const route = resolveSessionFusionRoute(
      records.map((record) => record.profile.id),
      mentionedIds,
      preferredCoordinatorBotProfileId,
    );
    const coordinator =
      records.find(
        (record) => record.profile.id === route.coordinatorBotProfileId,
      ) ?? records[0];
    const target =
      records.find(
        (record) => record.profile.id === route.targetBotProfileId,
      ) ?? coordinator;
    const names = records
      .map((record) => record.profile.displayName)
      .join("、");
    const routeLine =
      route.reason === "explicit-mention"
        ? `本轮由用户 @ 指定的 Bot「${target?.profile.displayName ?? "未知"}」优先承接。`
        : route.reason === "mentioned-bot-unavailable"
          ? `用户 @ 指定的 Bot 不在当前可用参与者中，本轮回退到默认协调者「${coordinator?.profile.displayName ?? "未知"}」。`
          : `本轮未指定 Bot，由默认协调者「${coordinator?.profile.displayName ?? "未知"}」承接。`;
    return [
      "## 融合会话状态",
      `本会话已加入多个 Bot：${names}。`,
      routeLine,
      "当前版本采用“协调者承接”运行边界：你必须以当前承接 Bot 的职责组织回答，并可以综合其他 Bot 的角色信息与已确认记忆；不要伪造其他 Bot 已经发言、调用工具或完成工作。",
      coordinator && target && coordinator.profile.id !== target.profile.id
        ? `默认协调者仍是「${coordinator.profile.displayName}」；本轮点名目标是「${target.profile.displayName}」。除非用户明确要求，不要把点名目标的回复伪装成默认协调者的原话。`
        : "",
      records
        .map((record) =>
          renderBot(record, getActiveBotMemories(record.profile.id)),
        )
        .join("\n\n"),
      "如果任务需要多个 Bot 的真实独立执行或 Bot→Bot 消息，应进入后续融合执行通道；当前主会话只输出这一轮协调后的正式答复。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const record = records[0]!;
  const memories = getActiveBotMemories(record.profile.id);
  return [
    "## 当前会话 Bot",
    `本轮对话对象是 Bot「${record.profile.displayName}」。请以该 Bot 的角色和职责回应用户；不要自称普通总助，也不要提及内部 BotProfile、revision 或记忆存储实现。`,
    record.profile.description
      ? `Bot 说明：${record.profile.description.trim()}`
      : "",
    renderBot(record, memories),
    "长期记忆只是已确认的参考信息；如果与用户当前明确要求冲突，以当前用户要求为准。",
  ]
    .filter(Boolean)
    .join("\n\n");
}
