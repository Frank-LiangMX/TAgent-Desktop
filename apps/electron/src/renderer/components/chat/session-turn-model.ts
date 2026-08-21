/**
 * 会话 turn 分组模型
 *
 * 问题：Agent 多步工具循环会产生
 *   assistant(tool) → user(tool_result) → assistant(tool) → … → assistant(text)
 * 若逐条渲染，模型铭牌重复插入、工具徽章刷屏，会话被「污染」。
 *
 * 规则（对齐 TAgent_General groupIntoTurns）：
 * 1. 真正用户输入（含 text）→ 独立 user 段
 * 2. 中间 tool_result 用户消息 + 多段 assistant → 合并为一个 assistant-turn
 * 3. 同一 turn 内：过程块（thinking / tool_use / 中间 text）进过程组；末尾连续 text 作交付回答
 * 4. 模型铭牌只取 turn 首条 assistant 的 modelId
 */

import type {
  TAgentAssistantMessage,
  TAgentContentBlock,
  TAgentMessage,
  TAgentTextBlock,
  TAgentThinkingBlock,
  TAgentToolResultBlock,
  TAgentToolUseBlock,
  TAgentUserMessage,
  TurnDuration,
  MoARoundtablePanel,
  MoADiscussionPanel,
} from '@tagent/shared'
import { isControlUserTextBlock, sanitizeAssistantTextForDisplay } from '@tagent/shared'
import type { ProcessDisplayMode } from './process-group-model'
import { isSubagentRuntimeTaskType } from './subagent-ui-model'
import { formatElapsedDuration } from '../../lib/time-utils'

// ===== 输入侧 DisplayItem 最小形状（避免循环依赖 Chat.tsx） =====

export interface TurnSourceItem {
  key: string
  message?: TAgentMessage
  streamingText?: string
  streamingThinking?: string
  streaming?: boolean
  taskCard?: unknown
  compactStatus?: 'compacting' | 'complete'
  compactTrigger?: 'auto' | 'manual'
  /** MoA 圆桌卡（主进程 moa_roundtable 事件就地 upsert；standalone 渲染） */
  moaRoundtable?: MoARoundtablePanel
  /** 圆桌讨论入口卡（主进程 moa_discussion 事件就地 upsert；standalone 渲染，点击进全屏讨论室） */
  moaDiscussion?: MoADiscussionPanel
}

// ===== 输出 turn =====

export type SessionRenderTurn =
  | { kind: 'user'; key: string; message: TAgentUserMessage }
  | {
      kind: 'assistant-turn'
      key: string
      /** turn 内全部源 item（含 tool_result 用户消息、流式占位） */
      items: TurnSourceItem[]
      modelId?: string
      isStreaming: boolean
    }
  | { kind: 'standalone'; key: string; item: TurnSourceItem }

// ===== 过程 / 回答拆分 =====

export type ProcessEntry =
  | {
      type: 'thinking'
      thinking: string
      key: string
      /** 所属消息 createdAt（ms），用于估算本段思考时长 */
      at?: number
      /** 本段思考时长（秒）；由 annotateThinkingDurations 填入 */
      durationSec?: number
    }
  | {
      type: 'tool'
      key: string
      tool: TAgentToolUseBlock
      result?: TAgentToolResultBlock
      at?: number
    }
  /** 用户在运行中注入的引导；视觉上作为当前执行块内的用户气泡。 */
  | { type: 'guidance'; text: string; key: string; at?: number }
  | { type: 'text'; text: string; key: string; at?: number }

export interface TurnPresentation {
  modelId?: string
  process: ProcessEntry[]
  /** 交付给用户的最终文本（turn 末尾连续 text） */
  answerTexts: string[]
  isStreaming: boolean
  streamingText?: string
  streamingThinking?: string
}

/** 会话级流式缓冲（与 DisplayItem 分离，由 Chat 传入 live 轮） */
export interface TurnStreamState {
  text: string
  thinking: string
}

/**
 * 主线发起子代理的工具名（kscc 为 Agent，Pi/部分路径为 task/Task）。
 * 这些 tool_use 只应变成入口卡片，不得进主过程组展开结果。
 */
export function isSubagentLauncherTool(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'agent' || n === 'task'
}

/**
 * 将 turn 内子代理消息（assistant + parentToolUseId）按 parentToolUseId 分组，保持原始顺序。
 *
 * 一个子代理执行过程会产生多条带 parentToolUseId 的 assistant 消息（thinking / tool_use /
 * 中间文本 / 最终结果）。主会话只渲染入口卡片，详情页才平铺这些消息。
 */
export function groupSubagentItems(items: TurnSourceItem[]): TurnSourceItem[][] {
  const groups = new Map<string, TurnSourceItem[]>()
  const order: string[] = []
  for (const it of items) {
    const m = it.message
    if (m?.type === 'assistant' && m.parentToolUseId) {
      const key = m.parentToolUseId
      let group = groups.get(key)
      if (!group) {
        group = []
        groups.set(key, group)
        order.push(key)
      }
      group.push(it)
    }
  }
  return order.map((k) => groups.get(k)!)
}

/**
 * 把每个子代理入口钉到「创建当时」的 work_stage。
 *
 * 主线 Agent/task tool_use 不进过程区，旧逻辑会把全部入口挂到最新探索阶段，
 * 后一轮子代理会把已完成入口拽到新入口。按 launcher 之前最近的过程工具所属阶段锚定。
 * 发起时尚无过程工具时：有阶段则钉在第一段，否则仍为 null（时间线尚无 stage）。
 */
export function assignSubagentHostStageKeys(
  items: TurnSourceItem[],
  stages: ReadonlyArray<{ key: string; toolIds: readonly string[] }>,
  subagentIds: readonly string[],
): Map<string, string | null> {
  const toolIdToStage = new Map<string, string>()
  for (const stage of stages) {
    for (const id of stage.toolIds) {
      toolIdToStage.set(id, stage.key)
    }
  }

  const wanted = new Set(subagentIds)
  const result = new Map<string, string | null>()
  let currentStage: string | null = null

  for (const it of items) {
    const m = it.message
    if (m?.type !== 'assistant' || m.parentToolUseId) continue
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      const tu = b as TAgentToolUseBlock
      if (isSubagentLauncherTool(tu.name)) {
        if (wanted.has(tu.id)) result.set(tu.id, currentStage)
        continue
      }
      const mapped = toolIdToStage.get(tu.id)
      if (mapped) currentStage = mapped
    }
  }

  const firstStage = stages[0]?.key ?? null
  for (const id of subagentIds) {
    if (!result.has(id)) {
      result.set(id, currentStage ?? firstStage)
      continue
    }
    if (result.get(id) == null) result.set(id, firstStage)
  }
  return result
}

