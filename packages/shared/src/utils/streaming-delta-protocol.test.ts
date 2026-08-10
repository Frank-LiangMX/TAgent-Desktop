import { describe, expect, test } from 'vitest'
import {
  computeDelta,
  extractBlockSnapshot,
  DeltaTracker,
  stripPartialAssistantBody,
  shouldDeltaTrackAssistant,
} from './streaming-delta-protocol'
import type { TAgentMessage } from '../types/tagent-message'

describe('computeDelta — suffix / resync', () => {
  test('无变化 → null（不发包）', () => {
    expect(computeDelta('abc', 'abc')).toBeNull()
    expect(computeDelta('', '')).toBeNull()
  })

  test('prev 为空 → append(全量)', () => {
    expect(computeDelta('', 'abc')).toEqual({ type: 'append', text: 'abc' })
  })

  test('前缀匹配 → append(suffix)', () => {
    expect(computeDelta('abc', 'abcdef')).toEqual({ type: 'append', text: 'def' })
  })

  test('前缀不匹配 → replace(全量)（resync，不丢字不重复）', () => {
    expect(computeDelta('abc', 'xab')).toEqual({ type: 'replace', text: 'xab' })
    expect(computeDelta('abcdef', 'abcXYZ')).toEqual({ type: 'replace', text: 'abcXYZ' })
  })
})

describe('extractBlockSnapshot — 从 content[] 提取累计 thinking/text', () => {
  test('拼接多个 thinking / text 块；忽略 tool_use 等', () => {
    const snap = extractBlockSnapshot([
      { type: 'thinking', thinking: '先看' },
      { type: 'text', text: '你好' },
      { type: 'tool_use', id: 't1', name: 'Read' } as never,
      { type: 'thinking', thinking: '目录' },
      { type: 'text', text: '世界' },
    ])
    expect(snap.thinking).toBe('先看目录')
    expect(snap.text).toBe('你好世界')
  })

  test('无 thinking/text → 空串', () => {
    const snap = extractBlockSnapshot([{ type: 'tool_use', id: 't1', name: 'Bash' } as never])
    expect(snap.thinking).toBe('')
    expect(snap.text).toBe('')
  })
})

/** renderer 重组模拟：append 累加，replace 整体替换（对应 streamState.text/thinking）。 */
function reassemble(
  deltas: Array<{ text: string; replace?: boolean }>,
): string {
  let acc = ''
  for (const d of deltas) {
    if (d.replace) acc = d.text
    else acc += d.text
  }
  return acc
}

describe('E 验收：累计快照 100→200→300 只产三个新增 delta，renderer 重组 = 300', () => {
  test('thinking 增量', () => {
    const tracker = new DeltaTracker()
    const d1 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'x'.repeat(100) }])
    const d2 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'x'.repeat(200) }])
    const d3 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'x'.repeat(300) }])

    // 三次各产一个 thinking delta；均为 append(suffix)
    expect(d1).toHaveLength(1)
    expect(d2).toHaveLength(1)
    expect(d3).toHaveLength(1)
    const all = [d1[0]!, d2[0]!, d3[0]!]
    expect(all.every((d) => d.kind === 'stream_thinking_delta' && !d.replace)).toBe(true)
    expect(all.map((d) => d.text.length)).toEqual([100, 100, 100])

    // renderer 重组精确等于 300
    expect(reassemble(all).length).toBe(300)
    expect(reassemble(all)).toBe('x'.repeat(300))
  })

  test('text 增量同理', () => {
    const tracker = new DeltaTracker()
    tracker.feedAssistant('u-1', [{ type: 'text', text: 'a'.repeat(100) }])
    tracker.feedAssistant('u-1', [{ type: 'text', text: 'a'.repeat(200) }])
    const d3 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'a'.repeat(300) }])
    expect(d3[0]!.kind).toBe('stream_text_delta')
  })
})

