/**
 * runMoaTurn — MoA 会诊单轮编排（主进程侧）。
 *
 * 与 session-service 的普通 sendMessage 分流：会话 modelId 为 `moa:<presetId>` 时，
 * session-service 不走 adapter.query / 不对 kscc setModel('moa:…')，而是调本模块。
 *
 * 职责（对齐 docs/dev/moa-roundtable/01-MOA-PRODUCT-SPEC.md §3）：
 * 1. 校验预置参考/汇总模型均在当前渠道（kscc-internal 或外部渠）且 enabled；不足降级报错。
 * 2. 落盘/推送 user 消息（kscc 双写：面板 + SDK JSONL；与现核一致）。
 * 3. 推初始 moa_roundtable 卡（参考席 pending）。
 * 4. runReferenceModels（进度回调 onSeatUpdate 驱动卡；AbortSignal 取消）。
 * 5. 任一参考 ok 即 fail-open；全失败 → error 卡 + session_error。
 * 6. 汇总：runAggregatorModel 单独跑一轮（tools:[]），流式正文推主 assistant。
 * 7. 落盘/推送 final assistant（汇总结论 = 本轮主回答）；卡 phase=done。
 * 8. 取消：未完成席 cancelled，卡 phase=cancelled（turn_end 由调用方 STOP 负责）。
 *
 * 不在本模块做：选核/绑核/权限/记忆/Nudge —— 那是 session-service 的职责。
 */
import {
  runReferenceModels,
  runAggregatorModel,
  type ReferenceModelConfig,
  type ReferenceOutput,
  type MoASeatRunner,
} from '@tagent/pi-core'
import {
  type Channel,
  type MoAPreset,
  type SDKMessage,
  type TAgentDesktopStreamPayload,
  type TAgentMessage,
  classifyUserFacingError,
  sdkMessageToIR,
  createMoARoundtablePanel,
  setMoASeatStatus,
  markMoAPanelCancelled,
  setMoAPanelPhase,
  buildMoAHistoryFromMessages,
  buildMoAFinalAssistantSDKMessage,
  type MoARoundtablePanel,
} from '@tagent/shared'
import { appendPanelMessages, appendSdkMessages, readPanelMessages } from './session-store'
import { validateMoAPresetForChannel } from './moa-dispatch'

/** 用户附件（与 SendMessageInput.attachments 同形态，落盘用） */
interface MoAAttachment {
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}

export interface MoATurnContext {
  sessionId: string
  prompt: string
  /** 当前渠道（已 enabled；kscc-internal 或外部渠均可） */
  channel: Channel
  /** 已结构校验过的预置 */
  preset: MoAPreset
  workspaceId?: string
  /**
   * 单席 runner：kscc-internal → createKsccSeatRunner；外部渠 → createPiHttpSeatRunner。
   * 由 session-service 按渠道 provider 选定注入（凭据在主进程解密，不进本上下文的落盘/圆桌卡路径）。
   * 同场不混核：一轮全程只用一种 runner。
   */
  seatRunner: MoASeatRunner
  /** 取消信号：由 session-service 在 STOP/销毁时 abort */
  signal: AbortSignal
  /** 推渲染层流式事件（session-service.sendPayload 绑定 sessionId） */
  sendPayload: (payload: TAgentDesktopStreamPayload) => void
  attachments?: MoAAttachment[]
}

export type MoATurnOutcome = 'done' | 'error' | 'cancelled'

export interface MoATurnResult {
  outcome: MoATurnOutcome
  error?: string
}

/** 全局轮次序号（同会话内 roundtableId 唯一） */
let moaTurnSeq = 0

const AGGREGATOR_SEAT_ID = 'agg'

/** 渠道内查找已启用模型；返回 {name} 或 null */
function findEnabledModel(channel: Channel, modelId: string): { name: string } | null {
  const m = channel.models.find((x) => x.id === modelId)
  if (!m || !m.enabled) return null
  return { name: m.name }
}

/** 推圆桌卡（tagent_event.type === 'moa_roundtable'，panel 携完整状态） */
function emitCard(sendPayload: MoATurnContext['sendPayload'], panel: MoARoundtablePanel): void {
  sendPayload({ kind: 'tagent_event', event: { type: 'moa_roundtable', panel } })
}

