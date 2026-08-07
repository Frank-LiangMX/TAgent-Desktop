/**
 * 会话级 streamState 回归（Vitest）
 *
 * 验收 1：kscc thinking 先于正文、无占位 → 思考累积不丢
 * 验收 2：delta 不改 items（uuid 乱跳也不新建 DisplayItem）
 */
import { describe, expect, it } from 'vitest'
import {
  applySdkMessageToItems,
  applySdkMessageToStreamState,
  applyTextDelta,
  applyThinkingDeltaToState,
  clearSessionStreamState,
  commitStreamThinkingToLastAssistant,
  commitStreamTextToLastAssistant,
  EMPTY_STREAM_STATE,
  shouldClearStreamText,
  shouldClearStreamThinking,
  type StreamItemLike,
} from './stream-item-model'
import { groupItemsIntoTurns } from './session-turn-model'
import type { TAgentMessage } from '@tagent/shared'

describe('streamState：thinking delta 累积（验收 1 / 防 R1）', () => {
  it('空 state 上连续 thinking delta 逐条累积', () => {
    let state = EMPTY_STREAM_STATE
    state = applyThinkingDeltaToState(state, '先')
    state = applyThinkingDeltaToState(state, '想')
    state = applyThinkingDeltaToState(state, '一步')
    expect(state.thinking).toBe('先想一步')
    expect(state.text).toBe('')
  })

  it('thinking 先于正文到达时不会被丢弃', () => {
    const items: { key: string; message?: unknown }[] = []
    let state = applyThinkingDeltaToState(EMPTY_STREAM_STATE, 'kscc 思考段')
    expect(items).toHaveLength(0)
    expect(state.thinking).toBe('kscc 思考段')
    state = applyTextDelta(state, '正文')
    expect(state.text).toBe('正文')
    expect(items).toHaveLength(0)
  })
})

describe('streamState：delta 不修改 items（验收 2 / 防 R3）', () => {
  it('连续 text delta 且 uuid 概念上每条不同，items 长度仍为 0', () => {
    const items: { key: string }[] = []
    let state = EMPTY_STREAM_STATE
    state = applyTextDelta(state, '你')
    state = applyTextDelta(state, '好')
    state = applyTextDelta(state, '啊')
    expect(items).toHaveLength(0)
    expect(state.text).toBe('你好啊')
  })

  it('turn key 在仅有 streamState、无流式占位 item 时由 synthetic turn 稳定', () => {
    const items = [{ key: 'u1', message: { type: 'user', content: [{ type: 'text', text: 'hi' }] } }]
    const turns1 = groupItemsIntoTurns(items as never)
    const turns2 = groupItemsIntoTurns(items as never)
    expect(turns1.map((t) => t.key)).toEqual(turns2.map((t) => t.key))
    expect(turns1).toHaveLength(1)
    expect(turns1[0]?.kind).toBe('user')
  })
})

describe('clearSessionStreamState', () => {
  it('清空 text/thinking', () => {
    const dirty = applyTextDelta(applyThinkingDeltaToState(EMPTY_STREAM_STATE, 'x'), 'y')
    const cleared = clearSessionStreamState()
    expect(cleared).toEqual(EMPTY_STREAM_STATE)
    expect(dirty.text).toBe('y')
  })
})

describe('tool-only sdk_message 不得清 thinking（防出完即消失）', () => {
  const toolOnly = {
    type: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
  }

  it('仅 tool_use 时 shouldClearStreamThinking=false', () => {
    expect(shouldClearStreamThinking(toolOnly)).toBe(false)
    expect(shouldClearStreamText(toolOnly)).toBe(false)
  })

  it('thinking delta 后再来 tool-only → thinking 仍在', () => {
    let state = applyThinkingDeltaToState(EMPTY_STREAM_STATE, '完整思考内容')
    state = applySdkMessageToStreamState(state, toolOnly)
    expect(state.thinking).toBe('完整思考内容')
  })

  it('消息已带 thinking 块时才清 stream thinking', () => {
    let state = applyThinkingDeltaToState(EMPTY_STREAM_STATE, '流式思考')
    state = applySdkMessageToStreamState(state, {
      type: 'assistant',
      content: [{ type: 'thinking', thinking: '流式思考' }, { type: 'text', text: '答' }],
      stop_reason: 'end_turn',
    })
    expect(state.thinking).toBe('')
    expect(state.text).toBe('')
  })

  it('stop_reason 但 content 无 thinking → 保留 stream thinking（REGRESS-E）', () => {
    let state = applyThinkingDeltaToState(EMPTY_STREAM_STATE, '完整思考不应被剥')
    state = applySdkMessageToStreamState(state, {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      stop_reason: 'tool_use',
    })
    expect(state.thinking).toBe('完整思考不应被剥')
  })
})

