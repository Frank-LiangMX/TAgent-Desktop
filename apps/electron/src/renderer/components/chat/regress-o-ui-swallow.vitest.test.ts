/**
 * REGRESS-O 回归（Vitest）— live 打字机总结「立刻消失」是 UI remount，不是数据丢
 *
 * 规格：docs/dev/core-loop/REGRESS-O-ui-swallow-brief.md
 * 对照：docs/dev/core-loop/REGRESS-O-FINDINGS.md
 *
 * O1 根因：concise 下段间 progress 在 live 只活在 streamState → buildTurnPresentation
 * 推 key=`stream-text` 的过程条目；下一帧 partial 快照带 text 块到达、streamState 被清
 * （stream-item-model shouldClearStreamText）→ 过程条目 key 换成 `text-${owner}-${i}`。
 * buildConciseTimeline 旧实现把 narrative 的 React key 跟着过程条目 key 走 → NarrativeRow
 * 卸载重挂 → seed 回 '' → REGRESS-N「无内容 return null」秒空 + 打字机重来一截。
 *
 * 修复：narrative key 用位置下标 `narrative-${index}`（同生长段内稳定），不再跟过程条目
 * key 走。本测试用真 reducer（applySdkMessageToItems / applyTextDelta / applySdkMessageToStreamState）
 * 逐帧推进 (items, streamState)，跑 buildTurnPresentation + buildConciseTimeline，断言：
 *
 * 1. 段内：stream-text 帧（partial 无 text，只 streamState）→ partial 带 text 帧 →
 *    同一段 narrative 的 key **不变**（不 remount），且文本不回落空（无 null 帧）。
 * 2. 跨段：上一段 final 落盘后，新段首 delta（stream-text）→ 新段 partial 带 text →
 *    新段 narrative key 不变。
 * 3. tool_start commit：commitStreamTextToLastAssistant 写入 message + 清 streamState 后，
 *    narrative key 仍不变。
 */
