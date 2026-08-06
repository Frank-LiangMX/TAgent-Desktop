/**
 * 会话级流式状态（与 DisplayItem 分离）。
 *
 * delta 只累加 streamState，永不因 delta 创建/修改 items。
 * 段边界由 Chat 按消息内容选择性清理：tool-only 中间态保留 thinking；
 * turn_end / result / 含 thinking 的终态消息才清空。
 */

import type { TAgentMessage } from '@tagent/shared'

/** 会话级流式缓冲：正文 + 思考 */
export interface SessionStreamState {
  text: string
  thinking: string
}

export const EMPTY_STREAM_STATE: SessionStreamState = { text: '', thinking: '' }

export function hasStreamContent(state: SessionStreamState): boolean {
  return Boolean(state.text || state.thinking)
}

export function applyTextDelta(state: SessionStreamState, delta: string): SessionStreamState {
  if (!delta) return state
  return { ...state, text: state.text + delta }
}

export function applyThinkingDeltaToState(
  state: SessionStreamState,
  delta: string,
): SessionStreamState {
  if (!delta) return state
  return { ...state, thinking: state.thinking + delta }
}

export function clearSessionStreamState(): SessionStreamState {
  return EMPTY_STREAM_STATE
}

/** sdk_message 内容块最小形状（避免拉满 IR 类型） */
export interface StreamClearMessageLike {
  type?: string
  stop_reason?: string | null
  content?: ReadonlyArray<{
    type: string
    thinking?: string
    text?: string
    id?: string
    name?: string
    input?: unknown
  }>
}

/**
 * 是否应清空 streamState.thinking。
 *
 * 仅 tool_use 的中间态（Pi tool_execution_start）**不得**清——
 * 思考还只在 streamState，清了就「出完即消失」。
 * 等消息已带非空 thinking，或回合真正结束（stop_reason）再清。
 */
export function shouldClearStreamThinking(msg: StreamClearMessageLike): boolean {
  if (msg.type !== 'assistant') return true
  // 仅当消息 content 已带非空 thinking 时才清 stream 缓冲（防重复）。
  // 禁止仅凭 stop_reason 清空：kscc final 常带 tool_use 却剥掉 thinking，
  // 一清 stream 又无 content 思考 → 时间线思考段闪没（REGRESS-E）。
  // 回合真正结束由 Chat result/turn_end 的 resetStreamState 全清。
  const blocks = msg.content ?? []
  return blocks.some(
    (b) => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0,
  )
}

/**
 * 是否应清空 streamState.text。
 * 对称：仅工具中间态保留已流出的正文；消息已带 text 或终态再清。
 */
export function shouldClearStreamText(msg: StreamClearMessageLike): boolean {
  if (msg.type !== 'assistant') return true
  if (msg.stop_reason) return true
  const blocks = msg.content ?? []
  return blocks.some(
    (b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0,
  )
}

/** 按消息内容选择性清理 streamState（禁止 tool-only 中间态把思考打没） */
export function applySdkMessageToStreamState(
  state: SessionStreamState,
  msg: StreamClearMessageLike,
): SessionStreamState {
  const clearThinking = shouldClearStreamThinking(msg)
  const clearText = shouldClearStreamText(msg)
  if (!clearThinking && !clearText) return state
  if (clearThinking && clearText) return EMPTY_STREAM_STATE
  return {
    text: clearText ? '' : state.text,
    thinking: clearThinking ? '' : state.thinking,
  }
}

/** DisplayItem 的流式相关最小形状（Pi 落盘路径清理纯占位） */
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

/** 清掉纯流式占位（无 message / 任务卡 / 压缩行） */
export function purgeStreamingItems<T extends StreamItemLike>(prev: T[]): T[] {
  return prev.filter((it) => Boolean(it.message || it.taskCard || it.compactStatus))
}

/**
 * 同 uuid upsert 时：若后到消息剥掉了 thinking，保留已有非空思考块（插到 content 前）。
 * kscc partial/final 快照常先带 thinking、后只带 tool_use → 不合并会「最后一段也没了」。
 */
export function preserveAssistantThinking(
  existing: TAgentMessage,
  incoming: TAgentMessage,
): TAgentMessage {
  if (existing.type !== 'assistant' || incoming.type !== 'assistant') return incoming
  const incomingHasThinking = incoming.content.some(
    (b) => b.type === 'thinking' && typeof (b as { thinking?: string }).thinking === 'string' && (b as { thinking: string }).thinking.trim(),
  )
  if (incomingHasThinking) return incoming
  const prevThinking = existing.content.filter(
    (b) => b.type === 'thinking' && typeof (b as { thinking?: string }).thinking === 'string' && (b as { thinking: string }).thinking.trim(),
  )
  if (prevThinking.length === 0) return incoming
  return {
    ...incoming,
    content: [...prevThinking, ...incoming.content],
  }
}

/** turn_end / result 清 stream 前：把仍只在缓冲里的思考写入末条主线 assistant */
export function commitStreamThinkingToLastAssistant<T extends StreamItemLike>(
  prev: T[],
  thinking: string,
): T[] {
  const t = thinking.trim()
  if (!t) return prev
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]?.message
    if (m?.type !== 'assistant' || m.parentToolUseId) continue
    const hasThinking = m.content.some(
      (b) =>
        b.type === 'thinking' &&
        typeof (b as { thinking?: string }).thinking === 'string' &&
        (b as { thinking: string }).thinking.trim(),
    )
    if (hasThinking) return prev
    const next = [...prev]
    next[i] = {
      ...prev[i]!,
      message: {
        ...m,
        content: [{ type: 'thinking', thinking: t }, ...m.content],
      },
    }
    return next
  }
  return prev
}

