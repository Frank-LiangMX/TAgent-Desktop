// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '@tagent/ui'
import type { Channel } from '@tagent/shared'
import { AgentRuntimeSelector } from './AgentRuntimeSelector'

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

function channel(
  id: string,
  provider: Channel['provider'],
  enabled = true,
  modelEnabled = true,
): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: '',
    apiKey: '',
    models: [{ id: `${id}-model`, name: `${id} model`, enabled: modelEnabled }],
    defaultModelId: `${id}-model`,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  }
}

const KSCC = channel('kscc', 'kscc-internal')
const OPENAI = channel('openai', 'openai')
const CODEX = channel('codex', 'codex-internal')
const CODEX_API: Channel = { ...channel('codex-api', 'openai'), apiProtocol: 'openai-responses' }

function mount(
  overrides: Partial<React.ComponentProps<typeof AgentRuntimeSelector>> = {},
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        <AgentRuntimeSelector
          runtime="claude-code"
          channels={[KSCC]}
          onSelect={() => undefined}
          {...overrides}
        />
      </TooltipProvider>,
    )
  })
}

function openMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label^="选择主 Agent"]',
  )
  expect(trigger).not.toBeNull()
  act(() => trigger?.click())
}

function findItem(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.includes(label),
  )
}

describe('AgentRuntimeSelector', () => {
  test('触发器回显当前内核，弹层列出 Pi / Codex / Claude Code', () => {
    mount({ runtime: 'pi', channels: [OPENAI, CODEX, KSCC] })
    expect(document.body.textContent).toContain('Pi')
    openMenu()

    expect(document.body.textContent).toContain('主 Agent')
    expect(document.body.textContent).toContain('Codex')
    expect(document.body.textContent).toContain('Claude Code')
  })

  test('选中另一内核时回调（Codex 可用）', () => {
    const onSelect = vi.fn()
    mount({
      runtime: 'claude-code',
      channels: [KSCC, CODEX_API],
      onSelect,
      codexRuntimeStatus: { available: true, version: '0.151.0', managedInstallSupported: false },
    })
    openMenu()
    act(() => findItem('Codex')?.click())

    expect(onSelect).toHaveBeenCalledWith('codex')
  })

  test('未配置外部 API 渠道时明确提示，不静默改用其它内核', () => {
    mount({ runtime: 'claude-code', channels: [KSCC] })
    openMenu()

    expect(document.body.textContent).toContain('未配置可用的外部 API 渠道')
    expect(document.body.textContent).toContain('不会')
  })

  test('没有 API 渠道时目标内核仍可点击，由上层切换流程提示配置', () => {
    const onSelect = vi.fn()
    mount({ runtime: 'claude-code', channels: [KSCC], onSelect })
    openMenu()

    const codex = findItem('Codex')
    const claude = findItem('Claude Code')
    expect(codex?.disabled).toBe(false)
    expect(claude?.disabled).toBe(false)

    act(() => codex?.click())
    expect(onSelect).toHaveBeenCalledWith('codex')
  })

  test('Codex Runtime 已安装时说明外部 API 协议由适配层处理', () => {
    mount({
      runtime: 'claude-code',
      channels: [KSCC, OPENAI],
      codexRuntimeStatus: {
        available: true,
        version: '0.151.0',
        managedInstallSupported: false,
      },
    })
    openMenu()

    expect(document.body.textContent).toContain('API 协议自动适配')
  })

  test('运行中禁用选择（本切片要求先停止本轮）', () => {
    const onSelect = vi.fn()
    mount({ runtime: 'claude-code', channels: [KSCC, CODEX_API], busy: true, onSelect })
    openMenu()

    expect(document.body.textContent).toContain('请先停止')
    const codex = findItem('Codex')
    expect(codex?.disabled).toBe(true)
    act(() => codex?.click())
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('切换在途显示转圈并禁用入口', () => {
    mount({ runtime: 'claude-code', channels: [KSCC], pending: true })
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label^="选择主 Agent"]',
    )
    expect(trigger?.querySelector('.animate-spin')).not.toBeNull()
  })

  test('Codex Runtime 不可用且平台受支持时展示官方安装动作', () => {
    mount({
      runtime: 'claude-code',
      channels: [KSCC, CODEX],
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

  test('点击安装动作调用宿主回调', () => {
    const onInstallCodexRuntime = vi.fn()
    mount({
      runtime: 'claude-code',
      channels: [KSCC, CODEX],
      onInstallCodexRuntime,
      codexRuntimeStatus: {
        available: false,
        managedInstallSupported: true,
        managedVersion: '0.151.0',
        managedDownloadBytes: 147_584_554,
      },
    })
    openMenu()
    const installButton = findItem('安装 Codex Runtime')
    expect(installButton).toBeDefined()
    act(() => installButton?.click())

    expect(onInstallCodexRuntime).toHaveBeenCalledTimes(1)
  })
})
