/**
 * buildTurnPresentation 条件拆分回归（Vitest）
 *
 * - 有未完成 tool：尾部 text / streamingText 留过程区（防回跳）
 * - 无未完成 tool（含纯 thinking+text）：交付正文进回答区 Markdown 流式，不进思考 UI
 */
import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import {
  areToolsBeforeIndexCompleted,
  buildTurnPresentation,
  type SessionRenderTurn,
  type TurnSourceItem,
} from './session-turn-model'

const assistantBlocks = (
  modelId: string,
  blocks: Extract<TAgentMessage, { type: 'assistant' }>['content'],
): TAgentMessage => ({
  type: 'assistant',
  modelId,
  content: blocks,
})

const userToolResult = (id: string, content = 'ok'): TAgentMessage => ({
  type: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content }],
})

function makeTurn(
  items: TurnSourceItem[],
  isStreaming = false,
): Extract<SessionRenderTurn, { kind: 'assistant-turn' }> {
  return {
    kind: 'assistant-turn',
    key: 'turn-test',
    items,
    modelId: 'test-model',
    isStreaming,
  }
}

/** thinking → tool → text */
function thinkingToolTextItems(opts?: { withResult?: boolean }): TurnSourceItem[] {
  const withResult = opts?.withResult !== false
  const items: TurnSourceItem[] = [
    {
      key: 'a1',
      message: assistantBlocks('test-model', [
        { type: 'thinking', thinking: '先读文件再回答' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } },
      ]),
    },
  ]
  if (withResult) {
    items.push({ key: 'r1', message: userToolResult('t1', 'file content') })
  }
  items.push({
    key: 'a2',
    message: assistantBlocks('test-model', [
      { type: 'text', text: '这是交付给用户的最终回答。' },
    ]),
  })
  return items
}

describe('areToolsBeforeIndexCompleted', () => {
  it('无 tool_use 时返回 true（允许 thinking+text 外置到回答区流式）', () => {
    expect(
      areToolsBeforeIndexCompleted(
        [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'y' }],
        1,
        new Set(),
      ),
    ).toBe(true)
  })

  it('前置 tool 全部有 result 时返回 true', () => {
    expect(
      areToolsBeforeIndexCompleted(
        [
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          { type: 'text', text: 'done' },
        ],
        1,
        new Set(['t1']),
      ),
    ).toBe(true)
  })

  it('前置 tool 缺 result 时返回 false', () => {
    expect(
      areToolsBeforeIndexCompleted(
        [
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          { type: 'text', text: 'mid' },
        ],
        1,
        new Set(),
      ),
    ).toBe(false)
  })
})

