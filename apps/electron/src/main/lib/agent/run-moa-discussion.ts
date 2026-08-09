/**
 * runMoADiscussion — MoA 圆桌讨论多轮编排（主进程侧）。
 *
 * 与 {@link ./run-moa-turn} 的会诊（并行交卷单轮）相对：圆桌讨论是「席位互相可见、
 * 互相引用/反驳」的**多轮串行**讨论，到轮数上限后由**总结人（moderator）收口**成共识方案，
 * 落盘为本轮主回答。
 *
 * 设计依据：docs/plans/multi-runtime/10-session-agent-behavior-orchestration.md §5.2/§5.3/§5.4
 *   - §5.2：多轮讨论 → 总结人收口（moderator 必在场，由 createMoADiscussionPanel 自动追加）
 *   - §5.3：用户席可插话/喊停（用户席由 panel 自带；本编排暂不处理插话注入，留后续任务）
 *   - §5.4：轮数上限（默认全场 ≤3 轮，可配：班底 roundLimit，1–6）到点必收口；参考/讨论席无工具
 *
 * 职责：
 * 1. 运行时校验预置（参考/汇总模型在当前渠道且 enabled）—— 复用 {@link ./moa-dispatch}。
 * 2. 落盘/推送 user 消息（kscc 双写：面板 + SDK JSONL；与现核一致）。
 * 3. 组装讨论 panel 并发首张 moa_discussion 卡。
 * 4. 多轮串行：每轮每个 participant 依次 runSeat（后发言者可见前面全部发言）；
 *    单席失败记占位 entry；一轮内全员失败 → error；轮数到上限 → finalizing。
 * 5. 收口：moderator 用 aggregatorModelId 跑一次 runSeat（流式推正文）→ finalize → 落盘 final assistant。
 * 6. 取消：signal.aborted → markMoADiscussionCancelled + emit + 返回 cancelled。
 *
 * 不在本模块做：选核/绑核/权限/记忆 —— 历史注入复用 run-moa-turn 的 buildHistoryForTurn 风格（见下）。
 * 与 run-moa-turn 同款落盘/推送小工具在此复制为私有等价实现（不改 run-moa-turn 既有行为）。
 */
import type { MoASeatRunner } from '@tagent/pi-core'
import {
  type Channel,
  type MoAPreset,
  type SDKMessage,
  type TAgentDesktopStreamPayload,
  type TAgentMessage,
  type MoADiscussionPanel,
  classifyUserFacingError,
  sdkMessageToIR,
  buildMoAHistoryFromMessages,
  buildMoAFinalAssistantSDKMessage,
  createMoADiscussionPanel,
  appendDiscussionEntry,
  beginNextRound,
  finalizeMoADiscussion,
  markMoADiscussionCancelled,
  setMoADiscussionPhase,
  evaluateDiscussionConvergence,
  updateDiscussionRunningSummary,
  MOA_DISCUSSION_USER_SPEAKER_ID,
  moaDiscussionConsensusUuid,
} from '@tagent/shared'
import { appendPanelMessages, appendSdkMessages, readPanelMessages, appendMoADiscussionPanelRecord } from './session-store'
import { validateMoAPresetForChannel } from './moa-dispatch'

/** 用户附件（与 SendMessageInput.attachments 同形态，落盘用；与 run-moa-turn 对齐） */
interface MoAAttachment {
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}

