import { describe, expect, it } from 'vitest'
import type { SessionBackgroundProcess } from '@tagent/shared'
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

describe('collectComposerActivity', () => {
  it('only lists background processes, sorted by startedAt', () => {
    const items = collectComposerActivity({
      processes: [
        proc({ id: 'p2', command: 'kscc -p', startedAt: 2000, source: 'cli-worker' }),
        proc({ id: 'p1', command: '  bun run dev  ', startedAt: 1000 }),
      ],
    })
    expect(items.map((i) => i.id)).toEqual(['proc:p1', 'proc:p2'])
    expect(items[0]).toMatchObject({ kind: 'process', title: 'bun run dev', badge: '终端' })
    expect(items[1]).toMatchObject({ badge: 'CLI', title: 'kscc -p' })
  })

  it('falls back when command empty', () => {
    const items = collectComposerActivity({
      processes: [proc({ id: 'p', command: '   ', startedAt: 1 })],
    })
    expect(items[0]!.title).toBe('后台命令')
  })
})

describe('summarizeComposerActivity', () => {
  it('labels terminal-only / cli-only / mixed', () => {
    const onlyProc = summarizeComposerActivity(
      collectComposerActivity({ processes: [proc({ id: 'a', command: 'x' })] }),
    )
    expect(onlyProc).toMatchObject({
      processCount: 1,
      terminalCount: 1,
      cliCount: 0,
      pillLabel: '1 终端',
      headerLabel: '1 终端运行中',
    })

    const onlyCli = summarizeComposerActivity(
      collectComposerActivity({
        processes: [proc({ id: 'c', command: 'kscc', source: 'cli-worker' })],
      }),
    )
    expect(onlyCli).toMatchObject({
      processCount: 1,
      terminalCount: 0,
      cliCount: 1,
      pillLabel: '1 CLI',
      headerLabel: '1 CLI 运行中',
    })

    const mixed = summarizeComposerActivity(
      collectComposerActivity({
        processes: [
          proc({ id: 'a', command: 'x' }),
          proc({ id: 'c', command: 'kscc', source: 'cli-worker' }),
        ],
      }),
    )
    expect(mixed).toMatchObject({
      pillLabel: '1 终端 · 1 CLI',
      headerLabel: '2 项后台运行中',
    })
  })

  it('empty', () => {
    expect(summarizeComposerActivity([])).toMatchObject({
      pillLabel: '',
      headerLabel: '0 项后台运行中',
      processCount: 0,
      terminalCount: 0,
      cliCount: 0,
    })
  })
})
