import type { RoomBotSeat } from "./fusion-session";

export type FusionRouteReason =
  "single-bot-default" | "coordinator-default" | "explicit-mention";

export interface FusionRouteInput {
  seats: ReadonlyArray<
    Pick<RoomBotSeat, "id" | "status" | "isCoordinator" | "createdAt">
  >;
  mentionedSeatId?: string;
}

export type FusionRouteResult =
  | { ok: true; seatId: string; reason: FusionRouteReason }
  | { ok: false; reason: "no-routable-bot" | "mentioned-seat-unavailable" };

const ROUTABLE_STATUSES: ReadonlySet<RoomBotSeat["status"]> = new Set([
  "accepted",
  "idle",
  "running",
  "awaiting_user",
  "blocked",
]);

function routableSeats(seats: FusionRouteInput["seats"]) {
  return seats
    .filter((seat) => ROUTABLE_STATUSES.has(seat.status))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** 计算默认协调者；显式标记优先，否则按首次加入时间稳定选择。 */
export function resolveFusionCoordinator(
  seats: FusionRouteInput["seats"],
): string | undefined {
  const routable = routableSeats(seats);
  return routable.find((seat) => seat.isCoordinator)?.id ?? routable[0]?.id;
}

/**
 * 融合会话的最小消息路由：单 Bot 直聊，多 Bot 无 @ 交给协调者，@ 只路由到可用席位。
 * 被暂停/移除/仅受邀但未接受的席位不承接消息。
 */
export function resolveFusionRoute(input: FusionRouteInput): FusionRouteResult {
  const routable = routableSeats(input.seats);
  if (input.mentionedSeatId !== undefined) {
    return routable.some((seat) => seat.id === input.mentionedSeatId)
      ? { ok: true, seatId: input.mentionedSeatId, reason: "explicit-mention" }
      : { ok: false, reason: "mentioned-seat-unavailable" };
  }
  if (routable.length === 0) return { ok: false, reason: "no-routable-bot" };
  const onlySeat = routable[0];
  if (onlySeat && routable.length === 1) {
    return { ok: true, seatId: onlySeat.id, reason: "single-bot-default" };
  }
  const coordinatorId = resolveFusionCoordinator(routable);
  return coordinatorId
    ? { ok: true, seatId: coordinatorId, reason: "coordinator-default" }
    : { ok: false, reason: "no-routable-bot" };
}

/** 普通融合会话中可被 @ 的长期 Bot 引用。 */
export interface FusionBotMentionTarget {
  id: string;
  displayName: string;
}

export interface FusionBotMentionHit {
  botProfileId: string;
  displayName: string;
  raw: string;
  index: number;
}

/**
 * 解析普通会话中已加入 Bot 的 @ 提及。
 * 只接受当前会话参与者，避免用户 @ 到 Bot 库里但未加入当前会话的 Bot。
 */
export function parseFusionBotMentions(
  text: string,
  bots: ReadonlyArray<FusionBotMentionTarget>,
): FusionBotMentionHit[] {
  if (!text || bots.length === 0) return [];
  const sorted = [...bots]
    .filter((bot) => bot.id.trim() && bot.displayName.trim())
    .sort(
      (a, b) =>
        Math.max(b.displayName.length, b.id.length) -
        Math.max(a.displayName.length, a.id.length),
    );
  const hits: FusionBotMentionHit[] = [];
  const usedRanges: Array<{ start: number; end: number }> = [];
  const overlaps = (start: number, end: number): boolean =>
    usedRanges.some((range) => !(end <= range.start || start >= range.end));

  for (const bot of sorted) {
    for (const raw of [`@${bot.displayName}`, `@${bot.id}`]) {
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(raw, from);
        if (index < 0) break;
        const end = index + raw.length;
        const next = text[end];
        if (next && /[\w\u4e00-\u9fff]/.test(next)) {
          from = end;
          continue;
        }
        if (!overlaps(index, end)) {
          hits.push({
            botProfileId: bot.id,
            displayName: bot.displayName,
            raw,
            index,
          });
          usedRanges.push({ start: index, end });
        }
        from = end;
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export type SessionFusionRouteReason =
  | "ordinary-default"
  | "single-bot-default"
  | "coordinator-default"
  | "explicit-mention"
  | "mentioned-bot-unavailable";

export interface SessionFusionRouteResult {
  mode: "ordinary" | "single-bot" | "multi-bot";
  targetBotProfileId?: string;
  coordinatorBotProfileId?: string;
  reason: SessionFusionRouteReason;
}

/**
 * 为 AgentSessionMeta.botProfileIds 计算稳定路由。
 * 数组顺序就是加入顺序：第一个可用 Bot 是默认协调者；删除后由剩余首个接任。
 */
export function resolveSessionFusionRoute(
  botProfileIds: ReadonlyArray<string> | undefined,
  mentionedBotProfileIds: ReadonlyArray<string> = [],
  preferredCoordinatorBotProfileId?: string,
): SessionFusionRouteResult {
  const ids = [
    ...new Set((botProfileIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  if (ids.length === 0) return { mode: "ordinary", reason: "ordinary-default" };
  const coordinator =
    preferredCoordinatorBotProfileId &&
    ids.includes(preferredCoordinatorBotProfileId)
      ? preferredCoordinatorBotProfileId
      : ids[0];
  const mentioned = mentionedBotProfileIds.find((id) => ids.includes(id));
  if (ids.length === 1) {
    return {
      mode: "single-bot",
      targetBotProfileId: mentioned ?? coordinator,
      coordinatorBotProfileId: coordinator,
      reason: mentioned ? "explicit-mention" : "single-bot-default",
    };
  }
  if (mentionedBotProfileIds.length > 0 && !mentioned) {
    return {
      mode: "multi-bot",
      coordinatorBotProfileId: coordinator,
      reason: "mentioned-bot-unavailable",
    };
  }
  return {
    mode: "multi-bot",
    targetBotProfileId: mentioned ?? coordinator,
    coordinatorBotProfileId: coordinator,
    reason: mentioned ? "explicit-mention" : "coordinator-default",
  };
}