export interface MoADiscussionContext {
  sessionId: string
  prompt: string
  /** 当前渠道（已 enabled；kscc-internal 或外部渠均可） */
  channel: Channel
  /** 已结构校验过的预置 */
  preset: MoAPreset
  workspaceId?: string
  /**
   * 单席 runner：kscc-internal → createKsccSeatRunner；外部渠 → createPiHttpSeatRunner。
   * 由 session-service 按渠道 provider 选定注入（凭据在主进程解密，不进本上下文的落盘/讨论卡路径）。
   * 同场不混核：一场讨论全程只用一种 runner。
   */
  seatRunner: MoASeatRunner
  /** 取消信号：由 session-service 在 STOP/销毁时 abort */
  signal: AbortSignal
  /** 推渲染层流式事件（session-service.sendPayload 绑定 sessionId） */
  sendPayload: (payload: TAgentDesktopStreamPayload) => void
  attachments?: MoAAttachment[]
  /**
   * 全场轮数上限（可选覆写，便于调参 / 单测）。取值优先级：
   * `ctx.roundLimit` > `preset.roundLimit` > `3`（见设计文档 §5.4「防失控」；T9 提前收敛后默认 6→3）。
   * <1 由 createMoADiscussionPanel 兜底为 1。
   */
  roundLimit?: number
  /**
   * 用户席插话通道（§5.3）：由 session-service 注入一个 drain 函数，每轮开始前调用以排空
   * 渲染层经 discussion-interject IPC 累积的用户发言。返回的文本会先落 user 发言 entry
   * （即时可见）再追加到本轮参与者 prompt。不传则无插话通道（单测默认）。
   */
  interjections?: { drain(): string[] }
  /**
   * 预生成 discussionId（可选）：session-service 在调用前用它注册 IPC 通道（discussion-interject /
   * discussion-stop 按 discussionId 匹配活跃讨论），故需在 runMoADiscussion 之外先生成同一 id。
   * 不传时由 {@link nextMoADiscussionId} 就地生成（单测默认）。
   */
  discussionId?: string
}

export type MoADiscussionOutcome = 'done' | 'error' | 'cancelled'

export interface MoADiscussionResult {
  outcome: MoADiscussionOutcome
  error?: string
}

/** 全局讨论序号（同会话内 discussionId 唯一） */
let moaDiscussionSeq = 0

/**
 * 生成下一场讨论的 discussionId（`moa-disc-<sessionId>-<seq>`）。
 * 导出供 session-service 在调用 runMoADiscussion 前预生成同一 id 并注册 IPC 通道；
 * 传入 {@link MoADiscussionContext.discussionId} 后 runMoADiscussion 内部不再二次生成。
 */
export function nextMoADiscussionId(sessionId: string): string {
  return `moa-disc-${sessionId}-${moaDiscussionSeq++}`
}

/**
 * 共享纪要更新频率（T11）：每 {@link DISCUSSION_SUMMARY_EVERY_TURNS} 轮跑一次纪要模型，
 * 把累积讨论压成结构化纪要，下一轮参与者读「议题 + 纪要 + 最近发言」而非全部发言堆积。
 *
 * 取 2：第 2、4、6…轮结束后各压一次（`currentRound % 2 === 0`）。配合默认 roundLimit=3，
 * 一场讨论最多跑 1 次纪要（第 2 轮后），既压缩后两轮上下文、又不让纪要模型调用过多拖慢讨论。
 */
const DISCUSSION_SUMMARY_EVERY_TURNS = 2

/** 纪要模型单次超时（短于发言/收口的 120s：纪要是压缩任务，30s 足够；超时降级不阻断讨论） */
const DISCUSSION_SUMMARY_TIMEOUT_MS = 30_000

/** 纪要输出末尾的收敛判断行前缀（解析用；prompt 里要求模型照此格式输出） */
const DISCUSSION_SUMMARY_CONVERGE_PREFIX = '收敛:'

/** 推讨论卡（tagent_event.type === 'moa_discussion'，panel 携完整状态；同场多卡就地 upsert）。
 *
 * 终态落盘（T8）：panel.phase 为 done/cancelled/error 时，把完整 panel（含全部 entries + summary）
 * 追加写入会话 moa-discussion.jsonl，供重启/切回会话时重放为入口卡 + 讨论室回看完整发言。
 * 非终态（discussing/finalizing）只推渲染层、不落盘（中间过程已实时推送，重启无需重放未完成讨论；
 * 且每场讨论终态 emit 仅一次 → 恰好落盘一行）。写失败不阻断主流程（console.warn）。
 */
function emitDiscussionCard(
  ctx: MoADiscussionContext,
  panel: MoADiscussionPanel,
): void {
  ctx.sendPayload({ kind: 'tagent_event', event: { type: 'moa_discussion', panel } })
  if (panel.phase === 'done' || panel.phase === 'cancelled' || panel.phase === 'error') {
    persistDiscussionPanel(ctx, panel)
  }
}

/** 终态 panel 落盘（moa-discussion.jsonl，一行一场）。写失败仅 warn，不阻断主流程。 */
function persistDiscussionPanel(ctx: MoADiscussionContext, panel: MoADiscussionPanel): void {
  try {
    appendMoADiscussionPanelRecord(ctx.workspaceId, ctx.sessionId, panel)
  } catch (err) {
    console.warn('[runMoaDiscussion] persistDiscussionPanel failed:', err)
  }
}

