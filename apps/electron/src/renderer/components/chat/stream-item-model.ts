/**
 * 流式占位项的纯逻辑（从 Chat.tsx 抽出，便于单测）。
 *
 * 覆盖两处回归：
 * - uuid 每条 delta 都变时，纯占位必须续用同一 key（防整轮重挂）
 * - thinking 先于占位到达时必须新建项并累积（防 kscc 思考被吞）
 */

import type { TAgentMessage } from '@tagent/shared'

/** DisplayItem 的流式相关最小形状（避免循环依赖 Chat.tsx） */
export interface StreamItemLike {
  key: string
  message?: TAgentMessage
  streamingText?: string
  streamingThinking?: string
  streamUuid?: string
  streaming?: boolean
  taskCard?: unknown
  compactStatus?: 'compacting' | 'complete'
  compactTrigger?: 'auto' | 'manual'
}

export type StreamItemPatch = Partial<
  Pick<StreamItemLike, 'streamingText' | 'streamingThinking' | 'streamUuid'>
>

export interface UpsertStreamContext<T extends StreamItemLike> {
  /** 当前活跃的流式占位（对应 Chat.streamingRef） */
  currentStreaming: T | null
  /** 新建占位时分配稳定 key */
  allocKey: () => string
}

export interface UpsertStreamResult<T extends StreamItemLike> {
  items: T[]
  streamingItem: T
}

/** 清掉纯流式占位（无 message / 任务卡 / 压缩行） */
export function purgeStreamingItems<T extends StreamItemLike>(prev: T[]): T[] {
  return prev.filter((it) => Boolean(it.message || it.taskCard || it.compactStatus))
}

/**
 * 就地更新或新建流式占位。
 *
 * 关键边界由 sdk_message / turn_end 显式给出；纯占位（尚无落盘 message）
 * 不因 uuid 变化新建——SDK 常给每条 partial 发新 uuid。
 */
export function upsertStreamItem<T extends StreamItemLike>(
  prev: T[],
  patch: StreamItemPatch,
  ctx: UpsertStreamContext<T>,
): UpsertStreamResult<T> {
  const uuid = patch.streamUuid

  // 优先按 uuid 命中已有项（含中间 sdk_message 升级后仍在列表中的 assistant）
  if (uuid) {
    const byUuid = prev.find(
      (it) =>
        it.streamUuid === uuid ||
        (it.message?.type === 'assistant' && it.message.uuid === uuid),
    )
    if (byUuid) {
      const next = {
        ...byUuid,
        streaming: true,
        streamUuid: uuid,
        streamingText:
          patch.streamingText !== undefined ? patch.streamingText : byUuid.streamingText,
        streamingThinking:
          patch.streamingThinking !== undefined
            ? patch.streamingThinking
            : byUuid.streamingThinking,
      } as T
      return {
        items: prev.map((it) => (it.key === byUuid.key ? next : it)),
        streamingItem: next,
      }
    }
  }

  const base = purgeStreamingItems(prev)
  const existing = ctx.currentStreaming
  const inList = existing ? prev.some((it) => it.key === existing.key && it.streaming) : false
  // partial 的 uuid 不是稳定的段标识：SDK 给每条 stream_event 都发新 uuid，
  // 拿它判段会每 token 换一次 item key → turn key 跟着变 → 整轮子树重挂，
  // useSmoothStream 每次重挂都以全文初始化，打字机直接失效。
  // 段边界由 sdk_message / turn_end 显式给出，纯占位（尚无落盘 message）一律续用。
  const uuidMismatch =
    Boolean(uuid) &&
    Boolean(existing?.streamUuid) &&
    existing!.streamUuid !== uuid &&
    Boolean(existing!.message)
  if (!inList || !existing || uuidMismatch) {
    const created = {
      key: ctx.allocKey(),
      streaming: true,
      streamUuid: uuid,
      streamingText: patch.streamingText ?? '',
      streamingThinking: patch.streamingThinking ?? '',
    } as T
    return { items: [...base, created], streamingItem: created }
  }
  const next = {
    ...existing,
    streaming: true,
    streamUuid: uuid ?? existing.streamUuid,
    streamingText:
      patch.streamingText !== undefined ? patch.streamingText : existing.streamingText,
    streamingThinking:
      patch.streamingThinking !== undefined
        ? patch.streamingThinking
        : existing.streamingThinking,
  } as T
  return {
    items: prev.map((it) => (it.key === existing.key ? next : it)),
    streamingItem: next,
  }
}

/**
 * 将一段 thinking delta 绑到现有流式项，或在列表为空时新建占位并累积。
 *
 * kscc 的 thinking 先于正文到达，且不发空占位（只有 Pi 的 message_start 发）；
 * 绑不到时必须新建，否则整轮思考都被吞掉。
 */
export function applyThinkingDelta<T extends StreamItemLike>(
  prev: T[],
  delta: string,
  uuid: string | undefined,
  ctx: UpsertStreamContext<T>,
): UpsertStreamResult<T> {
  const cur = ctx.currentStreaming
  const bound =
    (uuid &&
      prev.find(
        (it) =>
          it.streamUuid === uuid ||
          (it.message?.type === 'assistant' && it.message.uuid === uuid),
      )) ||
    (cur && prev.some((it) => it.key === cur.key) ? cur : undefined)
  // 绑不到不代表该丢：必须新建（见上方注释）。已落盘尾部缓冲由调用方在
  // sdk_message 落盘时清空 pending，不靠这里丢弃。
  const prevThink = bound?.streamingThinking ?? ''
  return upsertStreamItem(
    prev,
    {
      streamingThinking: prevThink + delta,
      streamUuid: uuid,
    },
    ctx,
  )
}
