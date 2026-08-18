import { describe, expect, test } from 'vitest'
import {
  applyMessageToInFlightToolIds,
  collectPendingToolUseIds,
  resolveAdoptStartedAt,
  sessionHasInFlightWork,
  shouldScheduleRunStopAfterTurnEnd,
} from './session-run-inflight'

describe('applyMessageToInFlightToolIds', () => {
  test('assistant tool_use 记入，user tool_result 配对清除', () => {
    const ids = new Set<string>()
    applyMessageToInFlightToolIds(ids, {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'call_bash' }],
    })
    expect([...ids]).toEqual(['call_bash'])
    applyMessageToInFlightToolIds(ids, {
      type: 'user',
      content: [{ type: 'tool_result', toolUseId: 'call_bash' }],
    })
    expect(ids.size).toBe(0)
  })

  test('parented 子代理消息不计入主会话在途工具', () => {
    const ids = new Set<string>()
    applyMessageToInFlightToolIds(ids, {
      type: 'assistant',
      parentToolUseId: 'agent-1',
      content: [{ type: 'tool_use', id: 'child-read' }],
    })
    expect(ids.size).toBe(0)
  })
})

describe('collectPendingToolUseIds', () => {
  test('多轮工具循环只留下尚未返回的 id', () => {
    const pending = collectPendingToolUseIds([
      {
        message: {
          type: 'assistant',
          content: [
            { type: 'tool_use', id: 'a' },
            { type: 'tool_use', id: 'b' },
          ],
        },
      },
      { message: { type: 'user', content: [{ type: 'tool_result', toolUseId: 'a' }] } },
    ])
    expect([...pending]).toEqual(['b'])
  })
})

describe('sessionHasInFlightWork', () => {
  test('未完成 tool_use → 在途', () => {
    expect(sessionHasInFlightWork({ pendingToolUseIds: ['call_1'] })).toBe(true)
  })

  test('空集合且无卡片 → 不在途', () => {
    expect(sessionHasInFlightWork({ pendingToolUseIds: [], items: [] })).toBe(false)
  })

  test('running taskCard / 圆桌进行中 → 在途', () => {
    expect(
      sessionHasInFlightWork({
        pendingToolUseIds: [],
        items: [{ taskCard: { status: 'running' } }],
      }),
    ).toBe(true)
    expect(
      sessionHasInFlightWork({
        items: [{ moaRoundtable: { phase: 'aggregating' } }],
      }),
    ).toBe(true)
    expect(
      sessionHasInFlightWork({
        items: [{ moaDiscussion: { phase: 'discussing' } }],
      }),
    ).toBe(true)
  })
})

describe('shouldScheduleRunStopAfterTurnEnd', () => {
  test('有在途工作则不安排停表（Bash 等 70s 间隙）', () => {
    expect(shouldScheduleRunStopAfterTurnEnd(true)).toBe(false)
  })

  test('无在途工作才允许宽限停表（等真正 result）', () => {
    expect(shouldScheduleRunStopAfterTurnEnd(false)).toBe(true)
  })
})

describe('resolveAdoptStartedAt', () => {
  test('记忆优先于 Date.now()，工具回来后计时叠加不从 0', () => {
    const origin = 1_000_000
    expect(resolveAdoptStartedAt(null, origin, Date.now())).toBe(origin)
    expect(resolveAdoptStartedAt(origin, 2, 3)).toBe(origin)
  })
})
