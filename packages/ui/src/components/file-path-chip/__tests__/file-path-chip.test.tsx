import { act, render, screen } from '@testing-library/react'
import { getFileExistsCache } from '@tagent/shared'
import { TooltipProvider } from '@tagent/ui'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { FilePathChip, clearFilePathMissingCache } from '../index'

/**
 * 回归：流式期间同一条消息会反复重挂载，chip 曾在 resolved / broken 之间来回跳，
 * 用户看到的现象就是「文件不存在」一闪一闪。这里锁住状态迁移只能单向收敛。
 * 流式中禁止写 broken（回答区逐字输出会提前挂 chip，文件常尚未落盘）。
 */

const BASES = ['/repo']

function renderChip(
  filePath: string,
  onResolveFile: (path: string, bases?: string[]) => Promise<string | null>,
  opts?: { streaming?: boolean },
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <FilePathChip
        filePath={filePath}
        basePaths={BASES}
        onResolveFile={onResolveFile}
        streaming={opts?.streaming}
      />
    </TooltipProvider>,
  )
}

function status(): string | null {
  return screen.getByRole('button').getAttribute('data-file-status')
}

/** 冲掉 IntersectionObserver 回调里那条已发出的 resolve promise */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** 越过非流式加长复查（400+1200+2500） */
async function passPostStreamRechecks(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  getFileExistsCache().clear()
  clearFilePathMissingCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('FilePathChip 存在性状态', () => {
  test('首次未命中不判定 broken，多次复查仍未命中才判定', async () => {
    const onResolveFile = vi.fn().mockResolvedValue(null)

    renderChip('src/missing.ts', onResolveFile)
    await flush()

    expect(status()).toBe('checking')
    expect(onResolveFile).toHaveBeenCalledTimes(1)

    await passPostStreamRechecks()

    expect(status()).toBe('broken')
    expect(onResolveFile.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test('文件在复查时才落盘：直接收敛到 resolved，全程不闪 broken', async () => {
    const onResolveFile = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('/repo/src/late.ts')

    renderChip('src/late.ts', onResolveFile)
    await flush()

    expect(status()).toBe('checking')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(status()).toBe('resolved')
  })

  test('已解析成功的路径重挂载后立即 resolved，且不再打 IPC', async () => {
    const onResolveFile = vi.fn().mockResolvedValue('/repo/src/exists.ts')

    const view = renderChip('src/exists.ts', onResolveFile)
    await flush()
    expect(status()).toBe('resolved')

    view.unmount()
    onResolveFile.mockClear()
    renderChip('src/exists.ts', onResolveFile)

    expect(status()).toBe('resolved')
    expect(onResolveFile).not.toHaveBeenCalled()
  })

  test('已确认不存在的路径重挂载后仍是 broken，不先闪回正常态', async () => {
    const onResolveFile = vi.fn().mockResolvedValue(null)

    const view = renderChip('src/gone.ts', onResolveFile)
    await flush()
    await passPostStreamRechecks()
    expect(status()).toBe('broken')

    view.unmount()
    renderChip('src/gone.ts', onResolveFile)

    expect(status()).toBe('broken')
  })

  test('负结论不锁死：文件后来出现时重挂载会升级为 resolved', async () => {
    const onResolveFile = vi.fn().mockResolvedValue(null)

    const view = renderChip('src/pending.ts', onResolveFile)
    await flush()
    await passPostStreamRechecks()
    expect(status()).toBe('broken')

    view.unmount()
    onResolveFile.mockResolvedValue('/repo/src/pending.ts')
    renderChip('src/pending.ts', onResolveFile)
    await flush()

    expect(status()).toBe('resolved')
  })

  test('流式中多次未命中也不标 broken（不写负缓存）', async () => {
    const onResolveFile = vi.fn().mockResolvedValue(null)

    renderChip('src/streaming.ts', onResolveFile, { streaming: true })
    await flush()
    expect(status()).toBe('checking')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    })

    expect(status()).not.toBe('broken')
    expect(status()).toBe('checking')
  })

  test('流式结束且文件已落盘 → 最终裁决为 resolved', async () => {
    const onResolveFile = vi.fn().mockResolvedValue(null)

    const view = renderChip('src/appear.ts', onResolveFile, { streaming: true })
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(status()).not.toBe('broken')

    onResolveFile.mockResolvedValue('/repo/src/appear.ts')
    view.rerender(
      <TooltipProvider>
        <FilePathChip
          filePath="src/appear.ts"
          basePaths={BASES}
          onResolveFile={onResolveFile}
          streaming={false}
        />
      </TooltipProvider>,
    )
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(status()).toBe('resolved')
  })
})