/**
 * 主线直系 vs 嵌套派出。
 * 嵌套 = 子代理自己的 assistant（已有 parentToolUseId）里又出现 Agent/task。
 */
export function classifySubagentLaunchers(items: TurnSourceItem[]): {
  direct: string[]
  nested: Set<string>
} {
  const direct: string[] = []
  const nested = new Set<string>()
  const seenDirect = new Set<string>()
  for (const it of items) {
    const m = it.message
    if (m?.type !== 'assistant') continue
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      const tu = b as TAgentToolUseBlock
      if (!isSubagentLauncherTool(tu.name)) continue
      if (m.parentToolUseId) {
        nested.add(tu.id)
        continue
      }
      if (seenDirect.has(tu.id)) continue
      seenDirect.add(tu.id)
      direct.push(tu.id)
    }
  }
  return { direct, nested }
}

/**
 * 主会话应展示的子代理入口 id（只含主线直系，不含孙辈）。
 *
 * 1. 主线 assistant 上的 Agent/task tool_use
 * 2. 主线 launcher 还没进 items 时：parented / taskCard 里「不是嵌套派出」的 id（流式兜底）
 */
export function listSubagentEntryIds(items: TurnSourceItem[]): string[] {
  const { direct, nested } = classifySubagentLaunchers(items)
  if (direct.length > 0) return direct

  const order: string[] = []
  const seen = new Set<string>()
  const push = (id: string | null | undefined): void => {
    if (!id || seen.has(id) || nested.has(id)) return
    seen.add(id)
    order.push(id)
  }
  for (const it of items) {
    const m = it.message
    if (m?.type === 'assistant' && m.parentToolUseId) push(m.parentToolUseId)
    const card = it.taskCard as { toolUseId?: string; taskType?: string } | undefined
    if (card?.toolUseId && isSubagentRuntimeTaskType(card.taskType)) {
      push(card.toolUseId)
    }
  }
  return order
}

/**
 * 从 items 中提取发起某子代理的 launcher tool_use 块。
 *
 * 主线程通过主线 assistant 的 tool_use（name=Agent|task|Task，id=parentToolUseId）发起子代理；
 * 其 input 即任务指令。子代理详情页用它渲染「任务指令」区。
 */
export function findSubagentTaskTool(
  items: TurnSourceItem[],
  parentToolUseId: string,
): { name: string; input: Record<string, unknown> } | null {
  for (const it of items) {
    const m = it.message
    if (m?.type !== 'assistant' || m.parentToolUseId) continue
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const tu = b as TAgentToolUseBlock
        // 必须是 Agent|Task：同 id 的 Bash/Glob 等不得冒充子代理 launcher
        if (tu.id === parentToolUseId && isSubagentLauncherTool(tu.name)) {
          return { name: tu.name, input: tu.input ?? {} }
        }
      }
    }
  }
  return null
}

/**
 * 过滤出某子代理（parentToolUseId）的全部消息，含 assistant（思考/工具/文本）
 * 与 user（tool_result 合成回传），保持到达顺序。详情页用它渲染完整会话流。
 */
export function filterSubagentItems(
  items: TurnSourceItem[],
  parentToolUseId: string,
): TurnSourceItem[] {
  return items.filter((it) => {
    const m = it.message
    if (!m) return false
    return m.parentToolUseId === parentToolUseId
  })
}

/**
 * 从持久化的 turnDurations（key = turn 最后一条主线 assistant 消息 createdAt）回填
 * 当前渲染 key（turn-xxx）→ 完成耗时 的映射，供加载历史后恢复「完成/停止/出错 Xs」。
 */
export function backfillTurnDurations(
  items: TurnSourceItem[],
  persisted: Record<string, TurnDuration> | undefined,
): Record<string, TurnDuration> {
  const result: Record<string, TurnDuration> = {}
  if (!persisted || Object.keys(persisted).length === 0) return result
  const turns = groupItemsIntoTurns(items)
  for (const t of turns) {
    if (t.kind !== 'assistant-turn') continue
    const createdAt = getTurnLastMainAssistantCreatedAt(t.items)
    if (createdAt != null && persisted[createdAt] != null) {
      result[t.key] = persisted[createdAt]!
    }
  }
  return result
}

/** 用户已发、尚无 assistant 落盘时的合成 live turn key（与 Chat 渲染一致） */
export function syntheticLiveTurnKeyForUser(userTurnKey: string): string {
  return `turn-${userTurnKey}-live`
}

/**
 * 终态 error 文案分类：决定一轮结束时 recordCompletion 的 endedBy 与是否抬 SessionErrorBanner。
 *
 * Chat 的 result 分支（isErrorResult / errorTexts）与 session_error 分支共用此纯函数收口，
 * 避免 abortLike 误判把 AskUser 关窗后的迟到 interrupt 当成用户停止（SESSION-UX-RESIDUAL-SPEC §1/§4）：
 * - 'stopped'：真用户停止 / 上一轮停止窗口内迟到的 abort 文案 → recordCompletion('stopped')，不抬错误条
 * - 'complete'：AskUser 关窗后短窗口内的迟到 interrupt → 视为正常完成（**非**用户停止），
 *   走 completeRun，不抬错误条、不把整轮标 stopped
 * - 'error'：真错误文案 → 抬 SessionErrorBanner + recordCompletion('error')
 */
export const RUN_ABORT_STALE_WINDOW_MS = 8000
export const RUN_ASK_DISMISS_WINDOW_MS = 3000
const RUN_ABORT_LIKE_RE =
  /aborted|interrupted by user|Request interrupted|用户取消|用户中止|用户停止|操作已中止|会话已结束/i

export type RunCompletionVerdict = 'stopped' | 'complete' | 'error'