/** 落盘 + 推 user 消息（kscc 双写：面板 + SDK JSONL；IR 推渲染层） */
function persistAndPushUser(ctx: MoATurnContext): void {
  const now = Date.now()
  const userMsg: SDKMessage = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: ctx.prompt }] },
    parent_tool_use_id: null,
    createdAt: now,
    ...(ctx.attachments?.length ? { attachments: ctx.attachments } : {}),
  } as unknown as SDKMessage
  try {
    appendPanelMessages(ctx.workspaceId, ctx.sessionId, [userMsg])
  } catch (err) {
    console.warn('[runMoaTurn] appendPanelMessages failed (user):', err)
  }
  try {
    appendSdkMessages(ctx.workspaceId, ctx.sessionId, [userMsg])
  } catch (err) {
    console.error('[runMoaTurn] appendSdkMessages failed (user):', err)
  }
  const { message: userIR } = sdkMessageToIR(userMsg)
  if (userIR) {
    if (ctx.attachments?.length) (userIR as TAgentMessage & { attachments?: MoAAttachment[] }).attachments = ctx.attachments
    ctx.sendPayload({ kind: 'sdk_message', message: userIR })
  }
}

/** 落盘 + 推 final assistant（汇总结论；kscc 双写 SDKMessage，IR 推渲染层）。
 *  shape 由纯函数 `buildMoAFinalAssistantSDKMessage` 构造（对齐普通 assistant + 补 message.role，
 *  单测见 packages/shared/src/types/moa-persist.test.ts · P0 #2）。 */
function persistAndPushFinalAssistant(
  ctx: MoATurnContext,
  text: string,
  aggregatorModelId: string,
  uuid: string,
): void {
  const sdkMsg = buildMoAFinalAssistantSDKMessage(text, aggregatorModelId, uuid, Date.now())
  try {
    appendPanelMessages(ctx.workspaceId, ctx.sessionId, [sdkMsg])
  } catch (err) {
    console.warn('[runMoaTurn] appendPanelMessages failed (assistant):', err)
  }
  try {
    appendSdkMessages(ctx.workspaceId, ctx.sessionId, [sdkMsg])
  } catch (err) {
    console.error('[runMoaTurn] appendSdkMessages failed (assistant):', err)
  }
  const { message: ir } = sdkMessageToIR(sdkMsg)
  if (ir) ctx.sendPayload({ kind: 'sdk_message', message: ir })
}

/**
 * 读面板历史 → 转 IR → 拼 `[会话上下文]…` 文本块。
 *
 * 必须在 persistAndPushUser 之后调用：本轮 user 已落盘为面板**末条**，拼历史时用
 * `excludeTrailingTurn` 把它排除，避免和稍后拼接的「本轮议题」重复（新会话首条
 * 尤其：历史本应为空，否则议题会被当成「上一轮 user」再问一遍）。
 *
 * 读失败或历史为空 → 返回 ''（参考席/汇总席仍按本轮议题作答）。
 */
function buildHistoryForTurn(ctx: MoATurnContext): string {
  try {
    const panel = readPanelMessages(ctx.workspaceId, ctx.sessionId)
    const irs: TAgentMessage[] = []
    for (const raw of panel) {
      const { message } = sdkMessageToIR(raw as never)
      if (message) irs.push(message)
    }
    return buildMoAHistoryFromMessages(irs, { excludeTrailingTurn: true })
  } catch (err) {
    console.warn('[runMoaTurn] buildHistoryForTurn failed:', err)
    return ''
  }
}

/**
 * 运行一轮 MoA 会诊。不抛错——所有失败经 sendPayload 上报，返回 outcome 供调用方记账。
 */
