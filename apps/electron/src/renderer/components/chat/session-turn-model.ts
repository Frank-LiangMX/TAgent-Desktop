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
} from '@tagent/shared'

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
  | { type: 'thinking'; thinking: string; key: string }
  | {
      type: 'tool'
      key: string
      tool: TAgentToolUseBlock
      result?: TAgentToolResultBlock
    }
  | { type: 'text'; text: string; key: string }

export interface TurnPresentation {
  modelId?: string
  process: ProcessEntry[]
  /** 交付给用户的最终文本（turn 末尾连续 text） */
  answerTexts: string[]
  isStreaming: boolean
  streamingText?: string
  streamingThinking?: string
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
 * 主会话应展示的子代理入口 id 列表（保序、去重）。
 *
 * 来源：
 * 1. 主线 tool_use（Agent / task / Task）—— 一点就出卡，不必等子代理回消息
 * 2. 带 parentToolUseId 的子代理 assistant（无 launcher 时的兜底）
 * 3. taskCard.toolUseId（runtime 生命周期事件）
 */
export function listSubagentEntryIds(items: TurnSourceItem[]): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const push = (id: string | null | undefined): void => {
    if (!id || seen.has(id)) return
    seen.add(id)
    order.push(id)
  }

  for (const it of items) {
    const m = it.message
    if (m?.type === 'assistant' && !m.parentToolUseId) {
      for (const b of m.content) {
        if (b.type !== 'tool_use') continue
        const tu = b as TAgentToolUseBlock
        if (isSubagentLauncherTool(tu.name)) push(tu.id)
      }
    }
    if (m?.type === 'assistant' && m.parentToolUseId) {
      push(m.parentToolUseId)
    }
    const card = it.taskCard as { toolUseId?: string } | undefined
    if (card?.toolUseId) push(card.toolUseId)
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
        if (tu.id === parentToolUseId) {
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
 * 真实用户输入由主进程构造时 parentToolUseId 恒为 null。 */
export function isRealUserInput(message: TAgentUserMessage): boolean {
  if (message.parentToolUseId) return false
  return message.content.some(
    (b) => b.type === 'text' && typeof (b as TAgentTextBlock).text === 'string' && (b as TAgentTextBlock).text.trim().length > 0,
  )
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
      if (isRealUserInput(msg)) {
        flush()
        turns.push({ kind: 'user', key: item.key, message: msg })
      } else if (isToolResultOnlyUser(msg) || msg.parentToolUseId) {
        // tool_result 回传 / 子代理委派消息（合成 user，text+parentToolUseId）→ 归入当前 assistant-turn。
        // 委派消息绝不渲染为独立用户气泡（主进程构造的真实用户输入 parentToolUseId 恒为 null）。
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
 * 从 turn 源 items 构建展示：过程组 + 最终回答 + 流式
 *
 * @param options.isLiveTurn 整轮仍在跑（含工具间隙）。为 true 时不把末尾 text 拆进回答区，
 *   避免「过程区出现一段字 → 下一拍抽到回答区」的跳变。
 */
export function buildTurnPresentation(
  turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }>,
  options?: { isLiveTurn?: boolean },
): TurnPresentation {
  const process: ProcessEntry[] = []
  const answerTexts: string[] = []
  const resultById = new Map<string, TAgentToolResultBlock>()
  let streamingText: string | undefined
  let streamingThinking: string | undefined
  let isStreaming = turn.isStreaming
  let modelId = turn.modelId
  const isLiveTurn = options?.isLiveTurn === true

  // 先收集 tool_result；流式文本只取「仍在 streaming 的占位项」的最新一份（勿拼接多份）
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

  // 按顺序收集主线 assistant 内容块（子代理 parentToolUseId 不进主过程组）
  // Agent/task launcher 也不进过程组——改由 SubagentEntryCard 独占展示。
  // pi 内核 toolcall_end 与 turn_end 都产含 tool_use 的 assistant（同 id），需按 tool_use id 去重。
  // **稳定 key**：tool 用 `tool-${id}`、thinking 用出现序 `think-${n}`，禁止绑 item.key——
  // 占位 item 升级/替换时 item.key 变会导致 React 整行 remount → 过程区跳变。
  const allBlocks: Array<{ block: TAgentContentBlock; key: string }> = []
  const toolUseSeen = new Map<string, { block: TAgentToolUseBlock; key: string; rich: boolean }>()
  let thinkingSeq = 0
  let textSeq = 0
  for (const item of turn.items) {
    if (item.message?.type !== 'assistant') continue
    if (item.message.parentToolUseId) continue
    const rich = item.message.content.some((b) => b.type === 'thinking' || b.type === 'text')
    item.message.content.forEach((block) => {
      if (block.type === 'tool_use') {
        const tu = block as TAgentToolUseBlock
        // 子代理入口：过程区完全不渲染（含超长 tool_result）
        if (isSubagentLauncherTool(tu.name)) return
        const stableKey = `tool-${tu.id}`
        const prev = toolUseSeen.get(tu.id)
        if (prev) {
          // 已有同 id：若当前消息更完整（rich）且旧的只是占位，替换内容但**保留稳定 key**
          if (rich && !prev.rich) {
            const idx = allBlocks.findIndex((x) => x.key === prev.key)
            if (idx >= 0) allBlocks[idx] = { block, key: prev.key }
            toolUseSeen.set(tu.id, { block: tu, key: prev.key, rich })
          }
          return
        }
        toolUseSeen.set(tu.id, { block: tu, key: stableKey, rich })
        allBlocks.push({ block, key: stableKey })
      } else if (block.type === 'thinking') {
        allBlocks.push({ block, key: `think-${thinkingSeq++}` })
      } else if (block.type === 'text') {
        allBlocks.push({ block, key: `text-${textSeq++}` })
      } else {
        allBlocks.push({ block, key: `blk-${allBlocks.length}` })
      }
    })
  }

  // 末尾连续 text 作为交付回答。
  //
  // 运行中同样要拆。曾经用 !isLiveTurn 一刀切留在过程区，代价是：正文落盘那一刻
  // streamingText 被清空、回答区瞬间变空，同一段文字改以 80 字截断的灰字出现在
  // 过程区，并被后续条目顶走——整轮跑完才排版出 Markdown。
  //
  // 「说一句再调工具」的中间文案由 hasOpenTools 兜住：工具还没回结果就说明本段
  // 不是交付，文字留在过程区；工具全部有结果后的尾部文字才是回答。
  const trailingTextStart = getTrailingTextStart(allBlocks.map((x) => x.block))
  const hasOpenTools = allBlocks.some(
    ({ block }) =>
      block.type === 'tool_use' &&
      !resultById.has((block as TAgentToolUseBlock).id),
  )
  const splitAnswer =
    trailingTextStart !== null && trailingTextStart > 0 && !hasOpenTools

  const processEnd = splitAnswer ? trailingTextStart! : allBlocks.length

  for (let i = 0; i < processEnd; i++) {
    const { block, key } = allBlocks[i]!
    if (block.type === 'thinking') {
      process.push({
        type: 'thinking',
        key,
        thinking: (block as TAgentThinkingBlock).thinking,
      })
    } else if (block.type === 'tool_use') {
      const tool = block as TAgentToolUseBlock
      process.push({
        type: 'tool',
        key,
        tool,
        result: resultById.get(tool.id),
      })
    } else if (block.type === 'text') {
      const text = (block as TAgentTextBlock).text
      if (text.trim()) process.push({ type: 'text', key, text })
    }
  }

  if (splitAnswer && trailingTextStart !== null) {
    for (let i = trailingTextStart; i < allBlocks.length; i++) {
      const { block } = allBlocks[i]!
      if (block.type === 'text') {
        const text = (block as TAgentTextBlock).text
        if (text.trim()) answerTexts.push(text)
      }
    }
  }

  // 纯过程 turn 且无 answer：若全部是 text 且无工具，当回答
  if (answerTexts.length === 0 && process.length > 0 && !process.some((p) => p.type === 'tool' || p.type === 'thinking')) {
    for (const p of process) {
      if (p.type === 'text') answerTexts.push(p.text)
    }
    process.length = 0
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

  // 回答区用 useSmoothStream 逐字挤出。AssistantTurnView 用 resolveAnswerContent 合并
  // answerFull / streamingText（取更长前缀），避免「落盘短于流式」时 content 回缩导致重复字。
  // 落盘后若 stream 与 answer 同源，可清 stream，减少双源抖动。
  const streamText = streamingText?.trim() ?? ''
  const finalAnswers = answerJoined ? [answerJoined] : []

  // 过程区 text 若与回答同源（前缀/相同），去掉，避免过程+回答双显「重复字」
  const answerOverlay = (() => {
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
  const keepStream =
    streamText.length > 0 &&
    !(answerJoined && (answerJoined === streamText || answerJoined.startsWith(streamText)))

  return {
    modelId,
    process,
    answerTexts: finalAnswers,
    isStreaming: isStreaming && !answerJoined,
    streamingText: keepStream ? streamText : undefined,
    // 思考已进 process，回答区不再单独带 streamingThinking
    streamingThinking: undefined,
  }
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