/** 落盘 + 推 user 消息（kscc 双写：面板 + SDK JSONL；IR 推渲染层）。与 run-moa-turn 同款，私有等价实现。 */
function persistAndPushUser(ctx: MoADiscussionContext): void {
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
    console.warn('[runMoaDiscussion] appendPanelMessages failed (user):', err)
  }
  try {
    appendSdkMessages(ctx.workspaceId, ctx.sessionId, [userMsg])
  } catch (err) {
    console.error('[runMoaDiscussion] appendSdkMessages failed (user):', err)
  }
  const { message: userIR } = sdkMessageToIR(userMsg)
  if (userIR) {
    if (ctx.attachments?.length)
      (userIR as TAgentMessage & { attachments?: MoAAttachment[] }).attachments = ctx.attachments
    ctx.sendPayload({ kind: 'sdk_message', message: userIR })
  }
}

/** 落盘 + 推 final assistant（共识方案；kscc 双写 SDKMessage，IR 推渲染层）。
 *  shape 由纯函数 `buildMoAFinalAssistantSDKMessage` 构造（与 run-moa-turn 同款，对齐普通 assistant）。 */
function persistAndPushFinalAssistant(
  ctx: MoADiscussionContext,
  text: string,
  aggregatorModelId: string,
  uuid: string,
): void {
  const sdkMsg = buildMoAFinalAssistantSDKMessage(text, aggregatorModelId, uuid, Date.now())
  try {
    appendPanelMessages(ctx.workspaceId, ctx.sessionId, [sdkMsg])
  } catch (err) {
    console.warn('[runMoaDiscussion] appendPanelMessages failed (assistant):', err)
  }
  try {
    appendSdkMessages(ctx.workspaceId, ctx.sessionId, [sdkMsg])
  } catch (err) {
    console.error('[runMoaDiscussion] appendSdkMessages failed (assistant):', err)
  }
  const { message: ir } = sdkMessageToIR(sdkMsg)
  if (ir) ctx.sendPayload({ kind: 'sdk_message', message: ir })
}

/**
 * 读面板历史 → 转 IR → 拼 `[会话上下文]…` 文本块（与 run-moa-turn 同款）。
 *
 * 必须在 persistAndPushUser 之后调用：本轮 user 已落盘为面板**末条**，拼历史时用
 * `excludeTrailingTurn` 把它排除，避免和稍后拼接的「本轮议题」重复（新会话首条
 * 尤其：历史本应为空，否则议题会被当成「上一轮 user」再问一遍）。
 *
 * 读失败或历史为空 → 返回 ''（participant / 总结人仍按本轮议题作答）。
 */
function buildHistoryForTurn(ctx: MoADiscussionContext): string {
  try {
    const panel = readPanelMessages(ctx.workspaceId, ctx.sessionId)
    const irs: TAgentMessage[] = []
    for (const raw of panel) {
      const { message } = sdkMessageToIR(raw as never)
      if (message) irs.push(message)
    }
    return buildMoAHistoryFromMessages(irs, { excludeTrailingTurn: true })
  } catch (err) {
    console.warn('[runMoaDiscussion] buildHistoryForTurn failed:', err)
    return ''
  }
}

/** speakerId → 显示名（panel.speakers 在 create 后稳定不变，建一次复用） */
function buildSpeakerNameOf(panel: MoADiscussionPanel): (speakerId: string) => string {
  const map = new Map(panel.speakers.map((s) => [s.speakerId, s.name]))
  return (id: string): string => map.get(id) ?? id
}

