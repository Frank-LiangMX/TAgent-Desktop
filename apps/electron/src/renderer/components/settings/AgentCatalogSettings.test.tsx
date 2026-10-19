// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentCatalogSettings, compatibleProfileChannels, profileBindingError, profileConfigurationError } from './AgentCatalogSettings'
import type { Channel } from '@tagent/shared'

vi.mock('./AgentConnectionsOverview', () => ({
  AgentConnectionsOverview: ({ onNavigate }: { onNavigate: (tab: 'channels' | 'agent-cli') => void }) => (
    <section aria-label="接入概览">
      <button onClick={() => onNavigate('channels')}>前往渠道设置</button>
      <p>主会话接入概览</p>
    </section>
  ),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi-review', name: '审查员', description: '', runtime: 'pi', enabled: true,
    builtIn: false, channelId: 'old-channel', modelId: 'old-model', systemPrompt: '',
    permissionProfile: 'read-only', workspacePolicy: 'inherit', allowPiTask: true,
    allowBackground: false, approvalRequired: true, tools: [],
    skills: [], mcpServers: [], ...overrides,
  }
}

async function mount(api: Record<string, unknown>) {
  vi.stubGlobal('electronAPI', api)
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const navigate = vi.fn()
  await act(async () => root?.render(<AgentCatalogSettings onNavigate={navigate} />))
  return { navigate }
}

describe('AgentCatalogSettings', () => {
  test('overview remains usable while profile load fails; retry recovers and advanced editor stays collapsed', async () => {
    const listAgentProfiles = vi.fn().mockRejectedValueOnce(new Error('private backend detail')).mockResolvedValue([profile()])
    const { navigate } = await mount({
      listAgentProfiles, listChannels: vi.fn().mockResolvedValue([]), saveAgentProfiles: vi.fn(),
    })
    expect(document.body.textContent).toContain('Agent 接入')
    expect(document.body.textContent).toContain('主会话接入概览')
    expect(document.body.textContent).not.toContain('private backend detail')
    act(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '前往渠道设置')?.click())
    expect(navigate).toHaveBeenCalledWith('channels')
    const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '重试')
    await act(async () => retry?.click())
    const details = document.querySelector('details')
    expect(details?.open).toBe(false)
    expect(document.body.textContent).toContain('不会改变主会话的运行内核或角色配置')
  })

  test('channel and model edits save explicitly, preserve unknown fields, and guard navigation with confirmation', async () => {
    const saveAgentProfiles = vi.fn().mockImplementation(async (profiles) => profiles)
    const confirm = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirm)
    const { navigate } = await mount({
      listAgentProfiles: vi.fn().mockResolvedValue([profile()]),
      listChannels: vi.fn().mockResolvedValue([{
        id: 'enabled', name: '可用渠道', provider: 'openai', baseUrl: '', apiKey: 'never-display',
        enabled: true, models: [{ id: 'model-1', name: '可用模型', enabled: true }], createdAt: 1, updatedAt: 1,
      }]),
      saveAgentProfiles,
    })
    expect(document.querySelector('details')?.open).toBe(false)
    act(() => { document.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const editorButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('编辑'))
    act(() => editorButton?.click())
    expect(document.body.textContent).toContain('已保存：old-channel（协议不兼容或当前不可用）')
    expect(document.body.textContent).toContain('已保留原值：old-model（当前不可用）')
    expect(document.body.textContent).toContain('绑定属于此预设并优先于任务临时选择')
    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'))
    act(() => {
      const select = selects[1]
      if (!select) throw new Error('Missing channel selector')
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'enabled')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => Promise.resolve())
    const modelSelect = Array.from(document.querySelectorAll<HTMLSelectElement>('select'))[2]
    act(() => {
      if (!modelSelect) throw new Error('Missing model selector')
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(modelSelect, 'model-1')
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '前往渠道设置')?.click())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    act(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '前往渠道设置')?.click())
    expect(navigate).toHaveBeenCalledWith('channels')
    const save = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('保存'))
    await act(async () => save?.click())
    expect(saveAgentProfiles).toHaveBeenCalledTimes(1)
    expect(saveAgentProfiles.mock.calls[0]?.[0][0]).toMatchObject({
      name: '审查员', channelId: 'enabled', modelId: 'model-1',
      skills: [], mcpServers: [],
    })
    expect(document.body.textContent).not.toContain('never-display')
  })

  test('a late retry response cannot replace the newer retry result', async () => {
    let finishOld!: (value: ReturnType<typeof profile>[]) => void
    let finishNew!: (value: ReturnType<typeof profile>[]) => void
    const listAgentProfiles = vi.fn()
      .mockRejectedValueOnce(new Error('initial error'))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof profile>[]>((resolve) => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof profile>[]>((resolve) => { finishNew = resolve }))
    await mount({ listAgentProfiles, listChannels: vi.fn().mockResolvedValue([]), saveAgentProfiles: vi.fn() })
    const retry = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '重试')
    const firstRetry = retry()
    expect(firstRetry).toBeDefined()
    act(() => {
      firstRetry?.click()
      firstRetry?.click()
    })
    await act(async () => finishNew([profile({ name: '新结果' })]))
    await act(async () => finishOld([profile({ name: '旧结果' })]))
    expect(document.body.textContent).toContain('新结果')
    expect(document.body.textContent).not.toContain('旧结果')
  })

  test('shared protocol compatibility offers every HTTP protocol to Codex and Claude Code bindings', () => {
    const channels: Channel[] = [
      { id: 'responses', name: 'Responses', provider: 'openai', apiProtocol: 'openai-responses', baseUrl: '', apiKey: '', enabled: true, models: [{ id: 'r', name: 'r', enabled: true }], createdAt: 1, updatedAt: 1 },
      { id: 'messages', name: 'Messages', provider: 'anthropic', apiProtocol: 'anthropic-messages', baseUrl: '', apiKey: '', enabled: true, models: [{ id: 'm', name: 'm', enabled: true }], createdAt: 1, updatedAt: 1 },
      { id: 'chat', name: 'Chat', provider: 'openai', apiProtocol: 'openai-chat', baseUrl: '', apiKey: '', enabled: true, models: [{ id: 'c', name: 'c', enabled: true }], createdAt: 1, updatedAt: 1 },
    ]
    // 官方内核在宿主边界做协议适配：三种 HTTP 协议渠道均可绑定（ADR-0012）
    expect(compatibleProfileChannels(channels, 'pi').map((channel) => channel.id)).toEqual([
      'responses',
      'messages',
      'chat',
    ])
    expect(compatibleProfileChannels(channels, 'claude-code')).toEqual(channels)
    expect(compatibleProfileChannels(channels, 'codex')).toEqual(channels)
    expect(profileBindingError({ runtime: 'codex', channelId: 'chat', modelId: 'c' }, channels)).toBeNull()
    expect(profileBindingError({ runtime: 'claude-code', channelId: 'responses', modelId: 'r' }, channels)).toBeNull()
    expect(profileBindingError({ runtime: 'pi', channelId: 'chat', modelId: 'c' }, channels)).toBeNull()
  })

  test('unsupported temporary workspace is rejected without silently changing binding', () => {
    expect(profileConfigurationError({ runtime: 'pi', channelId: '', modelId: '', workspacePolicy: 'temporary', workspacePath: undefined }, [])).toContain('暂不支持')
    expect(profileBindingError({ runtime: 'pi', channelId: 'responses', modelId: 'gone' }, [{
      id: 'responses', name: 'Responses', provider: 'openai', apiProtocol: 'openai-responses', baseUrl: '', apiKey: '', enabled: true, models: [], createdAt: 1, updatedAt: 1,
    }])).toContain('模型不存在')
    expect(profileBindingError({ runtime: 'pi', channelId: 'responses', modelId: '' }, [{
      id: 'responses', name: 'Responses', provider: 'openai', apiProtocol: 'openai-responses', baseUrl: '', apiKey: '', enabled: true, models: [], createdAt: 1, updatedAt: 1,
    }])).toContain('同时选择渠道和模型')
    expect(profileConfigurationError({ runtime: 'codex', channelId: '', modelId: '', workspacePolicy: 'inherit', skills: ['legacy'], mcpServers: [], tools: [] }, [])).toContain('skills / MCP')
    expect(profileConfigurationError({ runtime: 'codex', channelId: '', modelId: '', workspacePolicy: 'inherit', skills: [], mcpServers: [], tools: ['Read'] }, [])).toContain('tools 白名单')
    expect(profileConfigurationError({ runtime: 'pi', channelId: '', modelId: '', workspacePolicy: 'inherit', skills: [], mcpServers: [], tools: ['Read'] }, [])).toBeNull()
  })
})
