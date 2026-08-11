/**
 * REGRESS-G 回归（Vitest）— GLM 独立块 assistant 回合结束后「正文为空壳」
 *
 * 规格：docs/dev/core-loop/REGRESS-G-FINDINGS.md
 * 现象：打包版 GLM-5.2 最新两轮 assistant 只显示模型头 + 耗时，正文为空；重开会话才恢复。
 *
 * 根因链路（已确认）：
 * 1. GLM 把每个 content 块拆成**独立 uuid** 的 assistant 消息，`stop_reason` 始终 null（end_turn 只在 result）。
 * 2. kscc-message-adapter 用 `stopReason==null` 推断 `_partial:true` → GLM 每块恒 partial。
 * 3. session-service handleSdkStreamMessage 对 partial assistant 调 stripPartialAssistantBody，
 *    正文（text/thinking）被剥空后发给 renderer；live 正文只活在 streamState（派生/原生 delta 累积）。
 * 4. 回合边界（result/turn_end）：思考缓冲已被 commitStreamThinkingToLastAssistant 写回末条 assistant，
 *    但**正文**没有对称提交 → resetStreamState 直接丢弃 streamState.text。
 * 5. GLM 不发非 partial 终态快照（无 stop_reason assistant）来校准 item → 回合结束后 item 只剩空壳。
 *    重开会话读 JSONL（落盘走原始全量 msg，未经剥离）→ 正文恢复。
 *
 * 修复（最小、自识别）：在 result/turn_end 边界把 streamState.text 写回末条主线 assistant
 * （commitStreamTextToLastAssistant，与思考提交对称）。
 * - GLM：streamState.text 非空 → 写回 item → 回合结束后保留正文。
 * - 累计快照（Claude/Pi）：final（带 stop_reason）已清 streamState.text → trim()='' no-op，不重复落字。
 *
 * 本测试用真 reducer（applySdkMessageToItems / applyTextDelta / applySdkMessageToStreamState）
 * 逐帧推进 (items, streamState)，模拟 main 侧「剥离 partial + 派生 delta」链路，跑 buildTurnPresentation，
 * 断言：
 * 1. GLM：live 正文在 streamState；回合边界提交后，末条 assistant 仍带完整正文 + 思考；
 *    buildTurnPresentation（非 live）answerTexts 含完整正文（不再空壳）。
 * 2. Claude 累计快照：final 校准后 item 已带完整正文，streamState.text 已清 → 边界提交 no-op，
 *    不产生重复 text 块（不回归 E/S1 累计快照流）。
 */
import { describe, expect, it } from 'vitest'
import { buildTurnPresentation } from './session-turn-model'
import {
  applySdkMessageToItems,
  applyTextDelta,
  applyThinkingDeltaToState,
  applySdkMessageToStreamState,
  EMPTY_STREAM_STATE,
  commitStreamTextToLastAssistant,
  commitStreamThinkingToLastAssistant,
  type SessionStreamState,
} from './stream-item-model'
import type { TAgentMessage } from '@tagent/shared'

interface Item {
  key: string
  message?: TAgentMessage
  streamUuid?: string
  streaming?: boolean
  streamingText?: string
  streamingThinking?: string
}

let keySeq = 0
const allocKey = (): string => `m${keySeq++}`

/**
 * GLM 独立块：独立 uuid、stop_reason 始终 null、_partial:true。
 * main 侧 stripPartialAssistantBody 把正文主体剥空（text/thinking → ''），仅留块结构。
 * 此处模拟「发给 renderer 的剥离后 IR」。
 */
function glmStrippedBlock(
  uuid: string,
  block: TAgentMessage['content'][number],
): TAgentMessage {
  const stripped =
    block.type === 'text'
      ? { type: 'text' as const, text: '' }
      : block.type === 'thinking'
        ? { type: 'thinking' as const, thinking: '' }
        : block
  return { type: 'assistant', uuid, _partial: true, createdAt: 1, content: [stripped] } as TAgentMessage
}

/** 累计快照 partial（Claude/Pi）：同 uuid、content 累计增长、_partial:true、无 stop_reason。 */
function partialSnapshot(
  uuid: string,
  content: TAgentMessage['content'],
): TAgentMessage {
  return { type: 'assistant', uuid, _partial: true, createdAt: 1, content } as TAgentMessage
}

/** 累计快照 final（Claude/Pi）：同 uuid、完整 content、带 stop_reason、无 _partial（不剥离）。 */
function finalSnapshot(
  uuid: string,
  content: TAgentMessage['content'],
  stopReason: string,
): TAgentMessage {
  return { type: 'assistant', uuid, stop_reason: stopReason, createdAt: 1, content } as TAgentMessage
}

