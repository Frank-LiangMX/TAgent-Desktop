/**
 * buildTurnPresentation 流式修复回归（Vitest）
 *
 * 防 R2：live 轮尾部 text 必须进回答区，不能因 isLiveTurn 留在过程区被截成灰字。
 * 纯函数，node 环境直接跑。
 */
import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import {
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

function makeTurn(items: TurnSourceItem[], isStreaming = false): Extract<SessionRenderTurn, { kind: 'assistant-turn' }> {
  return {
    kind: 'assistant-turn',
    key: 'turn-test',
    items,
    modelId: 'test-model',
    isStreaming,
  }
}

/** thinking → tool(有 result) → text */
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

describe('buildTurnPresentation：live 轮尾部 text 进回答区（防 R2 闪空/灰字）', () => {
  it('isLiveTurn 且工具已有 result 时，尾部 text 进 answerTexts 而非 process', () => {
    // 回归：旧条件要求 !isLiveTurn && !isStreaming，运行中正文会留在过程区被截断成灰字
    const turn = makeTurn(thinkingToolTextItems({ withResult: true }), false)
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts.join('')).toContain('这是交付给用户的最终回答。')
    expect(pres.process.some((p) => p.type === 'text')).toBe(false)
    expect(pres.process.some((p) => p.type === 'thinking')).toBe(true)
    expect(pres.process.some((p) => p.type === 'tool')).toBe(true)
  })

  it('工具尚无 result（hasOpenTools）时，中间 text 留在 process，answerTexts 为空', () => {
    // 回归：「说一句再调工具」的中间文案不能被误当交付
    const turn = makeTurn(thinkingToolTextItems({ withResult: false }), false)
    const pres = buildTurnPresentation(turn, { isLiveTurn: true })

    expect(pres.answerTexts).toEqual([])
    const processTexts = pres.process.filter((p) => p.type === 'text')
    expect(processTexts).toHaveLength(1)
    expect(processTexts[0]?.type === 'text' && processTexts[0].text).toBe(
      '这是交付给用户的最终回答。',
    )
  })

  it('非 live 历史轮：thinking→tool→text 行为与 live 一致（回归保护）', () => {
    const turn = makeTurn(thinkingToolTextItems({ withResult: true }), false)
    const live = buildTurnPresentation(turn, { isLiveTurn: true })
    const history = buildTurnPresentation(turn, { isLiveTurn: false })

    expect(history.answerTexts).toEqual(live.answerTexts)
    expect(history.process.map((p) => p.type)).toEqual(live.process.map((p) => p.type))
  })

  it('尾部多段连续 text 全部进 answerTexts', () => {
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