export function classifyRunAbort(input: {
  userStopped: boolean
  lastUserStopAt: number
  lastAskUserDismissAt: number
  now: number
  errorText: string
}): RunCompletionVerdict {
  const { userStopped, lastUserStopAt, lastAskUserDismissAt, now, errorText } = input
  const abortLike =
    userStopped ||
    (lastUserStopAt > 0 && now - lastUserStopAt < RUN_ABORT_STALE_WINDOW_MS) ||
    RUN_ABORT_LIKE_RE.test(errorText)
  if (!abortLike) return 'error'
  // 真用户停止优先（用户显式点 STOP）：仍标 stopped
  if (userStopped) return 'stopped'
  // AskUser 关窗后短窗口内的迟到 interrupt：非用户停止，按正常完成收口
  if (lastAskUserDismissAt > 0 && now - lastAskUserDismissAt < RUN_ASK_DISMISS_WINDOW_MS) {
    return 'complete'
  }
  // 其余 abort（迟到 interrupt 文案 / 上一轮停止窗口内的 error）→ 已中断
  return 'stopped'
}

export function isSyntheticRunTurnKey(turnKey: string): boolean {
  return turnKey.endsWith('-live') || turnKey.startsWith('turn-stream-')
}

/**
 * 当前 run 应记完成耗时的 turn key。
 * 末尾是 user 且 run 仍 active → 合成 live key；否则取末尾 assistant-turn。
 */
export function resolveRunTurnKey(
  turns: SessionRenderTurn[],
  sessionId: string,
  runActive: boolean,
): string | null {
  const last = turns[turns.length - 1]
  if (!last) return null
  if (last.kind === 'assistant-turn') return last.key
  if (!runActive) return null
  if (last.kind === 'user') return syntheticLiveTurnKeyForUser(last.key)
  return `turn-stream-${sessionId}`
}

/** 用户发完即停、尚无 assistant-turn 时，在 user 气泡后补「已中断」占位 */
export function shouldRenderStoppedSyntheticShell(
  turns: SessionRenderTurn[],
  turnIndex: number,
  completedDurations: Record<string, TurnDuration>,
): boolean {
  const turn = turns[turnIndex]
  if (turn?.kind !== 'user') return false
  const syntheticKey = syntheticLiveTurnKeyForUser(turn.key)
  if (completedDurations[syntheticKey] == null) return false
  const next = turns[turnIndex + 1]
  return next?.kind !== 'assistant-turn'
}

export type RunStreamSnapshot = {
  text?: string
  thinking?: string
}

/**
 * 本轮是否已进入 Agent 处理（有流式/assistant/工具/MoA 等）。
 * 停止前仍为 false → 视为「未开始」，可走撤回而非「已中断」。
 */
export function hasRunStartedProcessing(
  items: TurnSourceItem[],
  stream?: RunStreamSnapshot | null,
): boolean {
  if (stream?.text?.trim() || stream?.thinking?.trim()) return true

  let lastUserIdx = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]?.message
    if (m?.type === 'user' && isRealUserInput(m)) {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return false

  for (let i = lastUserIdx + 1; i < items.length; i++) {
    const it = items[i]!
    if (it.compactStatus) return true
    if (it.streaming || it.streamingText || it.streamingThinking) return true
    if (it.taskCard) return true
    if (it.moaRoundtable || it.moaDiscussion) return true
    const m = it.message
    if (!m) continue
    if (m.type === 'assistant') {
      if (m.parentToolUseId) continue
      if (isCrewNoticeMessage(m)) continue
      return true
    }
    if (m.type === 'user') return true
  }
  return false
}

/** 撤回未开始轮：去掉末尾真实 user 及其后的占位（应无后续内容） */
export function sliceItemsBeforeLastRealUser<T extends TurnSourceItem>(items: T[]): T[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]?.message
    if (m?.type === 'user' && isRealUserInput(m)) {
      return items.slice(0, i)
    }
  }
  return null
}

/** 取 items 中最后一条主线（无 parentToolUseId）assistant 消息的 createdAt（完整轮的稳定标识） */
export function getLastMainAssistantCreatedAt(items: TurnSourceItem[]): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]?.message
    if (m?.type === 'assistant' && !m.parentToolUseId && m.createdAt) return m.createdAt
  }
  return undefined
}

/** 取 turn 内最后一条主线（无 parentToolUseId）assistant 消息的 createdAt */
function getTurnLastMainAssistantCreatedAt(items: TurnSourceItem[]): number | undefined {
  return getLastMainAssistantCreatedAt(items)
}

/** 用户消息是否为「真实输入」（有非空 text）。
 *
 * 带 parentToolUseId 的 user 消息一律不算真实输入：SDK 委派子代理时会把
 * 「发给子代理的任务指令」作为一条 user 消息（text + parent_tool_use_id +
 * subagent_type）流入主线程流，这类消息是合成委派消息，不应渲染为用户气泡。
 * 真实用户输入由主进程构造时 parentToolUseId 恒为 null。
 *
 * kscc 中断/合成控制文（如 `[Request interrupted by user for tool use]`）也不是用户气泡。
 */
export function isRealUserInput(message: TAgentUserMessage): boolean {
  if (message.parentToolUseId) return false
  if (message.isSynthetic) return false
  if (isSdkControlUserMessage(message)) return false
  return message.content.some(
    (b) => b.type === 'text' && typeof (b as TAgentTextBlock).text === 'string' && (b as TAgentTextBlock).text.trim().length > 0,
  )
}

/**
 * kscc / claude-code 注入的控制型 user 消息（中断、拒工具等），不当聊天用户气泡。
 * SDK 常不带 isSynthetic，只能靠文案哨兵识别。
 */
export function isSdkControlUserMessage(message: TAgentUserMessage): boolean {
  if (message.isSynthetic) return true
  for (const b of message.content) {
    if (b.type !== 'text') continue
    const t = (b as TAgentTextBlock).text?.trim() ?? ''
    if (t && isControlUserTextBlock(t)) return true
  }
  return false
}

/** 看板完成回流等系统通知（不当普通助手轮） */
export function isCrewNoticeMessage(message: TAgentAssistantMessage): boolean {
  if (message.modelId === '班组通知') return true
  for (const b of message.content) {
    if (b.type === 'text' && typeof (b as TAgentTextBlock).text === 'string') {
      if ((b as TAgentTextBlock).text.trimStart().startsWith('【班组完成】')) return true
    }
  }
  return false
}