/** 模拟 main 侧 handleSdkStreamMessage 对一条 assistant 的处理：发派生 delta + 剥离后 sdk_message。 */
function feedAssistantBlock(
  items: Item[],
  stream: SessionStreamState,
  uuid: string,
  fullBlock: TAgentMessage['content'][number],
  isFinal = false,
): { items: Item[]; stream: SessionStreamState; deltaText: string; deltaThinking: string } {
  // 派生 delta：从全量 block 取正文（main 用 extractBlockSnapshot 比对前帧；此处单块首帧 = 全量 append）
  const deltaText = fullBlock.type === 'text' ? (fullBlock as { text: string }).text : ''
  const deltaThinking = fullBlock.type === 'thinking' ? (fullBlock as { thinking: string }).thinking : ''
  let s = stream
  if (deltaText) s = applyTextDelta(s, deltaText)
  if (deltaThinking) s = applyThinkingDeltaToState(s, deltaThinking)
  // 发给 renderer 的 sdk_message：partial 剥离主体；final 不剥离
  const irMessage = isFinal
    ? finalSnapshot(uuid, [fullBlock] as TAgentMessage['content'], 'end_turn')
    : glmStrippedBlock(uuid, fullBlock)
  const nextItems = applySdkMessageToItems(items, irMessage, allocKey) as Item[]
  s = applySdkMessageToStreamState(s, irMessage)
  return { items: nextItems, stream: s, deltaText, deltaThinking }
}

/** 回合边界提交（对称 Chat.tsx result/turn_end：先思考再正文，再 resetStreamState）。 */
function commitBoundary(
  items: Item[],
  stream: SessionStreamState,
): { items: Item[]; stream: SessionStreamState } {
  const pendingThink = stream.thinking.trim()
  let nextItems = items
  if (pendingThink) nextItems = commitStreamThinkingToLastAssistant(nextItems, pendingThink) as Item[]
  const pendingText = stream.text.trim()
  if (pendingText) nextItems = commitStreamTextToLastAssistant(nextItems, pendingText) as Item[]
  return { items: nextItems, stream: { ...EMPTY_STREAM_STATE } }
}

/** 取末条主线 assistant 的 content。 */
function lastMainAssistantContent(items: Item[]): TAgentMessage['content'] {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]?.message
    if (m?.type === 'assistant' && !m.parentToolUseId) return m.content
  }
  throw new Error('无主线 assistant')
}

describe('REGRESS-G：GLM 独立块（独立 uuid + stop_reason:null）回合结束后保留正文', () => {
  it('live：正文活在 streamState（buildTurnPresentation.streamingText = 完整正文）', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // GLM 三块：text '你好' → thinking '想一下' → text ' 世界'
    const r1 = feedAssistantBlock(items, stream, 'glm-A', { type: 'text', text: '你好' })
    items = r1.items; stream = r1.stream
    const r2 = feedAssistantBlock(items, stream, 'glm-B', { type: 'thinking', thinking: '想一下' })
    items = r2.items; stream = r2.stream
    const r3 = feedAssistantBlock(items, stream, 'glm-C', { type: 'text', text: ' 世界' })
    items = r3.items; stream = r3.stream

    // live：streamState 累积完整正文 + 思考
    expect(stream.text).toBe('你好 世界')
    expect(stream.thinking).toBe('想一下')

    // buildTurnPresentation（live）把 streamState 投成 streamingText → 正文可见（不被剥空）
    const pres = buildTurnPresentation(
      { kind: 'assistant-turn', key: 't', items, isStreaming: true },
      { isLiveTurn: true, streamState: stream, displayMode: 'full' },
    )
    expect(pres.streamingText?.trim()).toBe('你好 世界')
  })

  it('回合边界提交后：末条 assistant 带完整正文 + 思考；非 live answerTexts 含完整正文（不再空壳）', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    const r1 = feedAssistantBlock(items, stream, 'glm-A', { type: 'text', text: '你好' })
    items = r1.items; stream = r1.stream
    const r2 = feedAssistantBlock(items, stream, 'glm-B', { type: 'thinking', thinking: '想一下' })
    items = r2.items; stream = r2.stream
    const r3 = feedAssistantBlock(items, stream, 'glm-C', { type: 'text', text: ' 世界' })
    items = r3.items; stream = r3.stream

    // 边界提交（result/turn_end）→ resetStreamState
    const committed = commitBoundary(items, stream)
    items = committed.items; stream = committed.stream

    // streamState 已清（回合结束）
    expect(stream.text).toBe('')
    expect(stream.thinking).toBe('')

    // 末条主线 assistant 仍带完整正文 + 思考（不再只剩空壳）
    const content = lastMainAssistantContent(items)
    const textJoined = content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim()
    const thinkingJoined = content
      .filter((b) => b.type === 'thinking')
      .map((b) => (b as { thinking: string }).thinking)
      .join('')
      .trim()
    expect(textJoined).toBe('你好 世界')
    expect(thinkingJoined).toBe('想一下')

    // buildTurnPresentation（非 live）answerTexts 含完整正文 → 回答壳显示，不再是空壳
    const pres = buildTurnPresentation(
      { kind: 'assistant-turn', key: 't', items, isStreaming: false },
      { isLiveTurn: false, displayMode: 'full' },
    )
    expect(pres.answerTexts.join('\n\n').trim()).toBe('你好 世界')
  })

  it('GLM 带 tool_use 的回合：边界提交把段间正文写入 tool_use 前，过程区可见', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // 段间正文 → tool_use（GLM 各自独立 uuid）
    const r1 = feedAssistantBlock(items, stream, 'glm-T', { type: 'text', text: '先摸清目录' })
    items = r1.items; stream = r1.stream
    const r2 = feedAssistantBlock(items, stream, 'glm-Tool', {
      type: 'tool_use',
      id: 'tu-1',
      name: 'Read',
      input: { file_path: 'a.ts' },
    } as never)
    items = r2.items; stream = r2.stream

    const committed = commitBoundary(items, stream)
    items = committed.items; stream = committed.stream

    const content = lastMainAssistantContent(items)
    // 正文块插到 tool_use 前（commitStreamTextToLastAssistant 语义）
    const toolIdx = content.findIndex((b) => b.type === 'tool_use')
    expect(toolIdx).toBeGreaterThan(0)
    const beforeTool = content.slice(0, toolIdx)
    const textBefore = beforeTool
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim()
    expect(textBefore).toBe('先摸清目录')
  })
})

