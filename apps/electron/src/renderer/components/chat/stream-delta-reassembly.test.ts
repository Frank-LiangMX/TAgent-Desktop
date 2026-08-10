import { describe, expect, test } from 'vitest'
import { DeltaTracker, stripPartialAssistantBody } from '@tagent/shared'
import {
  applyTextDelta,
  applyTextReplace,
  applyThinkingDeltaToState,
  applyThinkingReplaceToState,
  clearSessionStreamState,
  type SessionStreamState,
} from './stream-item-model'

/**
 * E 验收：main（DeltaTracker 算 delta）+ renderer（apply fns 重组）联用，端到端纯函数。
 * 复用真实 wired 函数，证明 IPC delta 协议在 renderer 侧精确重组。
 */

/** 模拟 renderer 消费 delta 序列：append 累加 / replace 整体替换（与 Chat.tsx 分支一致）。 */
function applyDeltas(
  start: SessionStreamState,
  deltas: Array<{ kind: string; text: string; replace?: boolean }>,
): SessionStreamState {
  let st = start
  for (const d of deltas) {
    if (d.kind === 'stream_text_delta') {
      st = d.replace ? applyTextReplace(st, d.text) : applyTextDelta(st, d.text)
    } else if (d.kind === 'stream_thinking_delta') {
      st = d.replace ? applyThinkingReplaceToState(st, d.text) : applyThinkingDeltaToState(st, d.text)
    }
  }
  return st
}

describe('E: 累计快照 100→200→300 → 三个 delta，renderer 重组 = 300', () => {
  test('thinking', () => {
    const tracker = new DeltaTracker()
    const snap = (n: number) => [{ type: 'thinking', thinking: 'x'.repeat(n) }]
    const d1 = tracker.feedAssistant('u-1', snap(100))
    const d2 = tracker.feedAssistant('u-1', snap(200))
    const d3 = tracker.feedAssistant('u-1', snap(300))

    // 仅三个 delta（每次一个 thinking append）
    const all = [...d1, ...d2, ...d3]
    expect(all).toHaveLength(3)
    expect(all.every((d) => d.kind === 'stream_thinking_delta' && !d.replace)).toBe(true)

    const state = applyDeltas(clearSessionStreamState(), all)
    expect(state.thinking).toBe('x'.repeat(300))
    expect(state.thinking.length).toBe(300)
  })

  test('text', () => {
    const tracker = new DeltaTracker()
    const snap = (n: number) => [{ type: 'text', text: 'a'.repeat(n) }]
    const d1 = tracker.feedAssistant('u-1', snap(100))
    const d2 = tracker.feedAssistant('u-1', snap(200))
    const d3 = tracker.feedAssistant('u-1', snap(300))
    const all = [...d1, ...d2, ...d3]
    expect(all).toHaveLength(3)
    const state = applyDeltas(clearSessionStreamState(), all)
    expect(state.text).toBe('a'.repeat(300))
  })
})

describe('E: 前缀不匹配触发 resync，不重复、不丢字', () => {
  test('thinking：append "abc" → replace "xab" → 重组 = "xab"（不保留旧、不丢）', () => {
    const tracker = new DeltaTracker()
    const d1 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'abc' }])
    const d2 = tracker.feedAssistant('u-1', [{ type: 'thinking', thinking: 'xab' }])
    const all = [...d1, ...d2]
    expect(all[0]!.replace).toBeUndefined()
    expect(all[1]!.replace).toBe(true)
    const state = applyDeltas(clearSessionStreamState(), all)
    expect(state.thinking).toBe('xab')
  })

  test('resync 后续 append 以 replace 后内容为基', () => {
    const tracker = new DeltaTracker()
    tracker.feedAssistant('u-1', [{ type: 'text', text: 'abc' }])
    const dReplace = tracker.feedAssistant('u-1', [{ type: 'text', text: 'xyz' }])
    const dAppend = tracker.feedAssistant('u-1', [{ type: 'text', text: 'xyz12' }])
    const state = applyDeltas(clearSessionStreamState(), [...dReplace, ...dAppend])
    expect(state.text).toBe('xyz12')
  })
})

describe('E: turn 结束清 streamState（renderer 侧 clearSessionStreamState）', () => {
  test('清空 text/thinking', () => {
    const st = applyDeltas(clearSessionStreamState(), [
      { kind: 'stream_text_delta', text: 'hello' },
      { kind: 'stream_thinking_delta', text: 'think' },
    ])
    expect(st.text).toBe('hello')
    expect(st.thinking).toBe('think')
    const cleared = clearSessionStreamState()
    expect(cleared.text).toBe('')
    expect(cleared.thinking).toBe('')
  })
})