import { describe, expect, it } from 'vitest'
import { buildTurnPresentation } from './session-turn-model'
import { buildConciseTimeline } from './concise-timeline-model'
import {
  applySdkMessageToItems,
  applyTextDelta,
  applySdkMessageToStreamState,
  EMPTY_STREAM_STATE,
  commitStreamTextToLastAssistant,
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

interface Narr {
  key: string
  text: string
  tone: string
}

function renderNarratives(frame: { items: Item[]; stream: SessionStreamState }, isLive: boolean): Narr[] {
  const pres = buildTurnPresentation(
    { kind: 'assistant-turn', key: 't', items: frame.items, isStreaming: true },
    { isLiveTurn: isLive, streamState: isLive ? frame.stream : undefined, displayMode: 'concise' },
  )
  const segs = buildConciseTimeline(pres.process, {
    answerTexts: pres.answerTexts,
    streamingText: pres.streamingText,
    isLive,
  })
  return segs
    .filter((s) => s.kind === 'narrative')
    .map((s) => {
      const n = s as { key: string; text: string; tone: string }
      return { key: n.key, text: n.text, tone: n.tone }
    })
}

describe('REGRESS-O O1：narrative key 跨 stream→partial→commit 稳定（不 remount / 不闪空）', () => {
  it('段内：stream-text 帧 → partial 带 text 帧，同段 narrative key 不变且不空', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // u1 partial 仅 thinking（无 text 块）；正文只活在 streamState（打字机 NarrativeRow）
    items = applySdkMessageToItems(
      items,
      assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]))
    // 逐字 delta 累积到 streamState，partial 一直不带 text（模拟 partial 快照滞后）
    for (const tok of ['正在', '摸清', '目录']) {
      stream = applyTextDelta(stream, tok)
    }

    // 帧 A：stream-text 帧（partial 无 text，正文只在 streamState）
    const frameA = renderNarratives({ items, stream }, true)
    expect(frameA).toHaveLength(1)
    expect(frameA[0]!.text).toBe('正在摸清目录')
    expect(frameA[0]!.tone).toBe('progress')
    const keyA = frameA[0]!.key

    // 帧 B：partial 快照带 text 块到达 → streamState 被清（shouldClearStreamText）
    items = applySdkMessageToItems(
      items,
      assistantPartial('u1', [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '正在摸清目录' }]),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(
      stream,
      assistantPartial('u1', [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '正在摸清目录' }]),
    )
    const frameB = renderNarratives({ items, stream }, true)
    expect(frameB).toHaveLength(1)
    // 关键断言：key 不变 → React 复用同一 NarrativeRow，不 remount、seed 不回 ''
    expect(frameB[0]!.key).toBe(keyA)
    // 文本不回落空（无 null 帧 / 不闪空）
    expect(frameB[0]!.text.trim()).toBe('正在摸清目录')
    expect(frameB[0]!.tone).toBe('progress')
  })

  it('跨段：上一段 final 落盘后，新段 stream-text 帧 → partial 带 text 帧，新段 key 不变', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // 第一段：思考 → 文本 → Read（final 落盘） → tool_result
    items = applySdkMessageToItems(items, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]), allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]))
    for (const tok of ['正在摸清目录']) stream = applyTextDelta(stream, tok)
    items = applySdkMessageToItems(
      items,
      assistantFinal('u1', [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '正在摸清目录' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }], 'tool_use'),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantFinal('u1', [{ type: 'text', text: '正在摸清目录' }], 'tool_use'))
    items = applySdkMessageToItems(items, userToolResult('r1'), allocKey) as Item[]

    // 第二段首 delta 到达，u2 partial 尚未来（只活在 streamState）→ stream-text 帧
    stream = applyTextDelta(stream, '准备编辑')
    const frameA = renderNarratives({ items, stream }, true)
    const seg2A = frameA.find((n) => n.text === '准备编辑')!
    expect(seg2A).toBeTruthy()
    const keyA = seg2A.key

    // u2 partial 带 text 块到达 → streamState 被清
    items = applySdkMessageToItems(
      items,
      assistantPartial('u2', [{ type: 'text', text: '准备编辑' }, { type: 'tool_use', id: 'e1', name: 'Edit', input: {} }]),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(
      stream,
      assistantPartial('u2', [{ type: 'text', text: '准备编辑' }]),
    )
    const frameB = renderNarratives({ items, stream }, true)
    const seg2B = frameB.find((n) => n.text === '准备编辑')!
    expect(seg2B).toBeTruthy()
    // 关键断言：跨 stream-text → partial，新段 narrative key 不变
    expect(seg2B.key).toBe(keyA)
    // 第一段 narrative key 也稳定（不被新段插入打乱）
    const seg1A = frameA.find((n) => n.text === '正在摸清目录')!
    const seg1B = frameB.find((n) => n.text === '正在摸清目录')!
    expect(seg1B.key).toBe(seg1A.key)
  })

  it('tool_start commit：写入 message + 清 streamState 后，narrative key 仍不变', () => {
    let items: Item[] = []
    let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }

    // u1 stream-text 帧（partial 无 text，正文只在 streamState）
    items = applySdkMessageToItems(items, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]), allocKey) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantPartial('u1', [{ type: 'thinking', thinking: '想' }]))
    for (const tok of ['目录摸清了，下一步改投影层']) stream = applyTextDelta(stream, tok)
    const frameA = renderNarratives({ items, stream }, true)
    const keyA = frameA[0]!.key
    expect(frameA[0]!.text).toBe('目录摸清了，下一步改投影层')

    // tool_start：commit 写入末条 assistant（插到 tool_use 前），清 streamState.text
    const pendingText = stream.text.trim()
    items = commitStreamTextToLastAssistant(items, pendingText) as Item[]
    stream = { ...stream, text: '' }

    // 模拟紧随其后的 partial（text + tool_use）落盘
    items = applySdkMessageToItems(
      items,
      assistantFinal('u1', [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '目录摸清了，下一步改投影层' }, { type: 'tool_use', id: 'e1', name: 'Edit', input: {} }], 'tool_use'),
      allocKey,
    ) as Item[]
    stream = applySdkMessageToStreamState(stream, assistantFinal('u1', [{ type: 'text', text: '目录摸清了，下一步改投影层' }], 'tool_use'))

    const frameB = renderNarratives({ items, stream }, true)
    // commit 后 narrative 仍在，key 不变（不 remount）
    expect(frameB.some((n) => n.text === '目录摸清了，下一步改投影层')).toBe(true)
    const narr = frameB.find((n) => n.text === '目录摸清了，下一步改投影层')!
    expect(narr.key).toBe(keyA)
  })

  it('narrative key 形如 narrative-${index}，不再泄露过程条目 key（stream-text / text-${owner}-${i}）', () => {
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
          stop_reason: 'end_turn',
          createdAt: 2,
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
    // key 全为 narrative-${index}，不混入 text-u1-0 / text-u2-0 / stream-text
    expect(narrs.map((n) => (n as { key: string }).key)).toEqual(['narrative-0', 'narrative-1'])
    expect(narrs.every((n) => /^narrative-\d+$/.test((n as { key: string }).key))).toBe(true)
  })
})

describe('REGRESS-O O2：中段 live 思考并入 stage.steps，末步思考可被视图外挂（模型契约）', () => {
  it('live：tool → thinking（末步）并入同一 work_stage，思考为末步 step（视图据此外挂打字机）', () => {
    const deliverable =
      'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。'
    const process: Parameters<typeof buildConciseTimeline>[0] = [
      { type: 'tool', key: 'r1', tool: { type: 'tool_use', id: 'r1', name: 'Read', input: {} } },
      { type: 'thinking', key: 't1', thinking: deliverable },
    ]
    const segs = buildConciseTimeline(process, { isLive: true })
    expect(segs.map((s) => s.kind)).toEqual(['work_stage'])
    const stage = segs[0]!
    if (stage.kind === 'work_stage') {
      // 末步是思考 → 视图 liveTailThinking 检测命中，正文打字机外挂
      const last = stage.steps[stage.steps.length - 1]!
      expect(last.kind).toBe('thinking')
      if (last.kind === 'thinking') expect(last.thinking).toBe(deliverable)
    }
  })
})
