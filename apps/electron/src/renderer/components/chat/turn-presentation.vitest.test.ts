/**
 * buildTurnPresentation 条件拆分回归（Vitest）
 *
 * 对齐 Proma/General：streaming/live + 过程块时，禁止把「thinking + text」提前外置；
 * 仅当尾部 text 之前的 tool 全部有 result 才进回答区。
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
  it('无 tool_use 时返回 false（防 thinking+text 提前外置）', () => {
    expect(
      areToolsBeforeIndexCompleted(
        [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'y' }],
        1,
        new Set(),
      ),
    ).toBe(false)
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

describe('buildTurnPresentation：条件拆分（对齐 Proma，防闪空）', () => {
  it('streaming + 仅 thinking + 尾部 text → 整组 process，回答区空', () => {
    // Proma 同款：工具可能稍后才出现，禁止提前外置
    const turn = makeTurn(
      [
        {
          key: 'a1',
          message: assistantBlocks('test-model', [
            { type: 'thinking', thinking: '构思中' },
            { type: 'text', text: '暂时的回答片段' },
          ]),
        },
      ],
      true,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts).toEqual([])
    expect(pres.streamingText).toBeUndefined()
    expect(pres.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(pres.process.some((p) => p.type === 'text' && p.text.includes('暂时的回答片段'))).toBe(
      true,
    )
  })

  it('live + 流式 thinking/text 占位（尚未落盘）→ streamingText 进 process 不进回答', () => {
    const turn = makeTurn(
      [
        {
          key: 'stream',
          streaming: true,
          streamingThinking: '还在想',
          streamingText: '闪一下就消失的正文',
        },
      ],
      true,
    )
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts).toEqual([])
    expect(pres.streamingText).toBeUndefined()
    expect(pres.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(pres.process.some((p) => p.type === 'text' && p.text.includes('闪一下'))).toBe(true)
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
})
