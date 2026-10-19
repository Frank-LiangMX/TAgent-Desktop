// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '@tagent/shared'
import { AutomationMainView } from './AutomationMainView'

vi.mock('../settings/AutomationSettings', () => ({ AutomationSettings: () => null }))
vi.mock('@tagent/ui', () => ({ DestructiveConfirmDialog: () => null }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
import { toast } from 'sonner'
let root: Root, container: HTMLDivElement
const task = { id: 'task-1', name: '整理今日日报', prompt: '整理并保存到 WPS', enabled: true,
  scheduleType: 'daily', timeOfDay: '09:00', intervalMinutes: 1440, channelId: 'test', createdAt: 0,
  updatedAt: 0, nextRunAt: Date.now() + 86400_000, runHistory: [] } as Automation
const api = { listAutomations: vi.fn(), runAutomationNow: vi.fn(), toggleAutomation: vi.fn(), deleteAutomation: vi.fn() }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  api.listAutomations.mockResolvedValue([task])
  vi.stubGlobal('electronAPI', api)
  container = document.createElement('div')
  root = createRoot(container)
  await act(async () => root.render(<AutomationMainView />))
})
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals() })
const runButton = () => Array.from(container.querySelectorAll('button')).find(b => /立即运行|执行中/.test(b.textContent ?? ''))!
it('runs once and disables repeated clicks until the execution completes', async () => {
  let finish!: (run: AutomationRun) => void
  api.runAutomationNow.mockImplementation(() => new Promise<AutomationRun>(resolve => { finish = resolve }))
  expect(container.textContent).toContain('已启用')
  await act(async () => runButton().click())
  expect(api.runAutomationNow).toHaveBeenCalledWith(task.id)
  expect(runButton().disabled).toBe(true)
  expect(runButton().textContent).toContain('执行中')
  await act(async () => runButton().click())
  expect(api.runAutomationNow).toHaveBeenCalledTimes(1)
  await act(async () => finish({ runAt: Date.now(), sessionId: 'result', status: 'succeeded' }))
  expect(runButton().disabled).toBe(false)
  expect(toast.success).toHaveBeenCalledWith('任务执行完成')
  expect(api.toggleAutomation).not.toHaveBeenCalled()
})
it('shows the actual failure and allows a retry', async () => {
  api.runAutomationNow.mockResolvedValue({ runAt: Date.now(), sessionId: '', status: 'failed', error: '缺少 WPS 创建权限' })
  await act(async () => runButton().click())
  expect(toast.error).toHaveBeenCalledWith('缺少 WPS 创建权限')
  expect(runButton().disabled).toBe(false)
})
