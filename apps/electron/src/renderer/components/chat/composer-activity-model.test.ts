import { describe, expect, it } from 'vitest'
import type { SessionBackgroundProcess } from '@tagent/shared'
import type { TaskCardState } from './subagent-ui-model'
import {
  collectComposerActivity,
  summarizeComposerActivity,
} from './composer-activity-model'

function proc(
  partial: Partial<SessionBackgroundProcess> & Pick<SessionBackgroundProcess, 'id' | 'command'>,
): SessionBackgroundProcess {
  return {
    sessionId: 's1',
    source: 'bash',
    startedAt: 1000,
    ...partial,
  }
}

function card(partial: Partial<TaskCardState> & Pick<TaskCardState, 'taskId'>): TaskCardState {
  return {
    description: '调研 diff',
    status: 'running',
    ...partial,
  }
}

describe('collectComposerActivity', () => {
  it('skips finished subagents and sorts by startedAt', () => {
    const items = collectComposerActivity({
      processes: [
        proc({ id: 'p2', command: 'kscc -p', startedAt: 2000, source: 'cli-worker' }),
        proc({ id: 'p1', command: '  bun run dev  ', startedAt: 1000 }),
      ],
      taskCards: [
        card({ taskId: 't-done', status: 'completed', startedAt: 500 }),
        card({ taskId: 't1', description: '审查 PR', toolUseId: 'tu1', startedAt: 1500 }),
      ],
    })
    expect(items.map((i) => i.id)).toEqual(['proc:p1', 'sub:t1', 'proc:p2'])
    expect(items[0]).toMatchObject({ kind: 'process', title: 'bun run dev', badge: '终端' })
    expect(items[1]).toMatchObject({ kind: 'subagent', title: '审查 PR', parentToolUseId: 'tu1' })
    expect(items[2]).toMatchObject({ badge: 'CLI', title: 'kscc -p' })
  })

  it('falls back when command / description empty', () => {
    const items = collectComposerActivity({
      processes: [proc({ id: 'p', command: '   ', startedAt: 1 })],
      taskCards: [card({ taskId: 't', description: '', lastToolName: 'Read', startedAt: 2 })],
    })
    expect(items[0]!.title).toBe('后台命令')
    expect(items[1]!.title).toBe('Read')
  })
})

describe('summarizeComposerActivity', () => {
  it('labels process-only / subagent-only / mixed', () => {
    const onlyProc = summarizeComposerActivity(
      collectComposerActivity({ processes: [proc({ id: 'a', command: 'x' })] }),
    )
    expect(onlyProc).toMatchObject({
      processCount: 1,
      subagentCount: 0,
      pillLabel: '1 终端',
      headerLabel: '1 终端运行中',
    })

    const onlySub = summarizeComposerActivity(
      collectComposerActivity({
        taskCards: [card({ taskId: 't', description: 'a' }), card({ taskId: 'u', description: 'b' })],
      }),
    )
    expect(onlySub).toMatchObject({
      processCount: 0,
      subagentCount: 2,
      pillLabel: '2 子代理',
      headerLabel: '2 子代理运行中',
    })

    const mixed = summarizeComposerActivity(
      collectComposerActivity({
        processes: [proc({ id: 'a', command: 'x' })],
        taskCards: [card({ taskId: 't', description: 'a' })],
      }),
    )
    expect(mixed).toMatchObject({
      pillLabel: '1 终端 · 1 子代理',
      headerLabel: '2 项运行中',
    })
  })

  it('empty', () => {
    expect(summarizeComposerActivity([])).toMatchObject({
      pillLabel: '',
      headerLabel: '0 项运行中',
      processCount: 0,
      subagentCount: 0,
    })
  })
})