/** 用户消息是否仅为 tool_result（合成回传，不应当作用户气泡） */
export function isToolResultOnlyUser(message: TAgentUserMessage): boolean {
  const hasToolResult = message.content.some((b) => b.type === 'tool_result')
  return hasToolResult && !isRealUserInput(message)
}

/**
 * 将扁平 DisplayItem 列表分组为可渲染 turn。
 */
export function groupItemsIntoTurns(items: TurnSourceItem[]): SessionRenderTurn[] {
  const turns: SessionRenderTurn[] = []
  let current: Extract<SessionRenderTurn, { kind: 'assistant-turn' }> | null = null

  const flush = (): void => {
    if (current && current.items.length > 0) {
      turns.push(current)
    }
    current = null
  }

  for (const item of items) {
    // 压缩边界：时间线独立占位（会打断 turn）
    if (item.compactStatus) {
      flush()
      turns.push({ kind: 'standalone', key: item.key, item })
      continue
    }

    // MoA 圆桌卡：时间线独立占位（不并入 assistant-turn，避免与汇总正文抢铭牌）
    if (item.moaRoundtable) {
      flush()
      turns.push({ kind: 'standalone', key: item.key, item })
      continue
    }

    // 圆桌讨论入口卡：时间线独立占位（同 moaRoundtable：避免铭牌污染）
    if (item.moaDiscussion) {
      flush()
      turns.push({ kind: 'standalone', key: item.key, item })
      continue
    }

    // 子代理 taskCard：并入当前 assistant-turn，禁止 flush 拆 turn
    // （旧逻辑 standalone 会把一轮拆成多段，每段再刷一次模型铭牌）。
    // 卡片状态由 Chat.subagentCards + SubagentEntryCard 消费，不在此独立渲染。
    if (item.taskCard && !item.message && !item.streaming) {
      if (!current) {
        current = {
          kind: 'assistant-turn',
          key: `turn-${item.key}`,
          items: [item],
          isStreaming: false,
        }
      } else {
        current.items.push(item)
      }
      continue
    }

    const msg = item.message

    if (msg?.type === 'user') {
      if (isSteerUserMessage(msg)) {
        // 引导属于正在执行的同一轮：进运行块内的时间线，不新起普通用户回合。
        if (!current) {
          current = {
            kind: 'assistant-turn',
            key: `turn-${item.key}`,
            items: [item],
            isStreaming: false,
          }
        } else {
          current.items.push(item)
        }
      } else if (isRealUserInput(msg)) {
        flush()
        turns.push({ kind: 'user', key: item.key, message: msg })
      } else if (
        isToolResultOnlyUser(msg) ||
        msg.parentToolUseId ||
        isSdkControlUserMessage(msg)
      ) {
        // tool_result / 子代理委派 / SDK 中断控制文 → 归入当前 assistant-turn，不渲染用户气泡
        if (!current) {
          current = {
            kind: 'assistant-turn',
            key: `turn-${item.key}`,
            items: [item],
            isStreaming: false,
          }
        } else {
          current.items.push(item)
        }
      } else {
        // 空 user 等：忽略或独立
        flush()
        turns.push({ kind: 'standalone', key: item.key, item })
      }
      continue
    }

    // 班组完成通知：独立系统条，禁止并入 assistant-turn（否则会进回答区）
    if (msg?.type === 'assistant' && isCrewNoticeMessage(msg)) {
      flush()
      turns.push({ kind: 'standalone', key: item.key, item })
      continue
    }

    if (msg?.type === 'assistant' || item.streaming || item.streamingText || item.streamingThinking) {
      // 铭牌只认主线 assistant（无 parentToolUseId）；子代理 modelId 不得污染主会话
      const mainlineModel =
        msg?.type === 'assistant' && !msg.parentToolUseId ? msg.modelId : undefined
      if (!current) {
        current = {
          kind: 'assistant-turn',
          key: `turn-${item.key}`,
          items: [item],
          modelId: mainlineModel,
          isStreaming: Boolean(item.streaming),
        }
      } else {
        current.items.push(item)
        if (item.streaming) current.isStreaming = true
        if (!current.modelId && mainlineModel) {
          current.modelId = mainlineModel
        }
      }
      continue
    }

    flush()
    turns.push({ kind: 'standalone', key: item.key, item })
  }

  flush()
  return turns
}

/**
 * 尾部 text 之前是否已无「未完成」的 tool_use。
 *
 * - 有未完成 tool → false（正文先留过程区，防工具结果来前回跳）
 * - 无 tool，或 tool 全部已有 result → true（允许外置）
 *
 * 产品点（对齐用户对 Proma 的手感）：thinking 结束后的交付正文应进**回答区**
 * Markdown 流式，而不是先进过程/思考区、等 idle 再砸进回答壳。
 * 「无 tool 时也允许外置」与旧 Proma 保守策略不同——旧策略会把 thinking+text
 * 整段摁在过程区到回合结束，造成「最终输出被当成思考」的观感。
 */
export function areToolsBeforeIndexCompleted(
  blocks: TAgentContentBlock[],
  endIndex: number,
  completedToolResultIds: ReadonlySet<string>,
): boolean {
  for (let index = 0; index < endIndex; index++) {
    const block = blocks[index]
    if (block?.type !== 'tool_use') continue
    if (!completedToolResultIds.has((block as TAgentToolUseBlock).id)) return false
  }
  return true
}

/**
 * 从 turn 源 items 构建展示：过程组 + 最终回答 + 流式
 *
 * 拆分契约：
 * - live/streaming 且有过程块：尾部 text 之前无未完成 tool → 外置到回答区流式；
 *   有未完成 tool → 整轮（含 streamingText）留过程组。
 * - 无未完成 tool 时，streamingText 也不再 hold 进过程区（避免交付正文进思考/过程 UI）。
 * - 历史轮或无过程块：按尾部连续 text 外置（纯 text 直接进回答）。
 *
 * @param options.isLiveTurn 整轮仍在跑（含工具间隙）
 * @param options.streamState live 轮正文/思考（delta 累积，不绑 item uuid）
 */