describe('buildTurnPresentation：条件拆分（交付正文进回答区流式）', () => {
  it('streaming + 仅 thinking + 尾部 text → text 进回答区，thinking 留过程（不进思考当答案）', () => {
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: assistantBlocks('test-model', [
            { type: 'thinking', thinking: '构思中' },
            { type: 'text', text: '交付回答片段' },
          ]),
        },
      ],
      true,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts.join('')).toContain('交付回答片段')
    expect(pres.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(pres.process.some((p) => p.type === 'text')).toBe(false)
  })

  it('live + 流式 thinking/text（streamState）→ text 进回答壳，thinking 进过程', () => {
    const turn = makeTurn([], true)
    const pres = buildTurnPresentation(turn, {
      isLiveTurn: true,
      streamState: { text: '正在写的正文', thinking: '还在想' },
    })

    expect(pres.streamingText).toBe('正在写的正文')
    expect(pres.answerTexts).toEqual([])
    expect(pres.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(pres.process.some((p) => p.type === 'text')).toBe(false)
  })

  it('isLiveTurn 且工具已有 result 时，尾部 text 进 answerTexts', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: true }), false)
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts.join('')).toContain('这是交付给用户的最终回答。')
    expect(pres.process.some((p) => p.type === 'text')).toBe(false)
    expect(pres.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(pres.process.some((p) => p.type === 'tool')).toBe(true)
  })

  it('工具尚无 result 时，中间 text 留在 process，answerTexts 为空', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: false }), false)
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts).toEqual([])
    const processTexts = pres.process.filter((p) => p.type === 'text')
    expect(processTexts).toHaveLength(1)
    expect(processTexts[0]?.type === 'text' && processTexts[0].text).toBe(
      '这是交付给用户的最终回答。',
    )
  })

  it('历史轮 thinking+text（无 tool）→ text 进回答区（非 live 经典拆分）', () => {
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: assistantBlocks('test-model', [
            { type: 'thinking', thinking: '想完了' },
            { type: 'text', text: '历史交付回答' },
          ]),
        },
      ],
      false,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: false })

    expect(pres.answerTexts.join('')).toContain('历史交付回答')
    expect(pres.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(pres.process.some((p) => p.type === 'text')).toBe(false)
  })

  it('纯 text 无过程块 → 直接回答区', () => {
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: assistantBlocks('test-model', [{ type: 'text', text: '你好' }]),
        },
      ],
      false,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts.join('')).toContain('你好')
    expect(pres.process).toEqual([])
  })

  it('尾部多段连续 text 在工具已齐时全部进 answerTexts', () => {
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: assistantBlocks('test-model', [
            { type: 'thinking', thinking: '构思' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          ]),
        },
        { key: 'r1', message: userToolResult('t1') },
        {
          key: 'a2',
          message: assistantBlocks('test-model', [
            { type: 'text', text: '第一段回答' },
            { type: 'text', text: '第二段回答' },
          ]),
        },
      ],
      false,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts).toHaveLength(1)
    expect(pres.answerTexts[0]).toContain('第一段回答')
    expect(pres.answerTexts[0]).toContain('第二段回答')
    expect(pres.process.some((p) => p.type === 'text')).toBe(false)
  })

  it('工具已齐 + 消息已有 text → 以消息为准，忽略 streamState（防双源抽搐）', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: true }), true)
    const pres = buildTurnPresentation(turn, {
      isLiveTurn: true,
      streamState: { text: '流式最终回答', thinking: '' },
    })

    expect(pres.answerTexts.join('')).toContain('这是交付给用户的最终回答')
    // 消息 content 已有 text 块时不再回传 streamingText
    expect(pres.streamingText).toBeUndefined()
  })

  it('落盘后 streamState 已清 → 回答区不为空（验收 4 无闪空）', () => {
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: assistantBlocks('test-model', [
            { type: 'thinking', thinking: '想完了' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          ]),
        },
        { key: 'r1', message: userToolResult('t1') },
        {
          key: 'a2',
          message: assistantBlocks('test-model', [
            { type: 'text', text: '落盘后的最终回答。' },
          ]),
        },
      ],
      false,
    )
    const pres = buildTurnPresentation(turn, {
      isLiveTurn: false,
      streamState: { text: '', thinking: '' },
    })

    expect(pres.answerTexts.join('')).toContain('落盘后的最终回答')
    expect(pres.streamingText).toBeUndefined()
  })
})

