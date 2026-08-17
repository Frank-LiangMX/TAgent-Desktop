/**
 * 完成耗时持久化（backfillTurnDurations）单测
 *
 * 覆盖：从持久化 turnDurations（key = turn 最后主线 assistant createdAt）回填
 * 当前渲染 turn key；不匹配 / 空 persisted / 子代理消息不作为 key。
 */
import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import {
  backfillTurnDurations,
  groupItemsIntoTurns,
  resolveRunTurnKey,
  shouldRenderStoppedSyntheticShell,
  syntheticLiveTurnKeyForUser,
  type TurnSourceItem,
} from './session-turn-model'

function assistant(
  text: string,
  key: string,
  createdAt: number,
  parentToolUseId?: string,
): TurnSourceItem {
  return {
    key,
    message: {
      type: 'assistant',
      parentToolUseId,
      createdAt,
      content: [{ type: 'text', text }],
    } as TAgentMessage,
  }
}

function userInput(text: string, key: string, createdAt: number): TurnSourceItem {
  return {
    key,
    message: {
      type: 'user',
      createdAt,
      content: [{ type: 'text', text }],
    } as TAgentMessage,
  }
}

describe('backfillTurnDurations', () => {
  it('maps persisted createdAt → current turn key with endedBy', () => {
    const items: TurnSourceItem[] = [
      userInput('第一轮', 'u1', 1000),
      assistant('回答一', 'a1', 2000),
      userInput('第二轮', 'u2', 3000),
      assistant('回答二', 'a2', 4000),
    ]
    const backfilled = backfillTurnDurations(items, {
      4000: { ms: 1234, endedBy: 'stopped' },
    })
    // 第二轮的最后主线 assistant createdAt=4000 → turn key 匹配
    expect(Object.values(backfilled)).toEqual([{ ms: 1234, endedBy: 'stopped' }])
    expect(Object.keys(backfilled)[0]).toContain('turn-')
  })

  it('matches each persisted turn independently', () => {
    const items: TurnSourceItem[] = [
      userInput('第一轮', 'u1', 1000),
      assistant('回答一', 'a1', 2000),
      userInput('第二轮', 'u2', 3000),
      assistant('回答二', 'a2', 4000),
    ]
    const backfilled = backfillTurnDurations(items, {
      2000: { ms: 500, endedBy: 'complete' },
      4000: { ms: 900, endedBy: 'error' },
    })
    const values = Object.values(backfilled)
    expect(values).toEqual([
      { ms: 500, endedBy: 'complete' },
      { ms: 900, endedBy: 'error' },
    ])
  })

  it('returns empty when nothing matches or persisted is empty', () => {
    const items: TurnSourceItem[] = [
      userInput('第一轮', 'u1', 1000),
      assistant('回答一', 'a1', 2000),
    ]
    expect(backfillTurnDurations(items, undefined)).toEqual({})
    expect(backfillTurnDurations(items, {})).toEqual({})
    expect(backfillTurnDurations(items, { 999: { ms: 100, endedBy: 'complete' } })).toEqual({})
  })

  it('ignores subagent messages as turn anchors', () => {
    const items: TurnSourceItem[] = [
      userInput('第一轮', 'u1', 1000),
      // 子代理消息（parentToolUseId）不作为 anchor，主线 assistant createdAt=5000 才是
      assistant('子代理过程', 's1', 3000, 'call_1'),
      assistant('回答一', 'a1', 5000),
    ]
    const backfilled = backfillTurnDurations(items, {
      3000: { ms: 111, endedBy: 'stopped' },
      5000: { ms: 222, endedBy: 'complete' },
    })
    expect(Object.values(backfilled)).toEqual([{ ms: 222, endedBy: 'complete' }])
  })
})

describe('resolveRunTurnKey', () => {
  it('uses synthetic live key when run active after user send', () => {
    const turns = groupItemsIntoTurns([
      userInput('你好', 'u1', 1000),
      assistant('回答', 'a1', 2000),
      userInput('再试', 'u2', 3000),
    ])
    expect(resolveRunTurnKey(turns, 'sess-1', true)).toBe(syntheticLiveTurnKeyForUser('u2'))
  })

  it('uses last assistant turn when run active on assistant tail', () => {
    const turns = groupItemsIntoTurns([
      userInput('你好', 'u1', 1000),
      assistant('回答', 'a1', 2000),
    ])
    const assistantKey = turns.find((t) => t.kind === 'assistant-turn')!.key
    expect(resolveRunTurnKey(turns, 'sess-1', true)).toBe(assistantKey)
  })
})

describe('shouldRenderStoppedSyntheticShell', () => {
  it('renders shell after user when synthetic duration exists and no assistant follow-up', () => {
    const turns = groupItemsIntoTurns([
      userInput('第一轮', 'u1', 1000),
      assistant('回答', 'a1', 2000),
      userInput('第二轮', 'u2', 3000),
    ])
    const syntheticKey = syntheticLiveTurnKeyForUser('u2')
    const durations = { [syntheticKey]: { ms: 7000, endedBy: 'stopped' as const } }
    expect(shouldRenderStoppedSyntheticShell(turns, 2, durations)).toBe(true)
    expect(shouldRenderStoppedSyntheticShell(turns, 0, durations)).toBe(false)
  })

  it('skips shell when assistant turn already exists for that user round', () => {
    const turns = groupItemsIntoTurns([
      userInput('你好', 'u1', 1000),
      assistant('部分回答', 'a1', 2000),
    ])
    const syntheticKey = syntheticLiveTurnKeyForUser('u1')
    const durations = { [syntheticKey]: { ms: 500, endedBy: 'stopped' as const } }
    expect(shouldRenderStoppedSyntheticShell(turns, 0, durations)).toBe(false)
  })
})
