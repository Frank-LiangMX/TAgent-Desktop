/**
 * 流式落盘闸口（REGRESS-G）— 同 uuid 去重 + 内容放行。
 *
 * 背景：kscc/glm 把每个 content 块拆成**独立 uuid** 的 assistant 消息且 `stop_reason` 始终 null。
 * 369d6f7 为治 REGRESS-E 引入 `_partial = m._partial===true || stopReason==null`（`kscc-message-adapter.ts:105`），
 * 该推断在 glm 上**恒为 true** → 落盘闸口 `session-service.ts` 跳过 `appendPanelMessages`/`appendSdkMessages`
 * → 段间短文、工具、思考**全部不进 panel JSONL** → 重开会话整轮 assistant 消失（G 主症状）。
 *
 * 本闸口替「一刀切按 IR `_partial` 跳过」为：
 * - **同 uuid 去重**：assistant 暂存为 pending；下一条不同 uuid（或轮结束 flush）才提交上一条。
 *   同 uuid 后到快照**替换** pending（只留最新 = final），避免流式中间快照堆积（不回退 E/S1）。
 * - **内容放行**：有非空 content 的 assistant（text / tool_use / thinking，glm 的独立交付段）可落盘；
 *   显式 `_partial:true`（真流式快照）与空 content 不落盘。
 * - **user 等**：立即落盘（并先 flush 待提交 assistant）。
 *
 * 纯函数 + 显式状态，便于单测；live 推流（sendPayload）不受影响——闸口只管落盘。
 * 详见 docs/dev/core-loop/REGRESS-G-FINDINGS.md、REGRESS-G-implement-brief.md。
 */

/** 闸口状态：当前同 uuid 流式替换链里「最新」的一条待提交消息（未落盘）。 */
export interface StreamPersistGateState {
  pending: { uuid: string; raw: unknown; persist: boolean } | null
}

/** 新建闸口状态。 */
export function createStreamPersistGateState(): StreamPersistGateState {
  return { pending: null }
}

/** assistant 消息是否可落盘：非显式 partial 且 content 非空。 */
function isAssistantPersistable(msg: unknown): boolean {
  const raw = msg as { _partial?: boolean; message?: { content?: unknown[] } }
  // 显式 `_partial:true` = 真流式快照，不落盘（等待同 uuid final 替换）
  if (raw._partial === true) return false
  const content = raw.message?.content
  return Array.isArray(content) && content.length > 0
}

/**
 * 喂入一条流式消息，返回**应立即落盘**的原始消息列表。
 *
 * - assistant：暂存为 pending（同 uuid 替换 = 留最新）；若与 pending 不同 uuid，先提交 pending。
 *   无 uuid 的 assistant：无法去重，先 flush pending 再立即落盘本条。
 * - 非 assistant（user 等）：先 flush pending，再落盘自身（user 落盘；result 等不带 message，由调用方走事件路径）。
 *
 * 返回的列表为「此刻该写进 panel+SDK JSONL 的消息」；当前 assistant（若可落盘）暂不在此列，
 * 等下一条不同 uuid 或 `flushStreamPersistGate` 再提交。
 */
export function feedStreamPersistGate(
  state: StreamPersistGateState,
  msg: unknown,
): unknown[] {
  const raw = msg as { type?: string; uuid?: string }
  const type = raw.type
  const out: unknown[] = []

  if (type === 'assistant') {
    const uuid = raw.uuid ?? ''
    if (!uuid) {
      // 无 uuid 不能去重：flush 旧 pending，立即落盘本条（可落盘时）
      if (state.pending) {
        if (state.pending.persist) out.push(state.pending.raw)
        state.pending = null
      }
      if (isAssistantPersistable(msg)) out.push(msg)
      return out
    }
    // 不同 uuid：提交前一条链（若可落盘）
    if (state.pending && state.pending.uuid !== uuid) {
      if (state.pending.persist) out.push(state.pending.raw)
      state.pending = null
    }
    // 进 / 替换 pending（同 uuid 替换 = 留最新 = final）
    state.pending = { uuid, raw: msg, persist: isAssistantPersistable(msg) }
    return out
  }

  // 非 assistant：先 flush 待提交 assistant，再落盘自身
  if (state.pending) {
    if (state.pending.persist) out.push(state.pending.raw)
    state.pending = null
  }
  if (type === 'user') out.push(msg)
  return out
}

/**
 * 轮结束（result / turn_end / 中断）：提交待落盘的 pending。
 * 幂等：pending 已提交或不存在时返回空。
 */
export function flushStreamPersistGate(state: StreamPersistGateState): unknown[] {
  if (!state.pending) return []
  const out = state.pending.persist ? [state.pending.raw] : []
  state.pending = null
  return out
}