describe('E 验收：前缀不匹配触发 resync，不重复、不丢字', () => {
  test('thinking 从 "abc" 跳到 "xab" → replace 全量', () => {
    const tracker = new DeltaTracker()
    const d1 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'abc' }])!
    const d2 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'xab' }])!

    expect(d1[0]!.replace).toBeUndefined() // append
    expect(d2[0]!.replace).toBe(true) // resync
    expect(d2[0]!.text).toBe('xab')

    // renderer：append 'abc' → replace 'xab' → 'xab'（不保留旧 abc，不丢字）
    expect(reassemble([d1[0]!, d2[0]!])).toBe('xab')
  })

  test('resync 后续继续 append，以 replace 后内容为基', () => {
    const tracker = new DeltaTracker()
    const d1 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'abc' }])!
    const d2 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'xab' }])!
    const d3 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'xabYZ' }])!
    // d3: prev('xab') 是 cur('xabYZ') 前缀 → append 'YZ'
    expect(d3[0]!.replace).toBeUndefined()
    expect(d3[0]!.text).toBe('YZ')
    expect(reassemble([d1[0]!, d2[0]!, d3[0]!])).toBe('xabYZ')
  })
})

describe('E 验收：session / turn / block 隔离', () => {
  test('per-uuid 快照独立（不同 uuid 不串块）', () => {
    const tracker = new DeltaTracker()
    tracker.feedAssistant('u-A', [{ type: 'thinking', thinking: 'A1' }])
    // u-B 首次：prev 为空 → append 'B1'（不会拿到 u-A 的 'A1'）
    const dB = tracker.feedAssistant('u-B', [{ type: 'thinking', thinking: 'B1' }])
    expect(dB[0]!.text).toBe('B1')
    expect(dB[0]!.replace).toBeUndefined()
    // u-A 继续：以 'A1' 为基 append
    const dA2 = tracker.feedAssistant('u-A', [{ type: 'thinking', thinking: 'A1A2' }])
    expect(dA2[0]!.text).toBe('A2')
  })

  test('不同 DeltaTracker 实例（per session）互不串扰', () => {
    const s1 = new DeltaTracker()
    const s2 = new DeltaTracker()
    s1.feedAssistant('u-1', [{ type: 'thinking', thinking: 'S1' }])
    const d = s2.feedAssistant('u-1', [{ type: 'thinking', thinking: 'S2' }])
    // s2 的 u-1 prev 为空（不继承 s1）→ append 'S2'
    expect(d[0]!.text).toBe('S2')
  })

  test('resetBlock 清单 uuid（block 结束后同 uuid 重新从空起算）', () => {
    const tracker = new DeltaTracker()
    tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'abc' }])
    tracker.resetBlock('u-1')
    const d = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'xyz' }])
    // 重置后 prev 为空 → append 'xyz'（不当成 'abc' 的续写）
    expect(d[0]!.text).toBe('xyz')
    expect(d[0]!.replace).toBeUndefined()
  })

  test('resetAll 清全部（turn_end/result/切会话兜底）', () => {
    const tracker = new DeltaTracker()
    tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'a' }])
    tracker.feedAssistant('u-2', [{ type: 'text', text: 'b' }])
    tracker.resetAll()
    const d = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'z' }])
    expect(d[0]!.text).toBe('z')
    expect(d[0]!.replace).toBeUndefined()
  })

  test('final（isFinal）后清该 uuid 快照 + 仍发末段增量', () => {
    const tracker = new DeltaTracker()
    tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'abc' }])
    const dFinal = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'abcdef' }], {
      isFinal: true,
    })
    expect(dFinal[0]!.text).toBe('def') // 末段增量
    // final 后再喂同 uuid：prev 已清 → 从空起算（新 block）
    const dNew = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'xyz' }])
    expect(dNew[0]!.text).toBe('xyz')
    expect(dNew[0]!.replace).toBeUndefined()
  })
})

describe('stripPartialAssistantBody — 剥掉 partial body 主体', () => {
  test('thinking / text 置空（保留块结构 + blockIndex）；tool_use 原样保留', () => {
    const stripped = stripPartialAssistantBody([
      { type: 'thinking', thinking: '很长思考…' },
      { type: 'text', text: '很长正文…' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } } as never,
    ])
    expect(stripped[0]).toEqual({ type: 'thinking', thinking: '' })
    expect(stripped[1]).toEqual({ type: 'text', text: '' })
    expect(stripped[2]).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } })
    // 块数量不变（保 blockIndex 稳定）
    expect(stripped).toHaveLength(3)
  })

  test('不修改原数组（纯函数）', () => {
    const orig = [{ type: 'thinking', thinking: 'abc' }]
    stripPartialAssistantBody(orig)
    expect(orig[0]!.thinking).toBe('abc')
  })
})

