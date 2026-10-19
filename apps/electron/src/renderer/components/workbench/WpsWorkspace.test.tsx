// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WpsPublicConfig, WpsUserAuthState } from '@tagent/shared'
import { WpsWorkspace } from './WpsWorkspace'

let root: Root, container: HTMLDivElement
let authListener: (state: WpsUserAuthState) => void
let config: WpsPublicConfig
const auth: WpsUserAuthState = { loggedIn: true, userId: 'synthetic-me', userName: '测试用户' }
const mockApi = {
  getWpsConfig: vi.fn(), saveWpsConfig: vi.fn(), getWpsUserAuth: vi.fn(), loginWpsUser: vi.fn(), logoutWpsUser: vi.fn(),
  listWpsReportChats: vi.fn(), collectWpsDaily: vi.fn(), createWpsDailyReport: vi.fn(), listAutomations: vi.fn(), toggleAutomation: vi.fn(),
  listChannels: vi.fn(), onWpsUserAuthChanged: vi.fn(),
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  config = { available: true, reportScope: { includeChats: true, includeDocuments: false, chatIds: [] } }
  mockApi.getWpsConfig.mockImplementation(async () => config)
  mockApi.getWpsUserAuth.mockResolvedValue(auth)
  mockApi.listAutomations.mockResolvedValue([])
  mockApi.listChannels.mockResolvedValue([
    { id: 'legacy', name: '旧本机渠道', provider: 'codex-internal', enabled: true, models: [{ id: 'native', name: '旧模型', enabled: true }] },
    { id: 'channel', name: '测试渠道', provider: 'custom', enabled: true, defaultModelId: 'model', models: [{ id: 'model', name: '测试模型', enabled: true }] },
  ])
  mockApi.onWpsUserAuthChanged.mockImplementation(listener => { authListener = listener; return () => {} })
  mockApi.saveWpsConfig.mockImplementation(async input => { config = { ...config, ...input }; return config })
  mockApi.createWpsDailyReport.mockResolvedValue({ id: 'synthetic-report' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = mockApi
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function render(): Promise<void> { await act(async () => { root.render(<WpsWorkspace />) }) }
function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  if (!element) throw new Error(`button missing: ${text}`)
  return element
}
async function click(text: string): Promise<void> { await act(async () => button(text).click()) }

describe('WPS settings user workflows with isolated data', () => {
  it('requests document creation authorization explicitly and displays the granted capability', async () => {
    mockApi.loginWpsUser.mockResolvedValue({ ...auth, loading: true })
    await render()
    expect(mockApi.loginWpsUser).not.toHaveBeenCalled()
    await click('授权创建云文档')
    expect(mockApi.loginWpsUser).toHaveBeenCalledWith(true)
    await act(async () => authListener({ ...auth, canCreateDocuments: true }))
    expect(container.textContent).toContain('已授权创建云文档')
    expect(container.textContent).toContain('MCP/智能文档')
    expect([...container.querySelectorAll('button')].some(item => item.textContent === '授权创建云文档')).toBe(false)
  })
  it('shows auth state and never starts authorization, collection or daily jobs on mount', async () => {
    mockApi.getWpsUserAuth.mockResolvedValue({ loggedIn: false })
    await render()
    expect(container.textContent).toContain('尚未连接 WPS')
    expect(container.textContent).not.toMatch(/APPID|APPKEY|回调端口|开放平台应用配置/)
    expect(button('连接 WPS').disabled).toBe(false)
    expect(container.textContent).toContain('AI 渠道（HTTP · Pi）')
    expect(button('验证今日采集').disabled).toBe(true)
    expect(button('启用每日工作日报').disabled).toBe(true)
    expect(mockApi.loginWpsUser).not.toHaveBeenCalled()
    expect(mockApi.createWpsDailyReport).not.toHaveBeenCalled()
    expect(mockApi.collectWpsDaily).not.toHaveBeenCalled()
  })
  it('verifies collection on demand and makes partial data visible', async () => {
    mockApi.collectWpsDaily.mockResolvedValue({ date: '2026-10-09', ownMessageCount: 4, documentCount: 2, complete: false, warnings: ['测试：一个会话缺少读取权限'] })
    await render(); await click('验证今日采集')
    expect(container.textContent).toContain('本人消息 4 条')
    expect(container.textContent).toContain('采集存在缺口')
    expect(container.textContent).toContain('测试：一个会话缺少读取权限')
  })
  it('requires saving changed context scope before enabling a daily job', async () => {
    mockApi.listWpsReportChats.mockResolvedValue([{ id: 'synthetic-chat', title: '测试项目群' }])
    await render(); await click('选择会话')
    const label = [...container.querySelectorAll('label')].find(item => item.textContent === '测试项目群')!
    await act(async () => (label.querySelector('input') as HTMLInputElement).click())
    expect(button('启用每日工作日报').disabled).toBe(true)
    await click('保存采集范围')
    expect(mockApi.saveWpsConfig).toHaveBeenCalledWith({ reportScope: { includeChats: true, includeDocuments: false, chatIds: ['synthetic-chat'] } })
    expect(button('启用每日工作日报').disabled).toBe(false)
    await click('启用每日工作日报')
    expect(mockApi.createWpsDailyReport).toHaveBeenCalledWith({ channelId: 'channel', modelId: 'model', timeOfDay: '18:00' })
  })
  it('immediately disables collection when the account is disconnected', async () => {
    await render()
    await act(async () => authListener({ loggedIn: false }))
    expect(button('验证今日采集').disabled).toBe(true)
    expect(button('启用每日工作日报').disabled).toBe(true)
  })
  it('surfaces backend errors without reporting success', async () => {
    mockApi.collectWpsDaily.mockRejectedValue(new Error('测试：授权已过期'))
    await render(); await click('验证今日采集')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('测试：授权已过期')
    expect(container.textContent).not.toContain('采集完成')
  })
  it('opens authorization on one click without requiring application credentials', async () => {
    mockApi.getWpsUserAuth.mockResolvedValue({ loggedIn: false })
    mockApi.loginWpsUser.mockResolvedValue({ loggedIn: false, loading: true })
    await render(); await click('连接 WPS')
    expect(mockApi.loginWpsUser).toHaveBeenCalledOnce()
    expect(mockApi.saveWpsConfig).not.toHaveBeenCalled()
    expect(container.textContent).toContain('请在 WPS 网页完成登录和授权')
    await act(async () => authListener(auth))
    expect(container.textContent).toContain('已连接 · 测试用户')
  })
  it('makes an unavailable application connection explicit without asking users to configure keys', async () => {
    config.available = false
    mockApi.getWpsUserAuth.mockResolvedValue({ loggedIn: false })
    mockApi.loginWpsUser.mockRejectedValue(new Error('应用尚未开通 WPS 登录，请联系应用管理员。'))
    await render()
    expect(button('连接 WPS').disabled).toBe(false)
    expect(container.textContent).toContain('WPS 登录组件未准备好')
    expect(container.querySelector('input[type="password"]')).toBeNull()
    await click('连接 WPS')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('应用尚未开通 WPS 登录')
  })
})
