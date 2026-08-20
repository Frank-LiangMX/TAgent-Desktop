import type { RoomBotSeat } from './fusion-session'

export type FusionRouteReason =
  | 'single-bot-default'
  | 'coordinator-default'
  | 'explicit-mention'

export interface FusionRouteInput {
  seats: ReadonlyArray<
    Pick<RoomBotSeat, 'id' | 'status' | 'isCoordinator' | 'createdAt'>
  >
  mentionedSeatId?: string
}

export type FusionRouteResult =
  | { ok: true; seatId: string; reason: FusionRouteReason }
  | { ok: false; reason: 'no-routable-bot' | 'mentioned-seat-unavailable' }

const ROUTABLE_STATUSES: ReadonlySet<RoomBotSeat['status']> = new Set([
  'accepted',
  'idle',
  'running',
  'awaiting_user',
  'blocked',
])

function routableSeats(seats: FusionRouteInput['seats']) {
  return seats
    .filter((seat) => ROUTABLE_STATUSES.has(seat.status))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** 计算默认协调者；显式标记优先，否则按首次加入时间稳定选择。 */
export function resolveFusionCoordinator(
  seats: FusionRouteInput['seats'],
): string | undefined {
  const routable = routableSeats(seats)
  return (
    routable.find((seat) => seat.isCoordinator)?.id ??
    routable[0]?.id
  )
}

/**
 * 融合会话的最小消息路由：单 Bot 直聊，多 Bot 无 @ 交给协调者，@ 只路由到可用席位。
 * 被暂停/移除/仅受邀但未接受的席位不承接消息。
 */
export function resolveFusionRoute(input: FusionRouteInput): FusionRouteResult {
  const routable = routableSeats(input.seats)
  if (input.mentionedSeatId !== undefined) {
    return routable.some((seat) => seat.id === input.mentionedSeatId)
      ? { ok: true, seatId: input.mentionedSeatId, reason: 'explicit-mention' }
      : { ok: false, reason: 'mentioned-seat-unavailable' }
  }
  if (routable.length === 0) return { ok: false, reason: 'no-routable-bot' }
  if (routable.length === 1) {
    return { ok: true, seatId: routable[0].id, reason: 'single-bot-default' }
  }
  const coordinatorId = resolveFusionCoordinator(routable)
  return coordinatorId
    ? { ok: true, seatId: coordinatorId, reason: 'coordinator-default' }
    : { ok: false, reason: 'no-routable-bot' }
}