export function buildTurnPresentation(
  turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }>,
  options?: {
    isLiveTurn?: boolean
    streamState?: TurnStreamState
    /**
     * 过程展示模式：
     * - full：尾部 text 外置到回答壳（现网）
     * - concise：全部 text 留在 process，由时间线只把尾部 final 投成 narrative（answerTexts=[]）
     */
    displayMode?: ProcessDisplayMode
  },
): TurnPresentation {
  const process: ProcessEntry[] = []
  const answerTexts: string[] = []
  const resultById = new Map<string, TAgentToolResultBlock>()
  let streamingText: string | undefined
  let streamingThinking: string | undefined
  let isStreaming = turn.isStreaming
  let modelId = turn.modelId
  const isLiveTurn = options?.isLiveTurn === true
  const externalStream = options?.streamState
  const isConcise = options?.displayMode === 'concise'

  // 先收集 tool_result；落盘 item 上的 streaming 字段仅作 Pi 兼容兜底
  for (const item of turn.items) {
    if (item.message?.type === 'user') {
      // 子代理合成 user（委派指令 / 子代理 tool_result）不参与主线 result 绑定
      if (item.message.parentToolUseId) continue
      for (const b of item.message.content) {
        if (b.type === 'tool_result') {
          const rb = b as TAgentToolResultBlock
          // Agent/task 结果体积极大且已有入口卡，不进主过程区
          resultById.set(rb.toolUseId, rb)
        }
      }
    }
    // 子代理消息 / 带 parent 的流式占位：绝不污染主线 streaming 正文与铭牌
    if (item.message?.type === 'assistant' && item.message.parentToolUseId) {
      continue
    }
    if (item.streaming) {
      isStreaming = true
      // 覆盖式取最新，禁止 += 把同一占位或残留占位拼成双份
      if (item.streamingText != null) streamingText = item.streamingText
      if (item.streamingThinking != null) streamingThinking = item.streamingThinking
    }
    // 落盘升级项（sdk_message 就地升级）已清 streamingText，不再收集——
    // 打字机续接靠 useSmoothStream 内部 prevContentRef，保留旧 streamingText 会导致多轮残留/重复文字。
    // 铭牌只取主线 modelId
    if (!modelId && item.message?.type === 'assistant' && !item.message.parentToolUseId) {
      modelId = item.message.modelId
    }
  }

  // live 轮：会话级 streamState 为权威来源（delta 不绑 DisplayItem）
  if (isLiveTurn && externalStream) {
    streamingText = externalStream.text
      ? sanitizeAssistantTextForDisplay(externalStream.text) || undefined
      : undefined
    streamingThinking = externalStream.thinking ? externalStream.thinking : undefined
    if (externalStream.text || externalStream.thinking) {
      isStreaming = true
    }
  }

  // 按顺序收集主线 assistant 内容块（子代理 parentToolUseId 不进主过程组）
  // Agent/task launcher 也不进过程组——改由 SubagentEntryCard 独占展示。
  // pi 内核 toolcall_end 与 turn_end 都产含 tool_use 的 assistant（同 id），需按 tool_use id 去重。
  // **稳定 key**（S2.4）：tool 用 `tool-${id}`；thinking/text/blk 用「消息 uuid + 块在 content[] 中的下标」。
  //   - partial→final 原地 upsert（S1）uuid 不变，Pi 顺序追加 → blockIndex 不变 → 同一段思考 key 稳定，不随列表重编 remount。
  //   - 旧消息无 uuid 时回退 item.key（uuid upsert 亦保 key 不变）。
  type TimelineSource =
    | { kind: 'block'; block: TAgentContentBlock; key: string; at?: number }
    | { kind: 'guidance'; text: string; key: string; at?: number }
  const timeline: TimelineSource[] = []
  const toolUseSeen = new Map<string, { block: TAgentToolUseBlock; key: string; rich: boolean }>()
  for (const item of turn.items) {
    const message = item.message
    if (message?.type === 'user' && isSteerUserMessage(message)) {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as TAgentTextBlock).text)
        .join('\n')
        .trim()
      if (text) timeline.push({ kind: 'guidance', key: `guidance-${item.key}`, text, at: message.createdAt })
      continue
    }
    if (message?.type !== 'assistant' || message.parentToolUseId) continue
    const rich = message.content.some((b) => b.type === 'thinking' || b.type === 'text')
    const ownerKey = message.uuid ?? item.key
    const at = message.createdAt
    message.content.forEach((block, blockIndex) => {
      if (block.type === 'tool_use') {
        const tu = block as TAgentToolUseBlock
        // 子代理入口：过程区完全不渲染（含超长 tool_result）
        if (isSubagentLauncherTool(tu.name)) return
        const stableKey = `tool-${tu.id}`
        const prev = toolUseSeen.get(tu.id)
        if (prev) {
          // 已有同 id：若当前消息更完整（rich）且旧的只是占位，替换内容但**保留稳定 key**
          if (rich && !prev.rich) {
            const idx = timeline.findIndex((x) => x.kind === 'block' && x.key === prev.key)
            if (idx >= 0) timeline[idx] = { kind: 'block', block, key: prev.key, at }
            toolUseSeen.set(tu.id, { block: tu, key: prev.key, rich })
          }
          return
        }
        toolUseSeen.set(tu.id, { block: tu, key: stableKey, rich })
        timeline.push({ kind: 'block', block, key: stableKey, at })
      } else if (block.type === 'thinking') {
        timeline.push({ kind: 'block', block, key: `think-${ownerKey}-${blockIndex}`, at })
      } else if (block.type === 'text') {
        timeline.push({ kind: 'block', block, key: `text-${ownerKey}-${blockIndex}`, at })
      } else {
        timeline.push({ kind: 'block', block, key: `blk-${ownerKey}-${blockIndex}`, at })
      }
    })
  }
  const allBlocks = timeline.filter(
    (entry): entry is Extract<TimelineSource, { kind: 'block' }> => entry.kind === 'block',
  )

  // 单真源（S2.2）：消息 content 已带「非空」thinking / text 块时以消息为准——
  // streamState 仅作「尚无 partial」的短暂兜底。正文若再被 streamState 覆盖，
  // 会与 50ms partial 快照来回抢长度 → useSmoothStream 非追加重置 → 前几行抽搐。
  // **partial 不算**：同 uuid partial→final 原地 upsert（S1）时，若 partial 文本
  // 立即把 streamingText 抽空，会让 partial 文本直接进 process 触发 progress tone，
  // final 帧同 uuid 替换再切 final tone → concise-timeline 卡片瞬间闪烁。
  // 只看 final/非 partial 的 message content 触发单真源切换，partial 文本继续走 streamState 路径。
  const isFinalAssistant = (m: TAgentMessage): boolean =>
    m.type === 'assistant' && (m as { _partial?: boolean })._partial !== true
  if (
    allBlocks.some((x) => x.block.type === 'thinking' && (x.block as TAgentThinkingBlock).thinking.trim()) &&
    turn.items.some(
      (it) => it.message?.type === 'assistant' && isFinalAssistant(it.message),
    )
  ) {
    streamingThinking = undefined
  }
  // concise 跨段保护（S3）：上一段 final 文本不得清掉**新段**的 streamState delta。
  // 现象：u1 final(text) 落盘后，u2 段间 progress 的 delta 仍只活在 streamState——
  // 若被这条「以消息为准」守卫一并清空，u2 进度要等 u2 partial/final 才可见＝「结束才出现」。
  // 只在 streamState 与最近一条 final 文本**同段**（前缀/空）时才清；非前缀＝新段，concise 保留。
  // full 仍按原义清（回答壳以消息 content 为准，见 turn-presentation.vitest 「防双源抽搐」用例）。
  const lastFinalAssistantText = (() => {
    for (let i = turn.items.length - 1; i >= 0; i--) {
      const m = turn.items[i]?.message
      if (m?.type === 'assistant' && !m.parentToolUseId && isFinalAssistant(m)) {
        let txt: string | undefined
        for (const b of m.content) {
          if (b.type === 'text' && (b as TAgentTextBlock).text.trim()) txt = (b as TAgentTextBlock).text
        }
        return txt
      }
    }
    return undefined
  })()
  const streamTextRaw = streamingText?.trim() ?? ''
  const streamSameSegmentAsFinal =
    !streamTextRaw ||
    (lastFinalAssistantText != null &&
      (streamTextRaw.startsWith(lastFinalAssistantText.trim()) ||
        lastFinalAssistantText.trim().startsWith(streamTextRaw)))
  if (
    allBlocks.some((x) => x.block.type === 'text' && (x.block as TAgentTextBlock).text.trim()) &&
    turn.items.some(
      (it) => it.message?.type === 'assistant' && isFinalAssistant(it.message),
    ) &&
    (!isConcise || streamSameSegmentAsFinal)
  ) {
    streamingText = undefined
  }

  // 末尾连续 text 作为交付回答：
  // - 前置无未完成 tool → 外置到回答区（含纯 thinking+text，正文不进思考 UI）
  // - 仍有未完成 tool → 留过程组，防工具结果来前回跳
  const blockList = allBlocks.map((x) => x.block)
  const trailingTextStart = getTrailingTextStart(blockList)
  // 流式思考尚未落盘时也算过程块，否则 streamingText 会旁路进回答壳
  const hasProcessBlock =
    blockList.some((b) => b.type === 'tool_use' || b.type === 'thinking') ||
    Boolean((isStreaming || isLiveTurn) && streamingThinking?.trim())
  const completedIds = new Set(resultById.keys())
  const canSplitStreamingFinal =
    trailingTextStart !== null &&
    trailingTextStart > 0 &&
    areToolsBeforeIndexCompleted(blockList, trailingTextStart, completedIds)
  const isActive = isStreaming || isLiveTurn
  // full：live + 过程块时看 canSplitStreamingFinal；否则经典尾部外置。
  // concise：永不外置——text 全留 process，由 timeline 投影为 narrative。
  const splitAnswer =
    !isConcise &&
    trailingTextStart !== null &&
    trailingTextStart > 0 &&
    (isActive && hasProcessBlock ? canSplitStreamingFinal : true)

  const trailingAnswerKeys = new Set(
    splitAnswer && trailingTextStart !== null
      ? allBlocks.slice(trailingTextStart).map((entry) => entry.key)
      : [],
  )

  for (const entry of timeline) {
    if (entry.kind === 'guidance') {
      process.push({ type: 'guidance', key: entry.key, text: entry.text, at: entry.at })
      continue
    }
    const { block, key, at } = entry
    if (trailingAnswerKeys.has(key)) continue
    if (block.type === 'thinking') {
      process.push({
        type: 'thinking',
        key,
        thinking: (block as TAgentThinkingBlock).thinking,
        at,
      })
    } else if (block.type === 'tool_use') {
      const tool = block as TAgentToolUseBlock
      process.push({
        type: 'tool',
        key,
        tool,
        result: resultById.get(tool.id),
        at,
      })
    } else if (block.type === 'text') {
      const text = sanitizeAssistantTextForDisplay((block as TAgentTextBlock).text)
      if (text.trim()) process.push({ type: 'text', key, text, at })
    }
  }

  if (splitAnswer && trailingTextStart !== null) {
    for (let i = trailingTextStart; i < allBlocks.length; i++) {
      const { block } = allBlocks[i]!
      if (block.type === 'text') {
        const text = sanitizeAssistantTextForDisplay((block as TAgentTextBlock).text)
        if (text.trim()) answerTexts.push(text)
      }
    }
  }

  // full：纯 text 无工具/思考 → 当回答壳。concise：留 process 作 narrative。
  if (
    !isConcise &&
    answerTexts.length === 0 &&
    process.length > 0 &&
    !process.some((p) => p.type === 'tool' || p.type === 'thinking')
  ) {
    for (const p of process) {
      if (p.type === 'text') answerTexts.push(p.text)
    }
    const guidance = process.filter((p): p is Extract<ProcessEntry, { type: 'guidance' }> => p.type === 'guidance')
    process.length = 0
    process.push(...guidance)
  }

  // 合并/去重交付文本：多段 assistant 可能带前缀重复，只保留非前缀的最长序列
  const dedupedAnswers = dedupeAnswerTexts(answerTexts)
  const answerJoined = dedupedAnswers.join('\n\n').trim()

  // 流式 thinking 并入过程区：优先续写最后一条 thinking（稳定 key），避免 stream→落盘 remount
  if ((isStreaming || isLiveTurn) && streamingThinking?.trim()) {
    const st = streamingThinking.trim()
    const lastThinkIdx = (() => {
      for (let i = process.length - 1; i >= 0; i--) {
        if (process[i]?.type === 'thinking') return i
      }
      return -1
    })()
    if (lastThinkIdx >= 0) {
      const last = process[lastThinkIdx] as Extract<ProcessEntry, { type: 'thinking' }>
      // 同源续写 / 空→有：原地更新，key 不变
      if (
        !last.thinking.trim() ||
        st.startsWith(last.thinking.trim()) ||
        last.thinking.trim().startsWith(st) ||
        last.key === 'stream-thinking'
      ) {
        process[lastThinkIdx] = { type: 'thinking', key: last.key, thinking: streamingThinking }
      } else if (!process.some((p) => p.type === 'thinking' && p.thinking.trim() === st)) {
        process.push({ type: 'thinking', key: 'stream-thinking', thinking: streamingThinking })
      }
    } else {
      process.push({ type: 'thinking', key: 'stream-thinking', thinking: streamingThinking })
    }
  }

  const streamText = streamingText?.trim() ?? ''

  // 单真源归一（S3，concise+live）：kscc 双源——partial content[] 的 text 块（上次快照）
  // + streamState.text（自上次 partial 以来的新 delta）。两者本属同一段正在生长的正文，
  // 但因 streamState 在带 text 的 partial 到达时被清（stream-item-model shouldClearStreamText），
  // streamState 永远只装「上次 partial 之后的新增量」。若各推一条 process text，pushNarrative
  // 会把非前缀的两条拼成 `快照\n\n增量`（live 抽搐，final 对齐才稳＝「结束才正常」）。
  // 这里取「最后一条仍在流式（无 stop_reason）的主线 assistant」的末个非空 text 块」，
  // 据此把 delta 拼到该 text 块尾部，使 partial+delta 成为单一 narrative 源（逐字打字机）。
  // 与 Pi 单源语义对齐（pi-agent-adapter 不再发 stream_text_delta）；不改主进程 IR。
  const lastStreamingPartialText = (() => {
    for (let i = turn.items.length - 1; i >= 0; i--) {
      const m = turn.items[i]?.message
      if (m?.type === 'assistant' && !m.parentToolUseId && !m.stop_reason) {
        let txt: string | undefined
        for (const b of m.content) {
          if (b.type === 'text') {
            const t = (b as TAgentTextBlock).text
            if (t.trim()) txt = t
          }
        }
        return txt
      }
    }
    return undefined
  })()

  // full：仅未完成工具时 hold streamingText 在过程区；否则走回答壳。
  // concise：live 流式正文一律写入 process text（timeline narrative）。
  const hasIncompleteTools = !areToolsBeforeIndexCompleted(
    blockList,
    blockList.length,
    completedIds,
  )
  const holdStreamInProcess = isConcise
    ? Boolean(isActive && streamText)
    : isActive && hasProcessBlock && !splitAnswer && hasIncompleteTools
  if (holdStreamInProcess && streamText) {
    const lastTextIdx = (() => {
      for (let i = process.length - 1; i >= 0; i--) {
        if (process[i]?.type === 'text') return i
      }
      return -1
    })()
    if (lastTextIdx >= 0) {
      const last = process[lastTextIdx] as Extract<ProcessEntry, { type: 'text' }>
      if (
        !last.text.trim() ||
        streamText.startsWith(last.text.trim()) ||
        last.text.trim().startsWith(streamText) ||
        last.key === 'stream-text'
      ) {
        process[lastTextIdx] = { type: 'text', key: last.key, text: streamText }
      } else if (
        // concise+live 同段续写：last 是当前 partial 的 text 块，streamText 是其后的增量。
        // 拼成「partial 文本 + 增量」单一源，避免 pushNarrative 把两条目拼成 `a\n\nb` 抽搐。
        // 仅当 last 文本与当前流式 partial 的 text 块一致时才拼（跨段 final 文本不拼）。
        isConcise &&
        isActive &&
        lastStreamingPartialText &&
        last.text.trim() === lastStreamingPartialText.trim()
      ) {
        process[lastTextIdx] = { type: 'text', key: last.key, text: last.text + streamText }
      } else {
        process.push({ type: 'text', key: 'stream-text', text: streamText })
      }
    } else {
      process.push({ type: 'text', key: 'stream-text', text: streamText })
    }
  }

  // 回答区用 useSmoothStream 逐字挤出。AssistantTurnView 用 resolveAnswerContent 合并
  // answerFull / streamingText（取更长前缀），避免「落盘短于流式」时 content 回缩导致重复字。
  const finalAnswers = answerJoined ? [answerJoined] : []

  // 过程区 text 若与回答同源（前缀/相同），去掉，避免过程+回答双显「重复字」
  const answerOverlay = (() => {
    if (holdStreamInProcess) return '' // 流式正文故意在过程区，不剥
    if (streamText && answerJoined) {
      if (streamText.startsWith(answerJoined) || answerJoined.startsWith(streamText)) {
        return streamText.length >= answerJoined.length ? streamText : answerJoined
      }
      return streamText
    }
    return streamText || answerJoined
  })()
  if (answerOverlay) {
    for (let i = process.length - 1; i >= 0; i--) {
      const p = process[i]
      if (p?.type !== 'text') continue
      const t = p.text.trim()
      if (!t) continue
      // 只去「前缀/相同」的重复（流式段落续写），不用 includes 误伤工具间隙的独立中间文段
      if (t === answerOverlay || answerOverlay.startsWith(t)) {
        process.splice(i, 1)
      }
    }
  }

  // stream 已被完整 answer 覆盖时不再回传 stream（防 content 在两者间抖动）
  // holdStreamInProcess / concise 时也不回传——回答区或 timeline 从 process 读
  const keepStream =
    !isConcise &&
    !holdStreamInProcess &&
    streamText.length > 0 &&
    !(answerJoined && (answerJoined === streamText || answerJoined.startsWith(streamText)))

  annotateThinkingDurations(process)

  return {
    modelId,
    process,
    answerTexts: isConcise ? [] : finalAnswers,
    isStreaming: isConcise
      ? false
      : isStreaming && !answerJoined && !holdStreamInProcess,
    streamingText: keepStream ? streamText : undefined,
    // 思考已进 process，回答区不再单独带 streamingThinking
    streamingThinking: undefined,
  }
}

