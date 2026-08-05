/**
 * upsertStreamItem / applyThinkingDelta 流式修复回归（Vitest）
 *
 * 防 R3：每条 delta uuid 不同时 key 必须稳定。
 * 防 R1：列表为空时 thinking delta 必须新建占位并累积（kscc）。
 */
import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import {
  applyThinkingDelta,
  upsertStreamItem,
  type StreamItemLike,
  type UpsertStreamContext,
} from './stream-item-model'

function makeCtx(seed?: {
  currentStreaming?: StreamItemLike | null
  nextKey?: () => string
}): {
  ctx: UpsertStreamContext<StreamItemLike>
  keys: string[]
  setCurrent: (item: StreamItemLike | null) => void
} {
  const keys: string[] = []
  let n = 0
  let current: StreamItemLike | null = seed?.currentStreaming ?? null
  const ctx: UpsertStreamContext<StreamItemLike> = {
    get currentStreaming() {
      return current
    },
    allocKey:
      seed?.nextKey ??
      (() => {
        const k = `s${n++}`
        keys.push(k)
        return k
      }),
  }
  return {
    ctx,
    keys,
    setCurrent: (item) => {
      current = item
    },
  }
}

describe('upsertStreamItem：uuid 变化时 key 稳定（防 R3 整轮重挂）', () => {
  it('连续 delta 且每条 uuid 都不同时，只有 1 个流式项且 key 不变', () => {
    // 回归：旧逻辑拿 uuidMismatch 判段，会每 token 新建 key → 子树重挂、打字机失效
    const { ctx, setCurrent } = makeCtx()
    let items: StreamItemLike[] = []

    const d1 = upsertStreamItem(items, { streamingText: '你', streamUuid: 'uuid-1' }, ctx)
    setCurrent(d1.streamingItem)
    items = d1.items

    const d2 = upsertStreamItem(items, { streamingText: '你好', streamUuid: 'uuid-2' }, ctx)
    setCurrent(d2.streamingItem)
    items = d2.items

    const d3 = upsertStreamItem(items, { streamingText: '你好啊', streamUuid: 'uuid-3' }, ctx)
    setCurrent(d3.streamingItem)
    items = d3.items

    const streaming = items.filter((it) => it.streaming)
    expect(streaming).toHaveLength(1)
    expect(streaming[0]!.key).toBe(d1.streamingItem.key)
    expect(streaming[0]!.streamingText).toBe('你好啊')
    expect(streaming[0]!.streamUuid).toBe('uuid-3')
  })

  it('已有落盘 message 的项遇到不同 uuid 时才新建（保留段边界能力）', () => {
    // 回归：不能把「有 message 才因 uuid 换段」改没了
    const existing: StreamItemLike = {
      key: 'committed-0',
      streaming: true,
      streamUuid: 'old-uuid',
      streamingText: '上一段',
      message: {
        type: 'assistant',
        uuid: 'old-uuid',
        content: [{ type: 'text', text: '上一段' }],
      } as TAgentMessage,
    }
    const { ctx } = makeCtx({ currentStreaming: existing })

    const result = upsertStreamItem(
      [existing],
      { streamingText: '新一段', streamUuid: 'new-uuid' },
      ctx,
    )

    expect(result.streamingItem.key).not.toBe('committed-0')
    expect(result.streamingItem.streamingText).toBe('新一段')
    expect(result.streamingItem.streamUuid).toBe('new-uuid')
    // 带 message 的旧项经 purge 仍保留；新占位另起一项
    expect(result.items.map((it) => it.key)).toEqual(['committed-0', result.streamingItem.key])
    expect(result.items.find((it) => it.key === 'committed-0')?.message).toBeTruthy()
  })
})

describe('applyThinkingDelta：空列表也能建占位并累积（防 R1 kscc 思考被吞）', () => {
  it('列表为空、无任何占位时，thinking delta 能创建占位并写入内容', () => {
    // 回归：旧逻辑绑不到就 return prev，kscc thinking 先于正文到达时整轮被吞
    const { ctx, setCurrent } = makeCtx()
    const result = applyThinkingDelta([], '先想一步', 'think-uuid-1', ctx)
    setCurrent(result.streamingItem)

    expect(result.items).toHaveLength(1)
    expect(result.streamingItem.streamingThinking).toBe('先想一步')
    expect(result.streamingItem.streaming).toBe(true)
  })

  it('thinking 多段累积是追加而不是覆盖', () => {
    const { ctx, setCurrent } = makeCtx()
    const r1 = applyThinkingDelta([], '第一段', 'u1', ctx)
    setCurrent(r1.streamingItem)
    const r2 = applyThinkingDelta(r1.items, '第二段', 'u2', ctx)
    setCurrent(r2.streamingItem)
    const r3 = applyThinkingDelta(r2.items, '第三段', 'u3', ctx)

    expect(r3.items).toHaveLength(1)
    expect(r3.streamingItem.key).toBe(r1.streamingItem.key)
    expect(r3.streamingItem.streamingThinking).toBe('第一段第二段第三段')
  })
})
