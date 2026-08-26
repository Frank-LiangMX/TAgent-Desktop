import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutomationScheduler } from './automation-scheduler'
import { createAutomation, getAutomation, listAutomationEvents, setNextRunAt } from './automation-manager'

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