/**
 * 为每段 thinking 标注 durationSec：
 * 1) 墙钟：本段 at → 下一条 **更大** at 的差（ms→秒）。中间若已夹 tool，
 *    间隔含工具回合耗时，不能当思考时长（旧逻辑会把「探索 2 文件」的 50s 算进思考）。
 * 2) 否则按正文长度粗估（同消息多块无时间差时的兜底）。
 */
export function annotateThinkingDurations(process: ProcessEntry[]): void {
  for (let i = 0; i < process.length; i++) {
    const cur = process[i]!
    if (cur.type !== 'thinking') continue
    let measured: number | undefined
    if (cur.at != null) {
      let sawTool = false
      for (let j = i + 1; j < process.length; j++) {
        const next = process[j]!
        if (next.type === 'tool') sawTool = true
        if (next.at == null || next.at <= cur.at) continue
        // 跨到更晚时间戳；中间夹过 tool 则放弃墙钟（那是工具+等待，不是思考）
        if (!sawTool) {
          measured = Math.max(1, Math.round((next.at - cur.at) / 1000))
        }
        break
      }
    }
    cur.durationSec = resolveThinkingDurationSec(cur.thinking, measured)
  }
}

/** 运行中注入的用户引导：可见，但不能切断当前 assistant-turn。 */
export function isSteerUserMessage(message: TAgentUserMessage): boolean {
  return message.isSteer === true
}

