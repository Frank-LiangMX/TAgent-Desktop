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

/** 用户消息是否为「真实输入」（有非空 text） */
export function isRealUserInput(message: TAgentUserMessage): boolean {
  return message.content.some(
    (b) => b.type === 'text' && typeof (b as TAgentTextBlock).text === 'string' && (b as TAgentTextBlock).text.trim().length > 0,
  )
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
    // 压缩 / 任务卡：时间线独立占位
    if (item.taskCard || item.compactStatus) {
      flush()
      turns.push({ kind: 'standalone', key: item.key, item })
      continue
    }

    const msg = item.message

    if (msg?.type === 'user') {
      if (isRealUserInput(msg)) {
        flush()
        turns.push({ kind: 'user', key: item.key, message: msg })
      } else if (isToolResultOnlyUser(msg)) {
        // tool_result → 归入当前 assistant-turn
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

    if (msg?.type === 'assistant' || item.streaming || item.streamingText || item.streamingThinking) {
      if (!current) {
        current = {
          kind: 'assistant-turn',
          key: `turn-${item.key}`,
          items: [item],
          modelId: msg?.type === 'assistant' ? msg.modelId : undefined,
          isStreaming: Boolean(item.streaming),
        }
      } else {
        current.items.push(item)
        if (item.streaming) current.isStreaming = true
        if (!current.modelId && msg?.type === 'assistant' && msg.modelId) {
          current.modelId = msg.modelId
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

/** 从 turn 源 items 构建展示：过程组 + 最终回答 + 流式 */
export function buildTurnPresentation(turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }>): TurnPresentation {
  const process: ProcessEntry[] = []
  const answerTexts: string[] = []
  const resultById = new Map<string, TAgentToolResultBlock>()
  let streamingText: string | undefined
  let streamingThinking: string | undefined
  let isStreaming = turn.isStreaming
  let modelId = turn.modelId

  // 先收集 tool_result；流式文本只取「仍在 streaming 的占位项」的最新一份（勿拼接多份）
  for (const item of turn.items) {
    if (item.message?.type === 'user') {
      for (const b of item.message.content) {
        if (b.type === 'tool_result') {
          const rb = b as TAgentToolResultBlock
          resultById.set(rb.toolUseId, rb)
        }
      }
    }
    if (item.streaming) {
      isStreaming = true
      // 覆盖式取最新，禁止 += 把同一占位或残留占位拼成双份
      if (item.streamingText != null) streamingText = item.streamingText
      if (item.streamingThinking != null) streamingThinking = item.streamingThinking
    }
    // 落盘升级项（sdk_message 就地升级）已清 streamingText，不再收集——
    // 打字机续接靠 useSmoothStream 内部 prevContentRef，保留旧 streamingText 会导致多轮残留/重复文字。
    if (!modelId && item.message?.type === 'assistant') {
      modelId = item.message.modelId
    }
  }

  // 按顺序收集主线 assistant 内容块（子代理 parentToolUseId 不进主过程组）
  // pi 内核 toolcall_end 与 turn_end 都产含 tool_use 的 assistant（同 id），需按 tool_use id 去重，
  // 否则每个工具步骤显示两遍。去重策略：同 id 的 tool_use 只保留一条；优先保留来自「含 thinking/text
  // 的完整消息」的那条（turn_end 产），丢弃 toolcall_end 的纯 tool_use 占位（modelId 通常为空）。
  const allBlocks: Array<{ block: TAgentContentBlock; key: string }> = []
  const toolUseSeen = new Map<string, { block: TAgentToolUseBlock; key: string; rich: boolean }>()
  for (const item of turn.items) {
    if (item.message?.type !== 'assistant') continue
    if (item.message.parentToolUseId) continue
    const rich = item.message.content.some((b) => b.type === 'thinking' || b.type === 'text')
    item.message.content.forEach((block, i) => {
      if (block.type === 'tool_use') {
        const tu = block as TAgentToolUseBlock
        const prev = toolUseSeen.get(tu.id)
        if (prev) {
          // 已有同 id：若当前消息更完整（rich）且旧的只是占位，替换；否则丢弃当前
          if (rich && !prev.rich) {
            const idx = allBlocks.findIndex((x) => x.key === prev.key)
            if (idx >= 0) allBlocks[idx] = { block, key: `${item.key}-b${i}` }
            toolUseSeen.set(tu.id, { block: tu, key: `${item.key}-b${i}`, rich })
          }
          return
        }
        const key = `${item.key}-b${i}`
        toolUseSeen.set(tu.id, { block: tu, key, rich })
        allBlocks.push({ block, key })
      } else {
        allBlocks.push({ block, key: `${item.key}-b${i}` })
      }
    })
  }

  // 末尾连续 text 作为交付回答（流式中若仍有未完成工具，暂全部进过程）
  const trailingTextStart = getTrailingTextStart(allBlocks.map((x) => x.block))
  const hasOpenTools = allBlocks.some(
    ({ block }) =>
      block.type === 'tool_use' &&
      !resultById.has((block as TAgentToolUseBlock).id),
  )
  const splitAnswer =
    trailingTextStart !== null &&
    trailingTextStart > 0 &&
    (!isStreaming || !hasOpenTools)

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

  // 流式 thinking 并入过程区（不在回答区再开一块「思考了几秒」）
  if (isStreaming && streamingThinking?.trim()) {
    const already = process.some(
      (p) => p.type === 'thinking' && p.thinking.trim() === streamingThinking.trim(),
    )
    if (!already) {
      process.push({
        type: 'thinking',
        key: 'stream-thinking',
        thinking: streamingThinking,
      })
    }
  }

  // 回答区用 useSmoothStream 逐字挤出（AssistantTurnView 喂 content=answerFull ?? streamingText，
  // 单条时间线单调追加）。pi-ai done.message === delta 拼接 / kscc includePartialMessages 同源前缀，
  // 故落盘 answerFull 必以 streamingText 为前缀 → useSmoothStream isAppend 成立，从已显示进度逐字
  // 追到完整正文，不 purge 重建、不跳变。
  // 落盘后保留 streamingText：让 needsTypewriter 仍为 true，useSmoothStream 继续逐字追完（流式
  // 已停 → streamDone → /4 加速排空，但不一次性 dump）。
  const streamText = streamingText?.trim() ?? ''
  const finalAnswers = answerJoined ? [answerJoined] : []

  return {
    modelId,
    process,
    answerTexts: finalAnswers,
    isStreaming: isStreaming && !answerJoined,
    // 落盘后仍保留 streamingText：AssistantTurnView 的 needsTypewriter = isStreaming || streamingText，
    // 保留它使打字机在落盘后继续追完；content 由 answerFull 优先（answerTexts[0]）。
    streamingText: streamText.length > 0 ? streamText : undefined,
    // 思考已进 process，回答区不再单独带 streamingThinking
    streamingThinking: undefined,
  }
}

/** 去掉完全相同或被更长段包含的前缀重复（流式分段落盘常见） */
export function dedupeAnswerTexts(texts: string[]): string[] {
  const cleaned = texts.map((t) => t.trim()).filter(Boolean)
  if (cleaned.length <= 1) return cleaned

  const result: string[] = []
  for (const t of cleaned) {
    // 若已被已有更长文本包含，跳过
    if (result.some((r) => r === t || r.includes(t))) continue
    // 若当前更长且包含某条旧的，替换掉旧的
    for (let i = result.length - 1; i >= 0; i--) {
      if (t.includes(result[i]!) && t !== result[i]) {
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