describe('REGRESS-G 不回归：累计快照（Claude/Pi）final 校准 + 边界提交 no-op', () => {
  it('Claude 累计快照：partial 增长（剥离）→ final（带 stop_reason，不剥离）校准 item；边界提交不重复落字', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // 帧 1：partial 100（main 剥离主体 → renderer 收 text=''；派生 delta 'a'*100 累积 streamState）
    stream = applyTextDelta(stream, 'a'.repeat(100))
    items = applySdkMessageToItems(
      items,
      glmStrippedBlock('claude-A', { type: 'text', text: 'a'.repeat(100) }),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(
      stream,
      glmStrippedBlock('claude-A', { type: 'text', text: 'a'.repeat(100) }),
    )
    expect(stream.text).toBe('a'.repeat(100))

    // 帧 2：同 uuid 累计 200（剥离主体；派生 suffix delta 'a'*100）
    stream = applyTextDelta(stream, 'a'.repeat(100))
    items = applySdkMessageToItems(
      items,
      glmStrippedBlock('claude-A', { type: 'text', text: 'a'.repeat(200) }),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(
      stream,
      glmStrippedBlock('claude-A', { type: 'text', text: 'a'.repeat(200) }),
    )
    expect(stream.text).toBe('a'.repeat(200))

    // final：同 uuid、带 stop_reason、不剥离 → item 校准为完整正文 + streamState.text 被清
    items = applySdkMessageToItems(
      items,
      finalSnapshot('claude-A', [{ type: 'text', text: 'a'.repeat(200) }], 'end_turn'),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(
      stream,
      finalSnapshot('claude-A', [{ type: 'text', text: 'a'.repeat(200) }], 'end_turn'),
    )
    // final 的 stop_reason → applySdkMessageToStreamState 清 streamState.text
    expect(stream.text).toBe('')

    // 边界提交：pendingText='' → no-op
    const committed = commitBoundary(items, stream)
    items = committed.items; stream = committed.stream

    const content = lastMainAssistantContent(items)
    const textBlocks = content.filter((b) => b.type === 'text') as Array<{ text: string }>
    // 仅一个非空 text 块（final 校准的完整正文，未因边界提交再插一份）
    const nonEmpty = textBlocks.filter((b) => b.text.trim().length > 0)
    expect(nonEmpty).toHaveLength(1)
    expect(nonEmpty[0]!.text).toBe('a'.repeat(200))

    // buildTurnPresentation（非 live）answerTexts = 完整正文（不重复）
    const pres = buildTurnPresentation(
      { kind: 'assistant-turn', key: 't', items, isStreaming: false },
      { isLiveTurn: false, displayMode: 'full' },
    )
    expect(pres.answerTexts.join('\n\n').trim()).toBe('a'.repeat(200))
  })

  it('Claude 累计快照：live 期间正文在 streamState；final 校准后切换为 message 真源（handoff）', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    const r1 = feedAssistantBlock(items, stream, 'claude-B', { type: 'text', text: '正在' })
    items = r1.items; stream = r1.stream
    stream = applyTextDelta(stream, '摸清')
    // final 校准
    const rFinal = feedAssistantBlock(
      items,
      stream,
      'claude-B',
      { type: 'text', text: '正在摸清' },
      true,
    )
    items = rFinal.items; stream = rFinal.stream

    expect(stream.text).toBe('')
    const content = lastMainAssistantContent(items)
    expect((content[0] as { text: string }).text).toBe('正在摸清')
  })
})
