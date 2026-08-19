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
  classifyRunAbort,
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

describe('classifyRunAbort', () => {
  // 固定 now 便于窗口断言；real timestamps are absolute ms.
  const now = 100_000

  it('真用户停止 → stopped（优先于 AskUser 关窗窗口）', () => {
    // 即便刚关过 AskUser（1s 内），用户随后显式点 STOP 仍按 stopped
    expect(
      classifyRunAbort({
        userStopped: true,
        lastUserStopAt: 0,
        lastAskUserDismissAt: now - 1000,
        now,
        errorText: 'Request interrupted by user',
      }),
    ).toBe('stopped')
  })

  it('AskUser 关窗后短窗口内的迟到 interrupt → complete（非用户停止）', () => {
    expect(
      classifyRunAbort({
        userStopped: false,
        lastUserStopAt: 0,
        lastAskUserDismissAt: now - 1000, // 1s 前关窗，在 3s 窗口内
        now,
        errorText: 'Request interrupted by user',
      }),
    ).toBe('complete')
  })

  it('AskUser 关窗后短窗口内但文案是真错误（非 abort）→ error（真错误优先）', () => {
    expect(
      classifyRunAbort({
        userStopped: false,
        lastUserStopAt: 0,
        lastAskUserDismissAt: now - 500, // 刚关窗
        now,
        errorText: '已达最大工具循环轮次', // 非 abortLike 文案
      }),
    ).toBe('error')
  })

  it('AskUser 关窗超出 3s 窗口后的 interrupt → stopped（不再当关窗副作用）', () => {
    expect(
      classifyRunAbort({
        userStopped: false,
        lastUserStopAt: 0,
        lastAskUserDismissAt: now - 4000, // 4s 前，超出窗口
        now,
        errorText: 'Request interrupted by user',
      }),
    ).toBe('stopped')
  })

  it('上一轮用户停止 8s 窗口内迟到的 error → stopped（保持已中断语义）', () => {
    expect(
      classifyRunAbort({
        userStopped: false,
        lastUserStopAt: now - 5000, // 5s 前停过，在 8s 窗口内
        lastAskUserDismissAt: 0,
        now,
        errorText: '一些迟到错误',
      }),
    ).toBe('stopped')
  })

  it('无 abort 文案、无停止 / 关窗历史 → error（真错误抬错误条）', () => {
    expect(
      classifyRunAbort({
        userStopped: false,
        lastUserStopAt: 0,
        lastAskUserDismissAt: 0,
        now,
        errorText: '执行过程中出错',
      }),
    ).toBe('error')
  })

  it('abort 文案（用户取消）无停止 / 关窗历史 → stopped', () => {
    expect(
      classifyRunAbort({
        userStopped: false,
        lastUserStopAt: 0,
        lastAskUserDismissAt: 0,
        now,
        errorText: '用户取消了本次操作',
      }),
    ).toBe('stopped')
  })

  it('未关过 AskUser（lastAskUserDismissAt=0）时 interrupt → stopped', () => {
    expect(
      classifyRunAbort({
        userStopped: false,
        lastUserStopAt: 0,
        lastAskUserDismissAt: 0,
        now,
        errorText: 'aborted by user',
      }),
    ).toBe('stopped')
  })
})