/**
 * 拼 participant 发言 prompt：会话上下文（可选）+ 议题 + [共享纪要]（若有）+ [最近发言] +
 * 用户插话（可选）+ 「第 N 轮，轮到你发言」。
 *
 * 共享纪要（T11）：首份纪要生成前（第 1-2 轮，`lastSummarizedTurn === 0` 且无 runningSummary），
 *   保留原行为——列出全部已有席位发言，避免早期上下文丢失；首份纪要生成后，参与者只看
 *   [共享纪要]（压缩 lastSummarizedTurn 及之前）+ [最近发言]（自纪要以来 turn in
 *   (lastSummarizedTurn, currentRound] 的席位发言，含本轮已先发言者，供回应最新观点），
 *   不再堆积全部历史发言——这正是 T11 解决的「后几轮发散」问题。
 * 历史注入：historyText 由 buildHistoryForTurn 产出（`[会话上下文]…\n\n`，与 run-moa-turn 同款），
 *   非空则前置到拼装开头，让 participant 看到会话前文；空则行为不变。
 * 用户插话（§5.3）：interjections 为本轮开始前 drain 出的用户发言（已先落 user entry 进 panel.entries
 *   供 UI/总结人可见）。为避免与「最近发言」重复，[最近发言] 只列席位发言（过滤 user 席），
 *   本轮插话单独成段 `[用户插话]` + 「请先回应用户插话，再继续本轮讨论」。
 */
function buildDiscussionPrompt(
  panel: MoADiscussionPanel,
  speakerName: string,
  currentRound: number,
  nameOf: (id: string) => string,
  historyText?: string,
  interjections?: string[],
  lastSummarizedTurn = 0,
): string {
  const lines: string[] = ['[圆桌讨论]', `议题：${panel.topic}`, '']
  const hasSummary = panel.runningSummary != null && panel.runningSummary.trim().length > 0
  // 无纪要时回退为「全部已有席位发言」（保留 T11 前行为，首份纪要生成前不丢上下文）；
  // 有纪要时只取自纪要以来的席位发言（含本轮已先发言者），不再堆积全部历史。
  const contextEntries = hasSummary
    ? panel.entries.filter(
        (e) =>
          e.speakerId !== MOA_DISCUSSION_USER_SPEAKER_ID &&
          e.turn > lastSummarizedTurn &&
          e.turn <= currentRound,
      )
    : panel.entries.filter((e) => e.speakerId !== MOA_DISCUSSION_USER_SPEAKER_ID)

  if (hasSummary) {
    lines.push('[共享纪要]', panel.runningSummary!.trim(), '')
  }
  if (contextEntries.length) {
    // 有纪要时标「最近发言」并带轮次（自纪要以来的增量）；无纪要时标「已有发言」（原行为）
    lines.push(hasSummary ? '[最近发言]' : '[已有发言]')
    for (const e of contextEntries) {
      const tag = hasSummary ? `（第${e.turn}轮）` : ''
      lines.push(`- ${nameOf(e.speakerId)}${tag}：${e.text}`)
    }
    lines.push('')
  } else if (!(interjections && interjections.length)) {
    // 无席位发言且无插话 → 本轮首位发言者；有插话时不提示「首位」（已有需先回应的内容）
    lines.push('（你是本轮首位发言者）', '')
  }
  if (interjections && interjections.length) {
    lines.push('[用户插话]')
    for (const text of interjections) {
      lines.push(`- 你：${text}`)
    }
    lines.push('请先回应用户插话，再继续本轮讨论。', '')
  }
  lines.push(
    `现在是第 ${currentRound} 轮，轮到你（${speakerName}）发言。请针对议题发言，可引用/反驳前面观点，简洁直接。`,
  )
  return (historyText ?? '') + lines.join('\n')
}

/**
 * 拼 moderator 收口 prompt：会话上下文（可选）+ 全部发言记录 + 「请作为总结人输出共识方案」。
 *
 * 共享纪要（T11）：收口只有一次，按「信息完整性 > token 成本」权衡——把过程纪要作为 TL;DR 前置
 *   给总结人快速对齐已达成的一致，同时保留全部发言全文兜底（收口一次性，全文成本可接受，
 *   不像参与者每轮累积）。纪要前置不替代全文，二者并存：纪要帮总结人聚焦结构，全文保证不丢细节。
 */
function buildModeratorPrompt(
  panel: MoADiscussionPanel,
  nameOf: (id: string) => string,
  historyText?: string,
): string {
  const lines: string[] = ['[圆桌讨论全部记录]', `议题：${panel.topic}`, '']
  const runningSummary = panel.runningSummary?.trim()
  if (runningSummary && runningSummary.length) {
    lines.push('[讨论纪要]', runningSummary, '')
  }
  for (const e of panel.entries) {
    lines.push(`- ${nameOf(e.speakerId)}：${e.text}`)
  }
  lines.push('')
  lines.push('请作为总结人，综合以上讨论输出一份共识方案（结论+理由+可执行要点）。')
  return (historyText ?? '') + lines.join('\n')
}