/**
 * 过程条目的时间戳只适合做近似值；思考段的**总和**不得超过整轮实际运行时长。
 * 这同时防御 UI 节点复用或迟到消息造成的阶段时长穿透到下一轮。
 */
export function capThinkingDurationsToTurn(
  process: ProcessEntry[],
  totalDurationMs: number | undefined,
): void {
  if (totalDurationMs == null || !Number.isFinite(totalDurationMs) || totalDurationMs < 0) return
  const maxSec = Math.max(0, Math.floor(totalDurationMs / 1000))
  let remainingSec = maxSec
  for (const entry of process) {
    if (entry.type !== 'thinking' || entry.durationSec == null) continue
    entry.durationSec = Math.min(entry.durationSec, remainingSec)
    remainingSec -= entry.durationSec
  }
}

/**
 * 规范化「秒」时长：防御把 ms 误当秒传入（如 52000 → 52s）。
 * 思考展示很少超过 15 分钟；大于 900 的整数按 ms 再换算。
 */
export function normalizeThinkingDurationSec(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  if (raw > 900) return Math.max(1, Math.min(180, Math.round(raw / 1000)))
  return Math.max(1, Math.min(180, Math.round(raw)))
}

/** 有实测用实测；否则按长度粗估；极短仍 undefined → UI「思考了片刻」 */
export function resolveThinkingDurationSec(
  thinking: string,
  measuredSec?: number,
): number | undefined {
  if (measuredSec != null && measuredSec > 0) {
    return normalizeThinkingDurationSec(measuredSec)
  }
  const len = thinking.trim().length
  if (len < 24) return undefined
  // ~200 字/秒：贴近 LLM 流式吞吐。旧 45 字/秒会把几秒的长 CoT 估成「几十秒」（观感像把 ms 当秒）。
  return Math.max(1, Math.min(180, Math.round(len / 200)))
}

