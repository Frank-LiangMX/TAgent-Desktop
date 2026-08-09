/**
 * REGRESS-B 回归（Vitest）— Cursor 式段间 progress 在 live 持续可见
 *
 * 规格：docs/dev/core-loop/REGRESS-2026-08-07-SPEC.md §B
 * 对照：docs/dev/core-loop/REGRESS-B-FINDINGS.md
 *
 * 还原 kscc 真实「双源流式」：partial assistant（content[] 累积，_partial:true，不落盘）
 * + stream_text_delta（streamState 累积，partial 带 text 时被清）。用真 reducer
 * （applySdkMessageToItems / applyTextDelta / applySdkMessageToStreamState）逐帧推进
 * (items, streamState)，再跑 buildTurnPresentation + buildConciseTimeline，断言：
 *
 * 1. 段内：partial 文本 + 增量归一成单一 narrative，逐字增长——不出现 `快照\n\n增量` 抽搐。
 * 2. 跨段：上一段 final 文本不清掉新段 delta——段间 progress 在 live 即可见（不憋到结束）。
 * 3. 工具间 text = progress tone；尾部 text 在 turn 结束后升 final。
 * 4. 历史（isLive=false）打开不重播打字机：narrative 仍按段拆分，尾段 final。
 */
import { describe, expect, it } from 'vitest'
import { buildTurnPresentation } from './session-turn-model'
import { buildConciseTimeline } from './concise-timeline-model'
import {
  applySdkMessageToItems,
  applyTextDelta,
  applySdkMessageToStreamState,
  EMPTY_STREAM_STATE,
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

function assistantPartial(uuid: string, content: TAgentMessage['content']): TAgentMessage {
  return { type: 'assistant', uuid, _partial: true, createdAt: 1, content } as TAgentMessage
}
function assistantFinal(
  uuid: string,
  content: TAgentMessage['content'],
  stopReason: string,
): TAgentMessage {
  return { type: 'assistant', uuid, stop_reason: stopReason, createdAt: 1, content } as TAgentMessage
}
function userToolResult(id: string): TAgentMessage {
  return { type: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'ok' }] }
}

interface Frame {
  items: Item[]
  stream: SessionStreamState
}

function renderConcise(frame: Frame, isLive: boolean): { processTexts: string[]; narratives: { text: string; tone: string }[] } {
  const pres = buildTurnPresentation(
    { kind: 'assistant-turn', key: 't', items: frame.items, isStreaming: true },
    { isLiveTurn: isLive, streamState: isLive ? frame.stream : undefined, displayMode: 'concise' },
  )
  const segs = buildConciseTimeline(pres.process, {
    answerTexts: pres.answerTexts,
    streamingText: pres.streamingText,
    isLive,
  })
  return {
    processTexts: pres.process.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text),
    narratives: segs
      .filter((s) => s.kind === 'narrative')
      .map((s) => ({ text: (s as { text: string }).text, tone: (s as { tone: string }).tone })),
  }
}

/** 推进一帧：发一个 token 的 delta，随后发一条 partial（content[] 含累计文本，末帧带 tool_use）。 */
function* emitSegment(
  items: Item[],
  stream: SessionStreamState,
  uuid: string,
  tokens: string[],
  tool?: { id: string; name: string; input: Record<string, unknown> },
): Generator<{ items: Item[]; stream: SessionStreamState; delta: string }, void, unknown> {
  let acc = ''
  for (let i = 0; i < tokens.length; i++) {
    acc += tokens[i]!
    stream = applyTextDelta(stream, tokens[i]!)
    yield { items: [...items], stream: { ...stream }, delta: tokens[i]! }
    const content: TAgentMessage['content'] = [{ type: 'text', text: acc }]
    if (i === tokens.length - 1 && tool) content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input })
    const partial = assistantPartial(uuid, content)
    items = applySdkMessageToItems(items, partial, allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, partial)
    yield { items: [...items], stream: { ...stream }, delta: tokens[i]! }
  }
}