/**
 * 单真源流式（S2.1）：把一条 sdk_message assistant/user 按 **uuid 原地 upsert** 进 items。
 *
 * - 同 uuid：就地替换（partial→final 同 uuid 一条），不新增、不覆盖上一轮已完成 assistant。
 * - final（有 stop_reason 且非 `_partial`）**不被**后续 partial 覆盖（竞态保护，对齐 Proma）。
 * - 无 uuid 的 tool-only 中间态：按 tool_use id 就地更新，否则追加（禁止覆盖上一轮已完成 assistant）。
 * - 终态（有 stop_reason）落入最后一个 streaming assistant；都没有则 append（并清纯占位）。
 *
 * 与 Chat 的 streamState 清理分离：本函数只管 items 真源，streamState 由 Chat 按内容选择性清。
 * 见 docs/dev/core-loop/S1S2-single-source-brief.md。
 */
export function applySdkMessageToItems<T extends StreamItemLike>(
  prev: T[],
  message: TAgentMessage,
  allocKey: () => string,
): T[] {
  const msg = message
  const msgUuid = msg.type === 'assistant' || msg.type === 'user' ? msg.uuid : undefined
  const stopReason = msg.type === 'assistant' ? msg.stop_reason : undefined
  const stillStreaming = msg.type === 'assistant' && !stopReason
  const incomingPartial = msg.type === 'assistant' && msg._partial === true

  const applyMsg = (it: T, merged: TAgentMessage = msg): T => ({
    ...it,
    message: merged,
    streamUuid: msgUuid ?? it.streamUuid,
    streaming: stillStreaming,
    streamingText: undefined,
    streamingThinking: undefined,
  })

  // 1) 同 uuid 就地更新（partial→final / partial→partial）
  if (msgUuid) {
    const uuidIdx = prev.findIndex(
      (it) =>
        it.streamUuid === msgUuid ||
        (it.message?.type === 'assistant' && it.message.uuid === msgUuid) ||
        (it.message?.type === 'user' && it.message.uuid === msgUuid),
    )
    if (uuidIdx >= 0) {
      const existing = prev[uuidIdx]
      const existingIsFinal =
        existing?.message?.type === 'assistant' &&
        Boolean(existing.message.stop_reason) &&
        existing.message._partial !== true
      // S2.1：final 不被迟到的 partial 覆盖（避免终态退回流式）
      if (existingIsFinal && incomingPartial) {
        return prev
      }
      // 同 uuid 后到快照若剥掉 thinking，保留已有思考块（REGRESS-E：防「最后一段也没了」）
      const merged =
        existing?.message && msg.type === 'assistant'
          ? preserveAssistantThinking(existing.message, msg)
          : msg
      return prev.map((it, i) => (i === uuidIdx ? applyMsg(it, merged) : it))
    }
  }

  // 2) 仍在流式：无 uuid 的 tool-only 中间态应追加/就地更新，禁止覆盖上一轮已完成 assistant
  if (stillStreaming) {
    const lastIdx = prev.length - 1
    const last = prev[lastIdx]
    const onlyTools =
      msg.type === 'assistant' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      msg.content.every((b) => b.type === 'tool_use')
    if (onlyTools) {
      const toolBlock = msg.content.find((b) => b.type === 'tool_use')
      const toolId =
        toolBlock && typeof toolBlock === 'object' && 'id' in toolBlock
          ? String((toolBlock as { id: string }).id)
          : null
      if (toolId) {
        const toolIdx = prev.findIndex(
          (it) =>
            it.message?.type === 'assistant' &&
            Array.isArray(it.message.content) &&
            it.message.content.some(
              (b) =>
                b.type === 'tool_use' &&
                typeof b === 'object' &&
                'id' in b &&
                String((b as { id: string }).id) === toolId,
            ),
        )
        if (toolIdx >= 0) {
          const existing = prev[toolIdx]
          const merged =
            existing?.message && msg.type === 'assistant'
              ? preserveAssistantThinking(existing.message, msg)
              : msg
          return prev.map((it, i) => (i === toolIdx ? applyMsg(it, merged) : it))
        }
      }
      return [
        ...prev,
        { key: allocKey(), message: msg, streamUuid: msgUuid, streaming: true } as T,
      ]
    }
    if (last?.message?.type === 'assistant' && last.streaming) {
      const merged =
        msg.type === 'assistant' ? preserveAssistantThinking(last.message, msg) : msg
      return prev.map((it, i) => (i === lastIdx ? applyMsg(it, merged) : it))
    }
  }

  // 3) Pi 核完成（有 stop_reason）→ 落盘最终 message：清 streaming 标记
  if (msg.type === 'assistant' && stopReason) {
    const lastIdx = prev.length - 1
    const last = prev[lastIdx]
    if (last?.message?.type === 'assistant' && last.streaming) {
      const merged = preserveAssistantThinking(last.message, msg)
      return prev.map((it, i) => (i === lastIdx ? applyMsg(it, merged) : it))
    }
  }

  return [
    ...purgeStreamingItems(prev),
    { key: allocKey(), message: msg, streamUuid: msgUuid, streaming: stillStreaming } as T,
  ]
}