describe('E: 40K synthetic reasoning — IPC 增量近线性（仅传 suffix）', () => {
  test('40K 分 400 帧累计：总 delta 字节 ≈ 40K（非 O(N²) 重传全串）', () => {
    const tracker = new DeltaTracker()
    let totalDeltaBytes = 0
    let totalFullResendBytes = 0
    const N = 40000
    const step = 100 // 400 帧累计到 40K
    for (let i = step; i <= N; i += step) {
      const cur = [{ type: 'thinking', thinking: 'y'.repeat(i) }]
      const deltas = tracker.feedAssistant('u-1', cur)
      for (const d of deltas) {
        totalDeltaBytes += d.text.length // delta 只传 suffix
      }
      // 对比：旧路径每帧重传全串
      totalFullResendBytes += i
    }
    // delta 总字节 ≈ N（近线性），远小于旧路径 O(N²) 全串重传
    expect(totalDeltaBytes).toBe(N)
    expect(totalFullResendBytes).toBeGreaterThan(N * 100) // O(N²) 量级
  })

  test('partial body 剥离后体积仅工具块（thinking/text 主体不重传）', () => {
    const big = 'z'.repeat(40000)
    const stripped = stripPartialAssistantBody([
      { type: 'thinking', thinking: big },
      { type: 'text', text: big },
      { type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } } as never,
    ])
    // 剥离后 thinking/text 主体为空，IPC 只传工具块（不重传 80K 主体）
    expect((stripped[0] as { thinking: string }).thinking).toBe('')
    expect((stripped[1] as { text: string }).text).toBe('')
    expect(stripped[2]).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } })
  })
})

/**
 * 风险1 端到端：SDK includePartialMessages 同时产「原生 stream_event delta」与「assistant 累计快照」。
 * main 侧单一权威源规则：见原生 delta → markNativeDeltaActive → 快照不再经 DeltaTracker 发派生 delta。
 * renderer 只见原生 delta 一份，不双 append。
 */
describe('单一权威 delta 源（风险1）：原生 delta + 快照同在 → renderer 只重组一份', () => {
  test('原生 delta 已喂 + 标记权威 → 快照派生 delta 抑制 → renderer 仍只有原生一份', () => {
    const tracker = new DeltaTracker()
    let state = clearSessionStreamState()
    // 1) SDK 原生 stream_event delta 先到（renderer 直接 apply）
    state = applyTextDelta(state, 'abc')
    // 2) main 标记本轮权威源（handleSdkStreamMessage 在发原生 delta 时调用）
    tracker.markNativeDeltaActive()
    // 3) assistant 累计快照后到（含 'abcdef'）→ DeltaTracker 抑制派生 delta（不发）
    const d = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abcdef' }])
    expect(d).toHaveLength(0)
    state = applyDeltas(state, d) // 无派生 delta 注入
    // renderer 仍只有原生 'abc'（未被快照派生 delta 重复 append）
    expect(state.text).toBe('abc')
  })

  test('无原生 delta → DeltaTracker fallback 发 delta，renderer 重组 = 全量（不丢字）', () => {
    const tracker = new DeltaTracker()
    let state = clearSessionStreamState()
    const d1 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abc' }])
    const d2 = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abcdef' }])
    state = applyDeltas(state, [...d1, ...d2])
    expect(state.text).toBe('abcdef')
  })

  test('final 全量 sdk_message 校准：原生 delta 累积 = final content，handoff 后以 message 为权威', () => {
    const tracker = new DeltaTracker()
    let state = clearSessionStreamState()
    // 原生 delta 累积到 'abcdef'
    state = applyTextDelta(state, 'abc')
    state = applyTextDelta(state, 'def')
    tracker.markNativeDeltaActive()
    // final 快照（isFinal）不发派生 delta（全量 sdk_message 走 handoff 校准）
    const dFinal = tracker.feedAssistant('u-1', [{ type: 'text', text: 'abcdef' }], { isFinal: true })
    expect(dFinal).toHaveLength(0)
    // 原生累积 = final content（handoff 后 message 为权威，无丢字无重复）
    expect(state.text).toBe('abcdef')
  })
})
