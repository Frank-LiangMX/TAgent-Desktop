/**
 * 流式 delta 协议（E）— 累计快照 → 增量 suffix delta + resync + 落盘快照校准。
 *
 * 背景：provider（kscc / Claude SDK `includePartialMessages` / Pi partial）给的是**累计完整快照**
 * （partial assistant 的 content[] 中 thinking/text 单调增长）。若逐帧把全串经 IPC 传给 renderer，
 * 复杂度 O(N²)（87K reasoning × 数千帧）。本模块在 main 侧把累计快照转成**新增 suffix delta**，
 * renderer 增量拼接；block end（final/turn_end/result）发完整 snapshot 校准 + 落盘仍保留全量。
 *
 * 单一权威来源：
 * - partial 期间：只发 delta（suffix / resync），partial 的 sdk_message 剥掉 thinking/text 主体
 *   （只留工具块 + 结构），renderer 据 delta 累积 live 文本；
 * - block end（final assistant，非 _partial）：发完整 sdk_message（校准 + 落盘），renderer handoff
 *   清 streamState 并以 message content 为权威；
 * - 前缀不匹配（provider 重发/编辑/块位移）：发 replace delta（全量），renderer 整体替换，不盲目 append。
 *
 * 纯函数 + 显式状态，便于单测；落盘仍走原始全量 msg（stream-persist-gate），不受 delta 影响。
 */

import type { TAgentMessage, TAgentAssistantMessage } from '../types/tagent-message'

/** IR content 块最小形状（避免拉满 TAgentContentBlock 类型，main 侧只读）。 */
export interface DeltaContentBlock {
  type: string
  thinking?: string
  text?: string
}

/** 一个 block（按 assistant uuid）的累计 thinking / text 全量。 */
export interface BlockSnapshot {
  thinking: string
  text: string
}

/** 计算结果：append(suffix) / replace(resync) / null(无变化)。 */
export type BlockDelta =
  | { type: 'append'; text: string }
  | { type: 'replace'; text: string }
  | null

/**
 * 计算新增 delta。
 * - cur === prev → null（无变化，不发包）
 * - prev 为空 → append(cur)（首次：整体作 append，renderer 从空拼接）
 * - cur 以 prev 为前缀 → append(cur.slice(prev.length))（正常流式 suffix）
 * - 前缀不匹配 → replace(cur)（resync：整体替换，防重复/丢字）
 */
export function computeDelta(prev: string, cur: string): BlockDelta {
  if (cur === prev) return null
  if (prev.length === 0) return { type: 'append', text: cur }
  if (cur.startsWith(prev)) return { type: 'append', text: cur.slice(prev.length) }
  return { type: 'replace', text: cur }
}

/**
 * 从 assistant IR content[] 提取累计 thinking / text 全量（拼接所有同型块）。
 * tool_use 等其它块不参与 delta（工具块仍由 sdk_message 主体携带，体积小、需 live）。
 */
