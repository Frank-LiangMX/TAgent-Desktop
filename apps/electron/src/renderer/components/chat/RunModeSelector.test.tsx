// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '@tagent/ui'
import { RunModeSelector } from './RunModeSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = undefined
  }
  container?.remove()
  container = undefined
  document.body.innerHTML = ''
})

function mount(
  overrides: Partial<React.ComponentProps<typeof RunModeSelector>> = {},
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        <RunModeSelector
          executionMode="work"
          onExecutionModeChange={() => undefined}
          permissionMode="auto"
          onPermissionModeChange={() => undefined}
          subagentEagerness="conservative"
          onSubagentEagernessChange={() => undefined}
          showInternalBackend
          internalBackend="kscc"
          onInternalBackendChange={() => undefined}
          {...overrides}
        />
      </TooltipProvider>,
    )
  })
}

function openMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label^="运行模式："]',
  )
  expect(trigger).not.toBeNull()
  act(() => trigger?.click())
}

describe('RunModeSelector Codex Runtime install action', () => {
  test('Runtime 不可用且当前平台受支持时展示官方安装动作', () => {
    mount({
      codexRuntimeStatus: {
        available: false,
        reason: '系统 PATH 中未找到 codex',
        managedInstallSupported: true,
        managedVersion: '0.151.0',
        managedDownloadBytes: 147_584_554,
      },
    })
    openMenu()

    expect(document.body.textContent).toContain('安装 Codex Runtime')
    expect(document.body.textContent).toContain('官方 0.151.0')
    expect(document.body.textContent).toContain('约 141 MB')
  })

  test('点击安装动作调用主会话安装回调', () => {
    const onInstallCodexRuntime = vi.fn()
    mount({
      codexRuntimeStatus: {
        available: false,
        managedInstallSupported: true,
        managedVersion: '0.151.0',
        managedDownloadBytes: 147_584_554,
      },
      onInstallCodexRuntime,
    })
    openMenu()
    const installButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('安装 Codex Runtime'))
    expect(installButton).toBeDefined()
    act(() => installButton?.click())
    expect(onInstallCodexRuntime).toHaveBeenCalledTimes(1)
  })
})