export async function runMoaTurn(ctx: MoATurnContext): Promise<MoATurnResult> {
  const { channel, preset, signal, sendPayload } = ctx

  // 1. 运行时校验
  const validateErr = validateMoAPresetForChannel(preset, channel)
  if (validateErr) {
    sendPayload({
      kind: 'tagent_event',
      event: { type: 'session_error', message: validateErr, error: classifyUserFacingError(validateErr) },
    })
    sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
    return { outcome: 'error', error: validateErr }
  }

  // 2. 落盘/推 user 消息
  persistAndPushUser(ctx)

  // 2.5 会话上下文：拼参考席 / 汇总席要看到的近期对话（SPEC §2）。
  //     在 user 落盘后读面板：历史不含本轮 user（避免与「本轮议题」重复）。
  const historyText = buildHistoryForTurn(ctx)

  // 3. 组装圆桌卡
  const roundtableId = `moa-rt-${ctx.sessionId}-${moaTurnSeq++}`
  const refSeats: ReferenceModelConfig[] = preset.references.map((r, i) => ({
    name: r.name,
    modelId: r.modelId,
    seatId: `ref-${i}`,
  }))
  const aggModel = findEnabledModel(channel, preset.aggregatorModelId)!
  let panel = createMoARoundtablePanel({
    roundtableId,
    presetId: preset.id,
    presetName: preset.name,
    topic: ctx.prompt.slice(0, 200),
    references: refSeats.map((r) => ({ seatId: r.seatId!, name: r.name, modelId: r.modelId })),
    aggregator: { seatId: AGGREGATOR_SEAT_ID, name: `汇总·${aggModel.name}`, modelId: preset.aggregatorModelId },
  })
  emitCard(sendPayload, panel)

  // 4. 参考席并行
  const refOutputs: ReferenceOutput[] = await runReferenceModels(ctx.prompt, refSeats, {
    timeoutMs: preset.timeoutMsPerSeat ?? 120_000,
    seatRunner: ctx.seatRunner,
    signal,
    historyText,
    onSeatUpdate: (seat) => {
      const patch: { text?: string; error?: string; latencyMs?: number } = {}
      if (seat.text != null) patch.text = seat.text
      if (seat.error != null) patch.error = seat.error
      if (seat.latencyMs != null) patch.latencyMs = seat.latencyMs
      panel = setMoASeatStatus(panel, seat.seatId ?? '', seat.status, patch)
      emitCard(sendPayload, panel)
    },
  })

  // 取消
  if (signal.aborted) {
    panel = markMoAPanelCancelled(panel)
    emitCard(sendPayload, panel)
    return { outcome: 'cancelled' }
  }

  // 5. 全失败 → error
  const anyRefOk = refOutputs.some((r) => r.ok)
  if (!anyRefOk) {
    panel = setMoAPanelPhase(panel, 'error')
    emitCard(sendPayload, panel)
    const msg = '所有会诊参考席均失败，无法汇总。请检查模型可用性或切回单模型。'
    sendPayload({
      kind: 'tagent_event',
      event: { type: 'session_error', message: msg, error: classifyUserFacingError(msg) },
    })
    sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
    return { outcome: 'error', error: msg }
  }

  // 6. 汇总
  panel = setMoASeatStatus(panel, AGGREGATOR_SEAT_ID, 'running')
  emitCard(sendPayload, panel)

  const agg = await runAggregatorModel(ctx.prompt, refOutputs, preset.aggregatorModelId, {
    timeoutMs: preset.timeoutMsPerSeat ?? 120_000,
    seatRunner: ctx.seatRunner,
    signal,
    historyText,
    onTextDelta: (delta) => {
      sendPayload({ kind: 'stream_text_delta', text: delta })
    },
  })

  if (signal.aborted) {
    panel = markMoAPanelCancelled(panel)
    emitCard(sendPayload, panel)
    return { outcome: 'cancelled' }
  }

  // 7. 汇总失败 → error
  if (!agg.ok) {
    panel = setMoASeatStatus(panel, AGGREGATOR_SEAT_ID, 'failed', { error: agg.error, latencyMs: agg.latencyMs })
    emitCard(sendPayload, panel)
    const msg = agg.error ?? '会诊汇总模型失败'
    sendPayload({
      kind: 'tagent_event',
      event: { type: 'session_error', message: msg, error: classifyUserFacingError(msg) },
    })
    sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
    return { outcome: 'error', error: msg }
  }

  // 8. 完成：落盘/推 final assistant + 卡 done + result + turn_end
  panel = setMoASeatStatus(panel, AGGREGATOR_SEAT_ID, 'ok', { text: agg.text, latencyMs: agg.latencyMs })
  emitCard(sendPayload, panel)
  const finalUuid = `moa-agg-${roundtableId}`
  persistAndPushFinalAssistant(ctx, agg.text, preset.aggregatorModelId, finalUuid)
  sendPayload({ kind: 'result', subtype: 'success' })
  sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
  return { outcome: 'done' }
}