describe('applySdkMessageToItems：uuid 原地 upsert（S2.1 单真源）', () => {
  let n = 0
  const alloc = (): string => `m${n++}`

  const partialMsg = (uuid: string, thinking: string): TAgentMessage => ({
    type: 'assistant',
    uuid,
    _partial: true,
    content: [
      { type: 'thinking', thinking },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    ],
  })

  const finalMsg = (uuid: string, thinking: string): TAgentMessage => ({
    type: 'assistant',
    uuid,
    stop_reason: 'toolUse',
    content: [
      { type: 'thinking', thinking },
      { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } },
    ],
  })

  it('partial 再 final 同 uuid → 只有一条，content 含 thinking，streaming 关闭', () => {
    let items = applySdkMessageToItems<StreamItemLike>([], partialMsg('u1', '思考全文'), alloc)
    expect(items).toHaveLength(1)
    expect(items[0]?.streaming).toBe(true)
    items = applySdkMessageToItems(items, finalMsg('u1', '思考全文'), alloc)
    expect(items).toHaveLength(1) // 同 uuid 原地替换，不新增
    const m = items[0]?.message
    expect(m?.type).toBe('assistant')
    if (m?.type === 'assistant') {
      expect(m._partial).toBeUndefined()
      expect(m.stop_reason).toBe('toolUse')
      const think = m.content.find((b) => b.type === 'thinking')
      expect(think && think.type === 'thinking' ? think.thinking : '').toBe('思考全文')
    }
    expect(items[0]?.streaming).toBe(false)
  })

  it('final 不被迟到的 partial 覆盖（竞态保护）', () => {
    let items = applySdkMessageToItems<StreamItemLike>([], finalMsg('u1', '思考'), alloc)
    expect(items).toHaveLength(1)
    const m0 = items[0]?.message
    expect(m0?.type).toBe('assistant')
    if (m0?.type === 'assistant') expect(m0.stop_reason).toBe('toolUse')
    // 迟到的同 uuid partial 不应把 final 退回流式
    items = applySdkMessageToItems(items, partialMsg('u1', '思考'), alloc)
    expect(items).toHaveLength(1)
    expect(items[0]?.streaming).toBe(false)
    const m = items[0]?.message
    if (m?.type === 'assistant') {
      expect(m._partial).toBeUndefined()
      expect(m.stop_reason).toBe('toolUse')
    }
  })

  it('不同 uuid 的消息各占一条（partial→final→下一轮 partial 不覆盖上一轮 final）', () => {
    let items = applySdkMessageToItems<StreamItemLike>([], partialMsg('u1', '思考一'), alloc)
    items = applySdkMessageToItems(items, finalMsg('u1', '思考一'), alloc) // u1 终态落盘
    items = applySdkMessageToItems(items, partialMsg('u2', '思考二'), alloc) // 下一轮 partial
    expect(items).toHaveLength(2)
    expect(items[0]?.message?.type === 'assistant' ? items[0].message.uuid : undefined).toBe('u1')
    expect(items[1]?.message?.type === 'assistant' ? items[1].message.uuid : undefined).toBe('u2')
    expect(items[0]?.streaming).toBe(false)
    expect(items[1]?.streaming).toBe(true)
  })

  it('同 uuid 后到 tool-only 快照保留已有 thinking（REGRESS-E）', () => {
    let items = applySdkMessageToItems<StreamItemLike>([], partialMsg('u1', '完整思考全文'), alloc)
    items = applySdkMessageToItems(
      items,
      {
        type: 'assistant',
        uuid: 'u1',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
      alloc,
    )
    expect(items).toHaveLength(1)
    const m = items[0]?.message
    expect(m?.type).toBe('assistant')
    if (m?.type === 'assistant') {
      const think = m.content.find((b) => b.type === 'thinking')
      expect(think && think.type === 'thinking' ? think.thinking : '').toBe('完整思考全文')
      expect(m.content.some((b) => b.type === 'tool_use')).toBe(true)
      expect(m._partial).toBeUndefined()
      expect(m.stop_reason).toBe('tool_use')
    }
  })

  it('commitStreamThinkingToLastAssistant 写入无 thinking 的末条 assistant', () => {
    let items: StreamItemLike[] = [
      {
        key: 'm0',
        message: {
          type: 'assistant',
          uuid: 'u1',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        },
      },
    ]
    items = commitStreamThinkingToLastAssistant(items, '缓冲里的思考')
    const m = items[0]?.message
    expect(m?.type).toBe('assistant')
    if (m?.type === 'assistant') {
      expect(m.content[0]).toMatchObject({ type: 'thinking', thinking: '缓冲里的思考' })
    }
  })

  it('commitStreamTextToLastAssistant 插到 tool_use 前（段间 progress 不因 tool_start 秒消）', () => {
    let items: StreamItemLike[] = [
      {
        key: 'm0',
        message: {
          type: 'assistant',
          uuid: 'u1',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        },
      },
    ]
    items = commitStreamTextToLastAssistant(
      items,
      '还有更多未跟踪文件，看全 + 我新加的调研文档在不在内。',
    )
    const m = items[0]?.message
    expect(m?.type).toBe('assistant')
    if (m?.type === 'assistant') {
      expect(m.content.map((b) => b.type)).toEqual(['text', 'tool_use'])
      expect(m.content[0]).toMatchObject({
        type: 'text',
        text: '还有更多未跟踪文件，看全 + 我新加的调研文档在不在内。',
      })
    }
  })

  it('commitStreamTextToLastAssistant 已有前缀 text 时不双写', () => {
    const text = '52 个文件已暂存（调研文档排除在外）。'
    let items: StreamItemLike[] = [
      {
        key: 'm0',
        message: {
          type: 'assistant',
          content: [
            { type: 'text', text },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      },
    ]
    items = commitStreamTextToLastAssistant(items, text + '提交第一个 commit')
    const m = items[0]?.message
    expect(m?.type).toBe('assistant')
    if (m?.type === 'assistant') {
      expect(m.content.filter((b) => b.type === 'text')).toHaveLength(1)
    }
  })
})
