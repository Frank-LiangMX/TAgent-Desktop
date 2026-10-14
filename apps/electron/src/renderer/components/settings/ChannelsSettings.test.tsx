// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { TooltipProvider } from '@tagent/ui'
import { channelsAtom, selectedModelSelectionAtom } from '../../atoms/channel-atoms'
import { ChannelsSettings } from './ChannelsSettings'
import type { Channel } from '@tagent/shared'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  getDefaultStore().set(channelsAtom, [])
  getDefaultStore().set(selectedModelSelectionAtom, null)
})

async function mount(credentialStatus: Channel['credentialStatus']) {
  const gateway: Channel = { id: 'kscc', provider: 'kscc-gateway', scope: 'internal', name: 'KSCC 网关', baseUrl: 'http://gateway.example', apiKey: '', credentialStatus,
    models: [{ id: 'glm-5.2', name: 'GLM', enabled: true }], enabled: true, createdAt: 1, updatedAt: 1 }
  vi.stubGlobal('electronAPI', { listChannels: vi.fn().mockResolvedValue([gateway]) })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root?.render(<TooltipProvider><ChannelsSettings /></TooltipProvider>))
}

it('shows automatic KSCC credential availability even with an empty stored key', async () => {
  await mount('ready')
  expect(document.body.textContent).toContain('本机凭据可用')
  expect(document.body.textContent).not.toContain('缺少凭据')
  expect(document.body.textContent).toContain('KSCC 网关')
  expect(document.body.textContent).toContain('内部服务')
  expect(document.body.textContent).toContain('外部服务')
  await act(async () => Array.from(document.querySelectorAll('button')).find((node) => node.textContent === '编辑')?.click())
  expect(document.body.textContent).toContain('管理内置服务的可用模型与启用状态')
  expect(document.body.textContent).not.toContain('服务地址')
})

it('shows a missing automatic credential separately from a saved-key state', async () => {
  await mount('missing')
  expect(document.body.textContent).toContain('未检测到内部凭据')
  expect(document.body.textContent).not.toContain('本机凭据可用')
})