describe('buildTurnPresentation：partial 单真源（S1，思考永驻 content[]）', () => {
  it('thinking deltas → tool_execution（partial）→ 过程区仍有完整 thinking 字符串', () => {
    // 对齐 S1S2 验收 1：partial assistant 把 thinking 放进 content[]，
    // tool_use 同 message 累积；过程区只读 content[]，思考不因 tool 出完即消失。
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: {
            type: 'assistant',
            uuid: 'pi-s-1',
            _partial: true,
            modelId: 'test-model',
            content: [
              { type: 'thinking', thinking: '先读文件再回答的完整思考' },
              { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } },
            ],
          } as TAgentMessage,
        },
      ],
      true,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })
    const think = pres.process.find((p) => p.type === 'thinking')
    expect(think && think.type === 'thinking' ? think.thinking : '').toBe(
      '先读文件再回答的完整思考',
    )
    expect(pres.process.some((p) => p.type === 'tool')).toBe(true)
  })

  it('partial(thinking+tool) 已有 result → 尾部 text 进回答，思考仍留过程区', () => {
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: {
            type: 'assistant',
            uuid: 'pi-s-1',
            _partial: true,
            modelId: 'test-model',
            content: [
              { type: 'thinking', thinking: '思考全文' },
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            ],
          } as TAgentMessage,
        },
        { key: 'r1', message: userToolResult('t1', 'ok') },
        {
          key: 'a2',
          message: assistantBlocks('test-model', [{ type: 'text', text: '最终回答' }]),
        },
      ],
      false,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })
    expect(pres.answerTexts.join('')).toContain('最终回答')
    const think = pres.process.find((p) => p.type === 'thinking')
    expect(think && think.type === 'thinking' ? think.thinking : '').toBe('思考全文')
    expect(pres.process.some((p) => p.type === 'tool')).toBe(true)
  })
})

describe('buildTurnPresentation：concise 时间线拆分（W3，text 留 process）', () => {
  it('concise + live + 工具已齐 + 尾部 text → text 留 process，answerTexts 空', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: true }), false)
    const full = buildTurnPresentation(turn, { isLiveTurn: true, displayMode: 'full' })
    const concise = buildTurnPresentation(turn, { isLiveTurn: true, displayMode: 'concise' })

    expect(full.answerTexts.join('')).toContain('这是交付给用户的最终回答。')
    expect(concise.answerTexts).toEqual([])
    expect(concise.process.some((p) => p.type === 'text')).toBe(true)
    expect(concise.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(concise.process.some((p) => p.type === 'tool')).toBe(true)
  })

  it('concise + live + 工具未齐 + 尾部 text → 留过程区', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: false }), false)
    const concise = buildTurnPresentation(turn, { isLiveTurn: true, displayMode: 'concise' })

    expect(concise.answerTexts).toEqual([])
    expect(concise.process.some((p) => p.type === 'text')).toBe(true)
  })

  it('concise + live + streamState 正文 + 仅 thinking → stream 写入 process text', () => {
    const turn = makeTurn(
      [{ key: 'a1', message: assistantBlocks('test-model', [{ type: 'thinking', thinking: '想' }]) }],
      true,
    )
    const opts = { isLiveTurn: true, streamState: { text: '正在写的正文', thinking: '' } }
    const concise = buildTurnPresentation(turn, { ...opts, displayMode: 'concise' })

    expect(concise.streamingText).toBeUndefined()
    expect(concise.answerTexts).toEqual([])
    expect(concise.process.some((p) => p.type === 'text')).toBe(true)
    const textEntry = concise.process.find((p) => p.type === 'text')
    expect(textEntry && textEntry.type === 'text' ? textEntry.text : '').toContain('正在写的正文')
  })

  it('concise + 非live + 尾部 text → 留 process，不外置', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: true }), false)
    const concise = buildTurnPresentation(turn, { isLiveTurn: false, displayMode: 'concise' })

    expect(concise.answerTexts).toEqual([])
    expect(concise.process.some((p) => p.type === 'text')).toBe(true)
  })

  it('concise + live + 纯 text → 留 process 作 narrative', () => {
    const turn = makeTurn(
      [{ key: 'a1', message: assistantBlocks('test-model', [{ type: 'text', text: '你好' }]) }],
      false,
    )
    const concise = buildTurnPresentation(turn, { isLiveTurn: true, displayMode: 'concise' })

    expect(concise.answerTexts).toEqual([])
    expect(concise.process.some((p) => p.type === 'text')).toBe(true)
  })

  it('full + live + 工具已齐 → 仍外置（回归）', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: true }), false)
    const pres = buildTurnPresentation(turn, { isLiveTurn: true, displayMode: 'full' })

    expect(pres.answerTexts.join('')).toContain('这是交付给用户的最终回答。')
  })
})
