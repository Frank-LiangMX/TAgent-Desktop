import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutomationScheduler } from './automation-scheduler'
import { claimAutomationTrigger, createAutomation, getAutomation, listAutomationEvents, setNextRunAt, updateAutomation } from './automation-manager'

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

describe('manual automation runs', () => {
  it('runs a paused task once, records its result and preserves the schedule', async () => {
    const a = makeAutomation()
    const paused = updateAutomation({ id: a.id, enabled: false })
    const run = vi.fn().mockResolvedValue({ sessionId: 'manual' })
    const scheduler = new AutomationScheduler({ runAutomation: run })
    expect(await scheduler.runNow(a.id)).toMatchObject({ status: 'succeeded', sessionId: 'manual' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(getAutomation(a.id)).toMatchObject({ enabled: false, nextRunAt: paused.nextRunAt, runCount: 1, lastSessionId: 'manual' })
  })
  it('guards duplicate manual runs and overlapping scheduled runs until completion', async () => {
    const a = makeAutomation()
    const now = Date.now()
    setNextRunAt(a.id, now)
    let finish!: (value: { sessionId: string }) => void
    const run = vi.fn(() => new Promise<{ sessionId: string }>(resolve => { finish = resolve }))
    const scheduler = new AutomationScheduler({ runAutomation: run, now: () => now })
    const pending = scheduler.runNow(a.id)
    expect(scheduler.isRunning(a.id)).toBe(true)
    expect(getAutomation(a.id)?.runCount).toBe(0)
    await expect(scheduler.runNow(a.id)).rejects.toThrow('正在执行')
    await scheduler.tick(now)
    expect(run).toHaveBeenCalledTimes(1)
    const next = getAutomation(a.id)!.nextRunAt
    finish({ sessionId: 'manual' })
    await pending
    expect(scheduler.isRunning(a.id)).toBe(false)
    expect(getAutomation(a.id)?.nextRunAt).toBe(next)
  })
  it('records failure and releases its lock without moving the next scheduled run', async () => {
    const a = makeAutomation()
    const run = vi.fn().mockRejectedValueOnce(new Error('缺少 WPS 创建权限')).mockResolvedValueOnce({ sessionId: 'retry' })
    const scheduler = new AutomationScheduler({ runAutomation: run })
    expect(await scheduler.runNow(a.id)).toMatchObject({ status: 'failed', error: '缺少 WPS 创建权限' })
    expect(getAutomation(a.id)).toMatchObject({ nextRunAt: a.nextRunAt, enabled: true, consecutiveFailures: 1 })
    expect(await scheduler.runNow(a.id)).toMatchObject({ status: 'succeeded' })
  })
  it('does not consume a one-time scheduled trigger and rejects deleted tasks', async () => {
    const a = createAutomation({ name: '一次', prompt: '运行', scheduleType: 'once', scheduledAt: Date.now() + 3600_000, intervalMinutes: 0, channelId: 'test' })
    const run = vi.fn().mockResolvedValue({ sessionId: 'manual' })
    const scheduler = new AutomationScheduler({ runAutomation: run })
    await scheduler.runNow(a.id)
    expect(getAutomation(a.id)).toMatchObject({ enabled: true, nextRunAt: a.nextRunAt })
    await expect(scheduler.runNow('missing')).rejects.toThrow('不存在')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