describe('REGRESS-B：kscc 双源流式，concise live progress 持续可见', () => {
  it('段内 partial+delta 归一为单一 narrative，逐字增长（不抽搐）', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // 思考段 partial（无 text）
    items = applySdkMessageToItems(
      items,
      assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]))

    const seen: string[] = []
    for (const f of emitSegment(items, stream, 'u1', ['正在', '摸清', '目录'], { id: 'r1', name: 'Read', input: { file_path: 'a.ts' } })) {
      const { narratives } = renderConcise({ items: f.items, stream: f.stream }, true)
      // 第一段 progress 文本（思考后、Read 之前）
      const p = narratives.find((n) => n.tone === 'progress')
      if (p) seen.push(p.text)
    }

    // 关键断言：绝不出现 `\n\n`（双条目拼接抽搐）；应是单一逐字增长
    expect(seen.every((t) => !t.includes('\n\n'))).toBe(true)
    // 末帧该段 progress 已长到完整文本
    expect(seen[seen.length - 1]).toBe('正在摸清目录')
  })

  it('跨段：上一段 final 不清掉新段 delta（段间 progress live 可见，不憋到结束）', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // 第一段：思考 → 文本 → Read（final 落盘） → tool_result
    items = applySdkMessageToItems(items, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]), allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]))
    const seg1 = [...emitSegment(items, stream, 'u1', ['正在摸清目录'], { id: 'r1', name: 'Read', input: { file_path: 'a.ts' } })]
    const last1 = seg1[seg1.length - 1]!
    items = last1.items
    stream = last1.stream
    items = applySdkMessageToItems(
      items,
      assistantFinal('u1', [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '正在摸清目录' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }], 'tool_use'),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantFinal('u1', [{ type: 'text', text: '正在摸清目录' }], 'tool_use'))
    items = applySdkMessageToItems(items, userToolResult('r1'), allocKey) as Item[]

    // 第二段首个 delta 到达，但 u2 partial 尚未来（只活在 streamState）
    stream = applyTextDelta(stream, '准备')
    const liveFrame = renderConcise({ items, stream }, true)

    // 关键断言：新段 delta 没被上一段 final 守卫清掉，已作为独立 progress narrative 露出
    const progressTexts = liveFrame.narratives.filter((n) => n.tone === 'progress').map((n) => n.text)
    expect(progressTexts).toContain('正在摸清目录')
    expect(progressTexts).toContain('准备')
    // 且两段是两条独立 narrative，不是 `正在摸清目录\n\n准备` 拼接
    expect(liveFrame.narratives.every((n) => !n.text.includes('\n\n'))).toBe(true)
  })

  it('整轮 thinking→text(progress)→tool→text(progress)→…→text(final)：isLive=true 时 progress，结束后升 final', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    items = applySdkMessageToItems(items, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]), allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]))
    const s1 = [...emitSegment(items, stream, 'u1', ['正在摸清目录'], { id: 'r1', name: 'Read', input: {} })]
    let last = s1[s1.length - 1]!
    items = last.items
    stream = last.stream
    items = applySdkMessageToItems(items, assistantFinal('u1', [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '正在摸清目录' }, { type: 'tool_use', id: 'r1', name: 'Read', input: {} }], 'tool_use'), allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantFinal('u1', [{ type: 'text', text: '正在摸清目录' }], 'tool_use'))
    items = applySdkMessageToItems(items, userToolResult('r1'), allocKey) as Item[]

    const s2 = [...emitSegment(items, stream, 'u2', ['准备编辑'], { id: 'e1', name: 'Edit', input: {} })]
    last = s2[s2.length - 1]!
    items = last.items
    stream = last.stream
    items = applySdkMessageToItems(items, assistantFinal('u2', [{ type: 'text', text: '准备编辑' }, { type: 'tool_use', id: 'e1', name: 'Edit', input: {} }], 'tool_use'), allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantFinal('u2', [{ type: 'text', text: '准备编辑' }], 'tool_use'))
    items = applySdkMessageToItems(items, userToolResult('e1'), allocKey) as Item[]

    const s3 = [...emitSegment(items, stream, 'u3', ['完成。'])]
    last = s3[s3.length - 1]!
    items = last.items
    stream = last.stream
    items = applySdkMessageToItems(items, assistantFinal('u3', [{ type: 'text', text: '完成。' }], 'end_turn'), allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantFinal('u3', [{ type: 'text', text: '完成。' }], 'end_turn'))

    // live：三段 narrative 全程可见（打字机即时反馈，不憋到结束）
    const live = renderConcise({ items, stream }, true)
    expect(live.narratives.map((n) => n.tone)).toEqual(['progress', 'progress', 'progress'])
    expect(live.narratives.map((n) => n.text)).toEqual(['正在摸清目录', '准备编辑', '完成。'])

    // 结束（isLive=false）：REGRESS-N 否决 J(J4) idle-drop——有信息的段间短 progress
    // （「正在摸清目录」「准备编辑」）不再被 continue 丢，常驻 narrative.progress；
    // 仅回合末「完成。」升 final。live/idle 同一套 segments 语义。
    const done = renderConcise({ items, stream: EMPTY_STREAM_STATE }, false)
    expect(done.narratives.map((n) => n.tone)).toEqual(['progress', 'progress', 'final'])
    expect(done.narratives.map((n) => n.text)).toEqual(['正在摸清目录', '准备编辑', '完成。'])
  })

  it('历史轮（isLive=false）不重播打字机：narrative 文本即全文，段拆分稳定', () => {
    // 仅落盘 final（无 streamState、无 partial）的历史轮
    const items: Item[] = [
      {
        key: 'a1',
        message: {
          type: 'assistant',
          uuid: 'u1',
          stop_reason: 'tool_use',
          createdAt: 1,
          content: [
            { type: 'thinking', thinking: '想' },
            { type: 'text', text: '正在摸清目录' },
            { type: 'tool_use', id: 'r1', name: 'Read', input: {} },
          ],
        } as TAgentMessage,
      },
      { key: 'r1', message: userToolResult('r1') },
      {
        key: 'a2',
        message: {
          type: 'assistant',
          uuid: 'u2',
          stop_reason: 'tool_use',
          createdAt: 2,
          content: [
            { type: 'text', text: '准备编辑' },
            { type: 'tool_use', id: 'e1', name: 'Edit', input: {} },
          ],
        } as TAgentMessage,
      },
      { key: 'e1', message: userToolResult('e1') },
      {
        key: 'a3',
        message: {
          type: 'assistant',
          uuid: 'u3',
          stop_reason: 'end_turn',
          createdAt: 3,
          content: [{ type: 'text', text: '完成。' }],
        } as TAgentMessage,
      },
    ]

    const pres = buildTurnPresentation(
      { kind: 'assistant-turn', key: 't', items, isStreaming: false },
      { isLiveTurn: false, displayMode: 'concise' },
    )
    const segs = buildConciseTimeline(pres.process, {
      answerTexts: pres.answerTexts,
      streamingText: pres.streamingText,
      isLive: false,
    })
    const narrs = segs.filter((s) => s.kind === 'narrative')
    // ConciseTimelineView 非直播 instant 全文：narrative 文本本身就是全文，无 seed'' 重播。
    // REGRESS-N 否决 J(J4) idle-drop：有信息的段间短 progress 常驻 narrative，
    // 不再只剩回合末 final。
    expect(narrs.map((n) => (n as { text: string }).text)).toEqual(['正在摸清目录', '准备编辑', '完成。'])
    expect(narrs.map((n) => (n as { tone: string }).tone)).toEqual(['progress', 'progress', 'final'])
    // concise 不回传 streamingText（回答壳不参与），narrative 来自 process 全文
    expect(pres.streamingText).toBeUndefined()
  })
})
