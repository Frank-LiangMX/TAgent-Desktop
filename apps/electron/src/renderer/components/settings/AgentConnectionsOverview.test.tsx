// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { TooltipProvider } from '@tagent/ui'
import type { Channel } from '@tagent/shared'
import { AgentConnectionsOverview } from './AgentConnectionsOverview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function channel(provider: Channel['provider'], modelId = 'model'): Channel {
  return { id: provider, name: provider, provider, baseUrl: '', apiKey: 'SECRET-NEVER-RENDER',
    enabled: true, models: [{ id: modelId, name: modelId, enabled: true }], createdAt: 1, updatedAt: 1 }
}

async function mount(overrides = {}) {
  const api = {
    listChannels: vi.fn().mockResolvedValue([]),
    getCodexRuntimeStatus: vi.fn().mockResolvedValue({ available: false, managedInstallSupported: true }),
    ...overrides,
  }
  vi.stubGlobal('electronAPI', api)
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const navigate = vi.fn()
  await act(async () => root?.render(<TooltipProvider><AgentConnectionsOverview onNavigate={navigate} /></TooltipProvider>))
  return { api, navigate }
}

test('empty setup explains next step and routes to channels or subagents', async () => {
  const { navigate } = await mount()
  expect(document.body.textContent).toContain('尚未启用渠道')
  expect(document.body.textContent).toContain('所有模型通过 HTTP(S) 渠道接入')
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="配置 Pi 接入"]')?.click())
  expect(navigate).toHaveBeenLastCalledWith('channels')
  const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === '配置子代理')
  act(() => button?.click())
  expect(navigate).toHaveBeenLastCalledWith('agent-cli')
})

test('distinguishes configured models, executable availability, and unverified login without secrets', async () => {
  const { api } = await mount({
    listChannels: vi.fn().mockResolvedValue([channel('openai'), channel('codex-internal'), channel('kscc-internal')]),
    getCodexRuntimeStatus: vi.fn().mockResolvedValue({ available: true, managedInstallSupported: true }),
  })
  expect(document.querySelector('[aria-label="Pi"]')?.textContent).toContain('1 个渠道 · 1 个模型已启用')
  expect(document.querySelector('[aria-label="Codex"]')).toBeNull()
  expect(api.getCodexRuntimeStatus).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-label="Claude Code"]')).toBeNull()
  expect(document.body.textContent).not.toContain('SECRET-NEVER-RENDER')
})

test('virtual MOA models and disabled channels are not counted as main runtime targets', async () => {
  await mount({ listChannels: vi.fn().mockResolvedValue([
    channel('openai', 'moa:roundtable'), { ...channel('custom'), enabled: false },
  ]) })
  expect(document.querySelector('[aria-label="Pi"]')?.textContent).toContain('尚未启用渠道或模型')
  expect(document.body.textContent).not.toContain('个模型已启用')
})

test('failed independent probes allow retry and do not report ready', async () => {
  const listChannels = vi.fn().mockRejectedValueOnce(new Error('private detail')).mockResolvedValue([channel('openai')])
  const getCodexRuntimeStatus = vi.fn().mockRejectedValue(new Error('probe failed'))
  await mount({ listChannels, getCodexRuntimeStatus })
  expect(document.body.textContent).toContain('渠道读取失败，请重新检测')
  expect(getCodexRuntimeStatus).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('private detail')
  await act(async () => Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.includes('重新检测'))?.click())
  expect(document.querySelector('[aria-label="Pi"]')?.textContent).toContain('1 个渠道 · 1 个模型已启用')
  expect(document.body.textContent).not.toContain('已找到本机程序')
})

test('slow previous probe cannot overwrite refreshed results', async () => {
  let finish!: (value: Channel[]) => void
  const listChannels = vi.fn().mockImplementationOnce(() => new Promise<Channel[]>((resolve) => { finish = resolve }))
    .mockResolvedValue([channel('openai')])
  await mount({ listChannels })
  await act(async () => Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.includes('重新检测'))?.click())
  await act(async () => finish([]))
  expect(document.querySelector('[aria-label="Pi"]')?.textContent).toContain('1 个渠道 · 1 个模型已启用')
})