describe('单一权威 delta 源（风险1）：原生 delta + 快照派生 delta 不双 append', () => {
  test('markNativeDeltaActive 后 feedAssistant 不再发派生 delta（原生已喂 renderer）', () => {
    const tracker = new DeltaTracker()
    // 先见到 SDK 原生 stream_event delta → 标记本轮权威源
    tracker.markNativeDeltaActive()
    expect(tracker.isNativeDeltaActive()).toBe(true)
    // 随后到 assistant 累计快照（含 'abcdef'）→ 不发派生 delta（防与原生 delta 双 append）
    const d1 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abc' }])
    const d2 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abcdef' }])
    const d3 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abcdef' }], { isFinal: true })
    expect(d1).toHaveLength(0)
    expect(d2).toHaveLength(0)
    expect(d3).toHaveLength(0) // final 同样不发派生 delta（final 走全量 sdk_message 校准）
  })

  test('无原生 delta（fallback）→ feedAssistant 正常发 delta，renderer 重组不丢字', () => {
    const tracker = new DeltaTracker()
    expect(tracker.isNativeDeltaActive()).toBe(false)
    const d1 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abc' }])!
    const d2 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abcdef' }])!
    expect(d1[0]!.kind).toBe('stream_text_delta')
    expect(d1[0]!.text).toBe('abc')
    expect(d2[0]!.text).toBe('def')
    // renderer 重组 = 全量（fallback 不丢字）
    expect(reassemble([d1[0]!, d2[0]!])).toBe('abcdef')
  })

  test('resetAll 清原生旗标 → 下一轮可重新 fallback（重新判定权威源）', () => {
    const tracker = new DeltaTracker()
    tracker.markNativeDeltaActive()
    expect(tracker.isNativeDeltaActive()).toBe(true)
    tracker.resetAll()
    expect(tracker.isNativeDeltaActive()).toBe(false)
    // 重置后无原生 → fallback 发 delta
    const d = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'xyz' }])!
    expect(d[0]!.text).toBe('xyz')
    expect(d[0]!.replace).toBeUndefined()
  })

  test('混合：先 fallback 一帧，后见原生 → 之后快照不再发派生 delta', () => {
    const tracker = new DeltaTracker()
    // 先无原生：fallback 发一帧
    const d1 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'ab' }])!
    expect(d1[0]!.text).toBe('ab')
    // 后见原生：标记权威源
    tracker.markNativeDeltaActive()
    // 随后快照不再发派生 delta（原生 delta 接管 live）
    const d2 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abcdef' }])!
    expect(d2).toHaveLength(0)
  })
})

describe('shouldDeltaTrackAssistant — 主线/子代理判定（风险2：子代理 partial 不剥、详情可消费）', () => {
  test('主线 assistant（无 parentToolUseId）→ true（走 DeltaTracker + 剥主体）', () => {
    expect(
      shouldDeltaTrackAssistant({ type: 'assistant', parentToolUseId: null, content: [] } as never),
    ).toBe(true)
    expect(shouldDeltaTrackAssistant({ type: 'assistant', content: [] } as never)).toBe(true)
  })

  test('子代理 assistant（parentToolUseId）→ false（保持全量 sdk_message，详情页 items 可消费）', () => {
    expect(
      shouldDeltaTrackAssistant({
        type: 'assistant',
        parentToolUseId: 'tool-1',
        content: [{ type: 'text', text: '子代理正文' }],
      } as never),
    ).toBe(false)
  })

  test('user / undefined → false', () => {
    expect(shouldDeltaTrackAssistant({ type: 'user', content: [] } as never)).toBe(false)
    expect(shouldDeltaTrackAssistant(undefined)).toBe(false)
  })

  test('类型守卫：true 时收窄为 assistant（可访问 content / _partial）', () => {
    const m: TAgentMessage = {
      type: 'assistant',
      parentToolUseId: null,
      content: [{ type: 'text', text: 'x' }],
      _partial: true,
    }
    if (shouldDeltaTrackAssistant(m)) {
      expect(m._partial).toBe(true)
      expect(m.content).toHaveLength(1)
    } else {
      expect.fail('应收窄为 assistant')
    }
  })
})