/**
 * 拼纪要模型 prompt（T11，**原创提示词**，未照抄 Hermes）：旧纪要当基线 + 自上次纪要以来的新发言当增量，
 * 输出更新后的纪要——固定三节「当前目标 / 已确认决定 / 未决事项」+ 末尾单独一行收敛判断「收敛: 是|否」。
 *
 * 设计要点（区别于「直接把全文丢给总结人」）：
 * - 隔离的纪要模型（用 aggregatorModelId，与收口同模型但不同 prompt/角色），职责单一：压缩+判定收敛。
 * - 旧纪要当基线 + 增量发言：纪要逐次滚动更新，而非每次从零重读全文 → 后几轮上下文长度恒定。
 * - 结构化三节 + 收敛行：让参与者下一轮读「目标/已定/未决」一目了然，收敛建议直接复用为提前收口信号。
 */
function buildDiscussionSummaryPrompt(
  panel: MoADiscussionPanel,
  nameOf: (id: string) => string,
  sinceTurn: number,
): string {
  const lines: string[] = ['[圆桌纪要]']
  lines.push(
    '你是一名会议纪要秘书，负责把圆桌讨论压缩成结构化纪要，供下一轮参与者快速对齐上下文。',
    '',
  )
  lines.push(`议题：${panel.topic}`, '')
  lines.push('[已有纪要]')
  const oldSummary = panel.runningSummary?.trim()
  lines.push(oldSummary && oldSummary.length ? oldSummary : '（暂无，这是首份纪要）')
  lines.push('')
  lines.push('[自上次纪要以来的新发言]')
  const recent = panel.entries.filter((e) => e.turn > sinceTurn && e.turn <= panel.currentRound)
  if (recent.length) {
    for (const e of recent) {
      lines.push(`- ${nameOf(e.speakerId)}（第${e.turn}轮）：${e.text}`)
    }
  } else {
    lines.push('（无）')
  }
  lines.push('')
  lines.push('请基于「已有纪要 + 新发言」，输出更新后的纪要。格式严格如下，三个小节各用标题行加项目符号：')
  lines.push('## 当前目标')
  lines.push('- 议题要解决的核心问题与本轮聚焦的子目标（1-3 条）')
  lines.push('## 已确认决定')
  lines.push('- 讨论中各方已达成一致、可落地的结论（没有就写「暂无」）')
  lines.push('## 未决事项')
  lines.push('- 仍存分歧或待澄清的问题（没有就写「暂无」）')
  lines.push('')
  lines.push(
    '最后单独一行给出收敛判断（仅这一行，格式严格为「收敛: 是」或「收敛: 否」）：当「未决事项」为「暂无」且「当前目标」已由「已确认决定」覆盖 → 收敛: 是；否则 → 收敛: 否。',
  )
  lines.push('不要复述原始发言，只保留提炼后的结论与分歧，简洁。')
  return lines.join('\n')
}

/**
 * 从纪要输出解析收敛判断：自末行向前找首个匹配「收敛: 是|否」的行（容许半角/全角冒号与首尾空白）。
 * 返回 true 表示「收敛: 是」；找不到（模型未按格式输出）→ false（交由 evaluateDiscussionConvergence 降级判定）。
 */
function parseSummaryConvergence(summaryText: string): boolean {
  const lines = summaryText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*收敛\s*[:：]\s*(是|否)\s*$/.exec(lines[i]!.trim())
    if (m) return m[1] === '是'
  }
  return false
}

/**
 * 跑一次纪要更新（T11）：用 aggregatorModelId + seatRunner.runSeat（无工具、短超时、signal 透传）
 * 把讨论压成结构化纪要。失败降级：catch / 空文本 → console.warn 并返回 null（编排层不更新
 * runningSummary，继续用旧纪要/空纪要，不阻断讨论）。signal.aborted 引起的抛错也走降级返回 null，
 * 由调用方在循环里统一判定 cancel（不在纪要路径主动 cancel，避免与主循环 abort 处理重复）。
 */