/** 折叠文案：对齐 Cursor「Thought briefly / Thought for 46s」→ 思考了片刻 / 思考了 46s
 *  < 3s 一律「思考了片刻」（避免满屏「思考了 1s」）；live 文案不变。 */
export function formatThinkingSummary(
  durationSec: number | undefined,
  opts?: { live?: boolean; liveElapsedSec?: number },
): string {
  if (opts?.live) {
    const n = opts.liveElapsedSec
    if (n != null && n >= 1) return `思考中 ${formatElapsedDuration(n * 1000)}`
    return '正在思考…'
  }
  if (durationSec != null && durationSec >= 3) return `思考了 ${formatElapsedDuration(durationSec * 1000)}`
  return '思考了片刻'
}

/** 去掉完全相同或被更长段「前缀」包含的重复（流式分段落盘常见）。
 *  不用 includes/任意子串匹配：语义独立的中间文段（如 "Let me check"）可能是
 *  最终回答 "After I check, …" 的子串，误删会导致回答不完整。 */
export function dedupeAnswerTexts(texts: string[]): string[] {
  const cleaned = texts.map((t) => t.trim()).filter(Boolean)
  if (cleaned.length <= 1) return cleaned

  const result: string[] = []
  for (const t of cleaned) {
    // 若已被已有文本以「前缀」包含，跳过
    if (result.some((r) => r === t || r.startsWith(t))) continue
    // 若当前更长且以某条旧的为前缀，替换掉旧的
    for (let i = result.length - 1; i >= 0; i--) {
      if (t.startsWith(result[i]!) && t !== result[i]) {
        result.splice(i, 1)
      }
    }
    result.push(t)
  }
  return result
}

function getTrailingTextStart(blocks: TAgentContentBlock[]): number | null {
  if (blocks.length === 0) return null
  if (blocks[blocks.length - 1]?.type !== 'text') return null
  let i = blocks.length - 1
  while (i > 0 && blocks[i - 1]?.type === 'text') i -= 1
  return i
}

export function summarizeProcess(process: ProcessEntry[]): {
  toolCount: number
  thinkingCount: number
  toolNames: string[]
  label: string
} {
  let toolCount = 0
  let thinkingCount = 0
  const toolNames: string[] = []
  const seen = new Set<string>()
  for (const p of process) {
    if (p.type === 'tool') {
      toolCount += 1
      if (!seen.has(p.tool.name)) {
        seen.add(p.tool.name)
        toolNames.push(p.tool.name)
      }
    } else if (p.type === 'thinking') {
      thinkingCount += 1
    }
  }
  const parts: string[] = []
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (thinkingCount > 0) parts.push(`${thinkingCount} 段思考`)
  return {
    toolCount,
    thinkingCount,
    toolNames,
    label: parts.length > 0 ? `执行过程：${parts.join('，')}` : '执行过程',
  }
}
