import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutomationScheduler } from './automation-scheduler'
import { claimAutomationTrigger, createAutomation, getAutomation, listAutomationEvents, setNextRunAt } from './automation-manager'

const root = mkdtempSync(join(tmpdir(), 'tagent-automation-'))
process.env.TAGENT_CONFIG_DIR = root

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(join(root, 'automations.json'), { force: true })
  rmSync(join(root, 'automations.json.bak'), { force: true })
  rmSync(join(root, 'automation-events.jsonl'), { force: true })
})

function makeAutomation() {
  return createAutomation({
    name: '测试任务',
    prompt: '检查工作区状态并记录结果',
    scheduleType: 'interval',
    intervalMinutes: 10,
    channelId: 'test-channel',
    workspaceId: 'test-workspace',
  })
}

describe('AutomationScheduler', () => {
  it('WPS 日报认领后崩溃，重启仍能恢复补报而不是永久卡住', async () => {
    const now = Date.now()
    const automation = createAutomation({ name: '日报', prompt: '生成日报', scheduleType: 'daily', intervalMinutes: 1440,
      timeOfDay: '18:00', channelId: 'test-channel', wpsDailyReport: { accountId: 'me', includeChats: true, includeDocuments: false, chatIds: [] } })
    const old = now - 86400_000
    setNextRunAt(automation.id, old)
    claimAutomationTrigger(automation.id, old)
    const run = vi.fn().mockResolvedValue({ sessionId: 'recovered-report' })
    const scheduler = new AutomationScheduler({ runAutomation: run, now: () => now })
    try {
      scheduler.start()
      await Promise.resolve()
      expect(run).toHaveBeenCalledTimes(1)
      expect(getAutomation(automation.id)?.nextRunAt).toBeGreaterThan(old)
    } finally { scheduler.stop() }
  })
  it('WPS 日报离线后执行补报入口，并保留账号绑定与范围', async () => {
    const automation = createAutomation({ name: '日报', prompt: '生成日报', scheduleType: 'daily', intervalMinutes: 1440,
      timeOfDay: '18:00', channelId: 'test-channel', wpsDailyReport: { accountId: 'me', includeChats: true, includeDocuments: false, chatIds: ['work-chat'] } })
    const now = Date.now()
    setNextRunAt(automation.id, now - 2 * 86400_000)
    const run = vi.fn().mockResolvedValue({ sessionId: 'report-session' })
    const scheduler = new AutomationScheduler({ runAutomation: run, now: () => now })
    await scheduler.tick(now)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0].wpsDailyReport).toEqual(automation.wpsDailyReport)
    expect(getAutomation(automation.id)?.runHistory.at(-1)?.status).toBe('succeeded')
  })
  it('只派发同一个到期触发一次，并记录成功事件', async () => {
    const automation = makeAutomation()
    const now = Date.now()
    setNextRunAt(automation.id, now)
    const run = vi.fn().mockResolvedValue({ sessionId: 'session-1' })
    const scheduler = new AutomationScheduler({ runAutomation: run, now: () => now })

    await scheduler.tick(now)
    await scheduler.tick(now)

    expect(run).toHaveBeenCalledTimes(1)
    expect(getAutomation(automation.id)?.runHistory.at(-1)?.status).toBe('succeeded')
    expect(listAutomationEvents(automation.id).map((event) => event.kind)).toEqual(['triggered', 'succeeded'])
  })

  it('应用离线错过任务时跳过本轮而不是启动补跑', async () => {
    const automation = makeAutomation()
    const now = Date.now()
    setNextRunAt(automation.id, now - 2 * 60_000)
    const run = vi.fn()
    const scheduler = new AutomationScheduler({ runAutomation: run, now: () => now })

    await scheduler.tick(now)

    expect(run).not.toHaveBeenCalled()
    expect(getAutomation(automation.id)?.runHistory.at(-1)?.skipReason).toContain('过期')
    expect(listAutomationEvents(automation.id).at(-1)?.kind).toBe('skipped')
  })

  it('连续失败五次后自动暂停任务', async () => {
    const automation = makeAutomation()
    const run = vi.fn().mockRejectedValue(new Error('测试失败'))
    const scheduler = new AutomationScheduler({ runAutomation: run })

    for (let index = 0; index < 5; index += 1) {
      setNextRunAt(automation.id, Date.now())
      await scheduler.tick(Date.now())
    }

    expect(run).toHaveBeenCalledTimes(5)
    expect(getAutomation(automation.id)?.enabled).toBe(false)
    expect(getAutomation(automation.id)?.nextRunAt).toBe(0)
  })
})