async function runDiscussionSummary(
  ctx: MoADiscussionContext,
  panel: MoADiscussionPanel,
  nameOf: (id: string) => string,
  sinceTurn: number,
): Promise<{ summary: string; converged: boolean } | null> {
  const prompt = buildDiscussionSummaryPrompt(panel, nameOf, sinceTurn)
  let text: string
  try {
    text = await ctx.seatRunner.runSeat({
      modelId: ctx.preset.aggregatorModelId,
      prompt,
      signal: ctx.signal,
      timeoutMs: DISCUSSION_SUMMARY_TIMEOUT_MS,
    })
  } catch (err) {
    console.warn('[runMoaDiscussion] 纪要更新失败，降级沿用旧纪要:', err)
    return null
  }
  const trimmed = text?.trim() ?? ''
  if (!trimmed) {
    console.warn('[runMoaDiscussion] 纪要模型返回空文本，降级沿用旧纪要')
    return null
  }
  return { summary: trimmed, converged: parseSummaryConvergence(trimmed) }
}

/** 单席超时兜底（与 run-moa-turn 一致） */
function seatTimeoutMs(preset: MoAPreset): number {
  return preset.timeoutMsPerSeat ?? 120_000
}

/**
 * 运行一场圆桌讨论。不抛错——所有失败经 sendPayload 上报，返回 outcome 供调用方记账。
 *
 * 轮次推进（对齐状态机 beginNextRound 语义 + §5.4「全场 ≤ roundLimit 轮」）：
 *   currentRound 初始 0；循环顶部 beginNextRound 推进 → 1..roundLimit 各跑一轮；
 *   第 (roundLimit+1) 次 beginNextRound 返回 phase='finalizing' 即跳出进收口。
 *   故 roundLimit=N 时恰跑 N 轮讨论（turn 1..N），到点必收口——满足「全场 ≤ roundLimit 轮」防失控。
 */
