import { act, render, screen } from '@testing-library/react'
import { getFileExistsCache } from '@tagent/shared'
import { TooltipProvider } from '@tagent/ui'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { FilePathChip, clearFilePathMissingCache } from '../index'

/**
 * 回归：流式期间同一条消息会反复重挂载，chip 曾在 resolved / broken 之间来回跳，
 * 用户看到的现象就是「文件不存在」一闪一闪。这里锁住状态迁移只能单向收敛。
 */

const BASES = ['/repo']

function renderChip(
  filePath: string,
  onResolveFile: (path: string, bases?: string[]) => Promise<string | null>,
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <FilePathChip filePath={filePath} basePaths={BASES} onResolveFile={onResolveFile} />
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

/** 越过「首次未命中后的复查延迟」 */
async function passRecheckDelay(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
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
  test('首次未命中不判定 broken，复查仍未命中才判定', async () => {
    const onResolveFile = vi.fn().mockResolvedValue(null)

    renderChip('src/missing.ts', onResolveFile)
    await flush()

    expect(status()).toBe('checking')
    expect(onResolveFile).toHaveBeenCalledTimes(1)

    await passRecheckDelay()

    expect(status()).toBe('broken')
    expect(onResolveFile).toHaveBeenCalledTimes(2)
  })

  test('文件在复查时才落盘：直接收敛到 resolved，全程不闪 broken', async () => {
    const onResolveFile = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('/repo/src/late.ts')

    renderChip('src/late.ts', onResolveFile)
    await flush()

    expect(status()).toBe('checking')

    await passRecheckDelay()

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
    await passRecheckDelay()
    expect(status()).toBe('broken')

    view.unmount()
    renderChip('src/gone.ts', onResolveFile)

    expect(status()).toBe('broken')
  })

  test('负结论不锁死：文件后来出现时重挂载会升级为 resolved', async () => {
    const onResolveFile = vi.fn().mockResolvedValue(null)

    const view = renderChip('src/pending.ts', onResolveFile)
    await flush()
    await passRecheckDelay()
    expect(status()).toBe('broken')

    view.unmount()
    onResolveFile.mockResolvedValue('/repo/src/pending.ts')
    renderChip('src/pending.ts', onResolveFile)
    await flush()

    expect(status()).toBe('resolved')
  })
})