export function extractBlockSnapshot(
  content: ReadonlyArray<DeltaContentBlock>,
): BlockSnapshot {
  let thinking = ''
  let text = ''
  for (const b of content) {
    if (b.type === 'thinking' && typeof b.thinking === 'string') thinking += b.thinking
    else if (b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return { thinking, text }
}

/** 发往 renderer 的 delta（对应 stream_thinking_delta / stream_text_delta 控制事件）。 */
export interface StreamDeltaEmission {
  kind: 'stream_thinking_delta' | 'stream_text_delta'
  /** delta 文本（append=_SUFFIX；replace=全量） */
  text: string
  /** true=整体替换（resync）；省略=append(suffix) */
  replace?: boolean
  /** block 标识（assistant.uuid），renderer/校准可绑定 */
  uuid?: string
  /** SubAgent 父 tool_use_id（透传；顶层 Agent 为 undefined） */
  parentToolUseId?: string
}

/**
 * Delta 追踪器（main 侧，per session）。
 *
 * 按 assistant uuid 维护上次累计快照，喂入新 partial/final 时产出 delta（suffix / resync）。
 * - {@link feedAssistant}：算 thinking/text delta，更新快照；isFinal 时清该 uuid 快照
 *   （block 结束，renderer 由完整 sdk_message 校准）。
 * - {@link resetBlock} / {@link resetAll}：turn_end / result / 切会话兜底，防串块/串会话。
 *
 * 注：本类只产 delta；落盘仍由调用方走原始全量 msg（stream-persist-gate），不受影响。
 */
export class DeltaTracker {
  private readonly snaps = new Map<string, BlockSnapshot>()

  /**
   * 单一权威 delta 源（风险1）：本轮是否已见 SDK 原生 stream_event delta（主线 text/thinking delta）。
   * - true：本轮以原生 delta 为权威 live 文本，{@link feedAssistant} 不再发快照派生 delta（防双 append）；
   *   快照仍由调用方用于 final/persist/resync（原始全量 msg 落盘 + final 全量校准）。
   * - false：无原生 delta 的 provider，{@link feedAssistant} 作 fallback（快照 → suffix delta）。
   * {@link resetAll}（轮结束）清，下一轮重新判定权威源。
   */
  private nativeDeltaActive = false

  /** 标记本轮已见主线原生 stream_event delta（handleSdkStreamMessage 在发原生 delta 前调用）。 */
  markNativeDeltaActive(): void {
    this.nativeDeltaActive = true
  }

  /** 本轮是否以原生 delta 为权威（feedAssistant 据此抑制快照派生 delta）。 */
  isNativeDeltaActive(): boolean {
    return this.nativeDeltaActive
  }

  /**
   * 喂入一条 assistant IR（partial 或 final），返回应发 delta（已剔空 delta）。
   * @param uuid assistant.uuid（无 uuid 用空串作 key）
   * @param content IR content[]
   * @param opts.isFinal true=终态（非 _partial），算末段增量后清快照
   * @param opts.parentToolUseId 透传给 delta
   */
  feedAssistant(
    uuid: string | undefined,
    content: ReadonlyArray<DeltaContentBlock>,
    opts?: { isFinal?: boolean; parentToolUseId?: string },
  ): StreamDeltaEmission[] {
    // 单一权威 delta 源（风险1）：本轮已有 SDK 原生 stream_event delta → 不再发快照派生 delta
    // （原生 delta 已增量喂 renderer，再发快照派生 delta 会双 append）。快照仍用于 final/persist/resync
    // （调用方走原始全量 msg 落盘 + final 全量校准），此处仅抑制 live delta。
    if (this.nativeDeltaActive) return []
    const key = uuid ?? ''
    const cur = extractBlockSnapshot(content)
    const prev = this.snaps.get(key) ?? { thinking: '', text: '' }
    const out: StreamDeltaEmission[] = []

    const td = computeDelta(prev.thinking, cur.thinking)
    if (td) {
      out.push({
        kind: 'stream_thinking_delta',
        text: td.text,
        replace: td.type === 'replace' ? true : undefined,
        uuid,
        parentToolUseId: opts?.parentToolUseId,
      })
    }
    const xd = computeDelta(prev.text, cur.text)
    if (xd) {
      out.push({
        kind: 'stream_text_delta',
        text: xd.text,
        replace: xd.type === 'replace' ? true : undefined,
        uuid,
        parentToolUseId: opts?.parentToolUseId,
      })
    }

    this.snaps.set(key, cur)
    if (opts?.isFinal) this.snaps.delete(key)
    return out
  }

  /** 清单 uuid 追踪（block 结束兜底）。 */
  resetBlock(uuid: string): void {
    this.snaps.delete(uuid)
  }

  /** 清全部（turn_end / result / 切会话）：防串块/串会话 + 清原生 delta 旗标（下一轮重新判定权威源）。 */
  resetAll(): void {
    this.snaps.clear()
    this.nativeDeltaActive = false
  }
}

/**
 * 剥掉 partial assistant IR body 的 thinking/text 主体（置空串，保留块结构与 blockIndex 稳定），
 * 仅留工具块。供 main 在发 delta 后构造「瘦身 partial sdk_message」——IPC 不再每帧重传 87K 主体。
 * tool_use 等其它块原样保留（体积小、需 live 工具卡片）。最终（final）不剥，发全量校准。
 */
export function stripPartialAssistantBody<T extends DeltaContentBlock>(
  content: ReadonlyArray<T>,
): T[] {
  return content.map((b) => {
    if (b.type === 'thinking') return { ...b, thinking: '' } as T
    if (b.type === 'text') return { ...b, text: '' } as T
    return b
  })
}

/**
 * 主线 assistant 是否走 DeltaTracker + 剥主体（E 优化）。子代理 assistant（parentToolUseId）
 * 正文进 SubagentDetailView 的 items 渲染（不进主 streamState，Chat 对 parentToolUseId delta 直接
 * return），剥主体会让详情页流式变空 → 子代理保持全量 sdk_message（风险2：详情路径可消费）。
 * 类型守卫：返回 true 时收窄为 {@link TAgentAssistantMessage}（调用方据此访问 uuid/content/_partial）。
 * 导出供 session-service 单点判定 + 单测。
 */
export function shouldDeltaTrackAssistant(
  message: TAgentMessage | undefined,
): message is TAgentAssistantMessage {
  return Boolean(message && message.type === 'assistant' && !message.parentToolUseId)
}