export async function runMoADiscussion(ctx: MoADiscussionContext): Promise<MoADiscussionResult> {
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

  // 2.5 会话上下文：拼 participant / 总结人要看到的近期对话（与 run-moa-turn 同款）。
  //     在 user 落盘后读面板：历史不含本轮 user（避免与「本轮议题」重复）。
  const historyText = buildHistoryForTurn(ctx)

  // 3. 组装讨论 panel（participants 来自 preset.references；user + moderator 席由状态机自动追加）
  //    discussionId 优先用 ctx 预生成（session-service 已据此注册 IPC 通道）；否则就地生成。
  const discussionId = ctx.discussionId ?? nextMoADiscussionId(ctx.sessionId)
  const participants = preset.references.map((r, i) => ({
    speakerId: `ref-${i}`,
    name: r.name,
    modelId: r.modelId,
  }))
  let panel = createMoADiscussionPanel({
    discussionId,
    presetName: preset.name,
    topic: ctx.prompt.slice(0, 200),
    participants,
    roundLimit: ctx.roundLimit ?? preset.roundLimit ?? 3,
  })
  const nameOf = buildSpeakerNameOf(panel)
  emitDiscussionCard(ctx, panel)

  // participant 席位元数据（speakerId → {modelId, name, systemPrompt?}），用于 runSeat
  const seatMeta = new Map<string, { name: string; modelId: string; systemPrompt?: string }>()
  preset.references.forEach((r, i) => {
    seatMeta.set(`ref-${i}`, { name: r.name, modelId: r.modelId, systemPrompt: r.systemPrompt })
  })
  const participantSpeakerIds = participants.map((p) => p.speakerId)

  // 共享纪要已覆盖到的最大轮次（T11）：纪要每次覆盖 (lastSummarizedTurn, currentRound] 的发言，
  //   下一轮参与者只读纪要 + 自此以来的新发言。初值 0 = 首份纪要生成前不压缩。
  let lastSummarizedTurn = 0

  // 4. 多轮串行讨论
  while (panel.phase === 'discussing') {
    // 进入新一轮；到上限 → finalizing，跳出进收口
    panel = beginNextRound(panel)
    if (panel.phase === 'finalizing') break

    if (signal.aborted) {
      panel = markMoADiscussionCancelled(panel)
      emitDiscussionCard(ctx, panel)
      return { outcome: 'cancelled' }
    }

    // 每轮参与者循环开始前：排空用户插话（§5.3）。非空 → 先逐条落 user 发言 entry + emit
    //   （即时可见），再在本轮参与者 prompt 追加 [用户插话] 段（先回应再继续）。
    //   轮数不额外推进（插话本轮内回应）；插话 entry 的 turn 取当前 currentRound。
    const interjects = ctx.interjections?.drain() ?? []
    if (interjects.length) {
      for (const text of interjects) {
        panel = appendDiscussionEntry(panel, { speakerId: MOA_DISCUSSION_USER_SPEAKER_ID, text })
        emitDiscussionCard(ctx, panel)
      }
    }

    const currentRound = panel.currentRound
    let roundFailCount = 0
    for (const speakerId of participantSpeakerIds) {
      if (signal.aborted) {
        panel = markMoADiscussionCancelled(panel)
        emitDiscussionCard(ctx, panel)
        return { outcome: 'cancelled' }
      }
      const seat = seatMeta.get(speakerId)!
      const prompt = buildDiscussionPrompt(
        panel,
        seat.name,
        currentRound,
        nameOf,
        historyText,
        interjects,
        lastSummarizedTurn,
      )
      let text: string
      try {
        text = await ctx.seatRunner.runSeat({
          modelId: seat.modelId,
          prompt,
          systemPrompt: seat.systemPrompt,
          signal,
          timeoutMs: seatTimeoutMs(preset),
        })
      } catch (err) {
        // 取消优先于失败：abort 引起的抛错按 cancelled 处理（与 run-moa-turn 一致）
        if (signal.aborted) {
          panel = markMoADiscussionCancelled(panel)
          emitDiscussionCard(ctx, panel)
          return { outcome: 'cancelled' }
        }
        roundFailCount++
        const reason = err instanceof Error ? err.message : String(err)
        panel = appendDiscussionEntry(panel, {
          speakerId,
          text: `（本席本轮发言失败：${reason}）`,
        })
        emitDiscussionCard(ctx, panel)
        continue
      }
      // runSeat 返回但中途被 abort → cancelled（不落半截发言）
      if (signal.aborted) {
        panel = markMoADiscussionCancelled(panel)
        emitDiscussionCard(ctx, panel)
        return { outcome: 'cancelled' }
      }
      panel = appendDiscussionEntry(panel, { speakerId, text })
      emitDiscussionCard(ctx, panel)
    }

    // 一轮内全员失败 → 无法形成有效讨论，error 收场（§5.4 防失控）
    if (roundFailCount === participantSpeakerIds.length) {
      panel = setMoADiscussionPhase(panel, 'error')
      emitDiscussionCard(ctx, panel)
      const msg = '圆桌讨论所有席位本轮均发言失败，无法收口。请检查模型可用性或切回单模型。'
      sendPayload({
        kind: 'tagent_event',
        event: { type: 'session_error', message: msg, error: classifyUserFacingError(msg) },
      })
      sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
      return { outcome: 'error', error: msg }
    }

    // 共享纪要更新（T11）：每 DISCUSSION_SUMMARY_EVERY_TURNS 轮（第 2/4/6…轮）参与者发言全部
    //   结束后、收敛判定之前，用 aggregatorModelId 把讨论压成结构化纪要。纪要覆盖 (lastSummarizedTurn,
    //   currentRound] 的发言；成功 → updateDiscussionRunningSummary + emit（讨论室可见）+ 推进
    //   lastSummarizedTurn。失败/空 → 降级沿用旧纪要（runDiscussionSummary 内部 catch），不阻断讨论。
    if (panel.currentRound % DISCUSSION_SUMMARY_EVERY_TURNS === 0 && panel.currentRound >= 2) {
      const summaryRes = await runDiscussionSummary(ctx, panel, nameOf, lastSummarizedTurn)
      if (summaryRes && !signal.aborted) {
        panel = updateDiscussionRunningSummary(panel, summaryRes.summary)
        lastSummarizedTurn = panel.currentRound
        emitDiscussionCard(ctx, panel)
        // 收敛升级：纪要判定「收敛: 是」且 currentRound >= 2 → 直接 finalizing 收口
        //   （与 T9 evaluateDiscussionConvergence 二选一命中即收口；纪要优先，T9 作降级）。
        //   abort 在纪要跑完后发生则不强行 finalizing，交回循环顶部 cancel 路径处理。
        if (summaryRes.converged && panel.currentRound >= 2) {
          panel = setMoADiscussionPhase(panel, 'finalizing')
          emitDiscussionCard(ctx, panel)
          break
        }
      }
    }

    // 提前收敛（T9）：本轮参与者发言已收敛 → 不再 beginNextRound，直接进收口段。
    //   evaluateDiscussionConvergence 内置 minRounds（默认 2）：未聊满 2 轮不判定，给讨论展开机会；
    //   收敛后 setMoADiscussionPhase('finalizing') + emit，与「轮数到上限自然 finalizing」落点一致
    //   （若该轮恰为最后一轮，下一轮 beginNextRound 也会 finalizing，二者不冲突）。
    //   user 插话不计入收敛判定（见纯函数注释），故插话不会把讨论强行收口。
    if (evaluateDiscussionConvergence(panel)) {
      panel = setMoADiscussionPhase(panel, 'finalizing')
      emitDiscussionCard(ctx, panel)
      break
    }
    // 一轮结束：下一轮在循环顶部 beginNextRound 推进
  }

  // 5. 收口（finalizing）：moderator 用 aggregatorModelId 跑一次，流式推正文
  if (signal.aborted) {
    panel = markMoADiscussionCancelled(panel)
    emitDiscussionCard(ctx, panel)
    return { outcome: 'cancelled' }
  }
  // 收口前再 drain 一次：把上一轮参与者循环期间到达的插话落 user entry（§5.3「插话发生在
  //   finalizing 之前最后轮 → 总结人 prompt 也包含」）。buildModeratorPrompt 读最新 panel.entries，
  //   故总结人能在「全部记录」里看到这些插话并纳入共识。无插话时行为不变。
  const finalInterjects = ctx.interjections?.drain() ?? []
  if (finalInterjects.length) {
    for (const text of finalInterjects) {
      panel = appendDiscussionEntry(panel, { speakerId: MOA_DISCUSSION_USER_SPEAKER_ID, text })
    }
  }
  emitDiscussionCard(ctx, panel) // 推 finalizing 状态卡

  const summaryPrompt = buildModeratorPrompt(panel, nameOf, historyText)
  let summary: string
  try {
    summary = await ctx.seatRunner.runSeat({
      modelId: preset.aggregatorModelId,
      prompt: summaryPrompt,
      signal,
      timeoutMs: seatTimeoutMs(preset),
      onTextDelta: (delta) => sendPayload({ kind: 'stream_text_delta', text: delta }),
    })
  } catch (err) {
    if (signal.aborted) {
      panel = markMoADiscussionCancelled(panel)
      emitDiscussionCard(ctx, panel)
      return { outcome: 'cancelled' }
    }
    panel = setMoADiscussionPhase(panel, 'error')
    emitDiscussionCard(ctx, panel)
    const msg = `圆桌讨论总结人收口失败：${err instanceof Error ? err.message : String(err)}`
    sendPayload({
      kind: 'tagent_event',
      event: { type: 'session_error', message: msg, error: classifyUserFacingError(msg) },
    })
    sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
    return { outcome: 'error', error: msg }
  }
  if (signal.aborted) {
    panel = markMoADiscussionCancelled(panel)
    emitDiscussionCard(ctx, panel)
    return { outcome: 'cancelled' }
  }
  const trimmed = summary.trim()
  if (!trimmed) {
    panel = setMoADiscussionPhase(panel, 'error')
    emitDiscussionCard(ctx, panel)
    const msg = '圆桌讨论总结人未返回共识方案'
    sendPayload({
      kind: 'tagent_event',
      event: { type: 'session_error', message: msg, error: classifyUserFacingError(msg) },
    })
    sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
    return { outcome: 'error', error: msg }
  }

  // 完成：finalize + 推 done 卡 + 落盘 final assistant + result + turn_end
  panel = finalizeMoADiscussion(panel, trimmed)
  emitDiscussionCard(ctx, panel)
  persistAndPushFinalAssistant(ctx, trimmed, preset.aggregatorModelId, moaDiscussionConsensusUuid(panel.discussionId))
  sendPayload({ kind: 'result', subtype: 'success' })
  sendPayload({ kind: 'tagent_event', event: { type: 'turn_end' } })
  return { outcome: 'done' }
}
