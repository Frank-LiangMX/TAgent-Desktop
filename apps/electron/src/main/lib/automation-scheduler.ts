/** Automation 调度器：短 tick + 持久化触发认领 + 明确的跳过策略。 */
import type { Automation, AutomationRun } from '@tagent/shared'
import { computeNextRunAt } from '@tagent/shared'
import {
  claimAutomationTrigger,
  getAutomation,
  listAutomations,
  recordRunOutcome,
  recordSkipped,
  recordTriggered,
  updateAutomation,
} from './automation-manager'

export const AUTOMATION_TICK_INTERVAL_MS = 30_000

export interface AutomationSchedulerDependencies {
  runAutomation: (automation: Automation) => Promise<{ sessionId: string }>
  now?: () => number
}

export class AutomationScheduler {
  private readonly runAutomation: AutomationSchedulerDependencies['runAutomation']
  private readonly now: () => number
  private readonly running = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(deps: AutomationSchedulerDependencies) {
    this.runAutomation = deps.runAutomation
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.recoverMissedRuns(this.now())
    void this.tick(this.now())
    this.timer = setInterval(() => void this.tick(this.now()), AUTOMATION_TICK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  async tick(now = this.now()): Promise<void> {
    await Promise.all(listAutomations().map((automation) => this.process(automation, now)))
  }

  private nextRun(automation: Automation, now: number): number {
    return computeNextRunAt({ ...automation, lastRunAt: automation.lastRunAt ?? now, enabled: true }, now)
  }

  private recoverMissedRuns(now: number): void {
    for (const automation of listAutomations()) {
      if (!automation.enabled || automation.nextRunAt <= 0 || automation.nextRunAt > now) continue
      if (!claimAutomationTrigger(automation.id, automation.nextRunAt)) continue
      if (automation.scheduleType === 'once') {
        recordSkipped(automation.id, automation.nextRunAt, '应用离线期间错过一次性任务', 0)
        updateAutomation({ id: automation.id, enabled: false })
        continue
      }
      recordSkipped(automation.id, automation.nextRunAt, '应用离线期间错过本轮', this.nextRun(automation, now))
    }
  }

  private async process(automation: Automation, now: number): Promise<void> {
    if (!automation.enabled || automation.nextRunAt <= 0 || automation.nextRunAt > now) return
    if (!claimAutomationTrigger(automation.id, automation.nextRunAt)) return

    const scheduledAt = automation.nextRunAt
    const following = this.nextRun(automation, now)
    if (scheduledAt < now - AUTOMATION_TICK_INTERVAL_MS) {
      recordSkipped(automation.id, scheduledAt, '任务已过期，按跳过策略处理', following)
      return
    }
    if (this.running.has(automation.id)) {
      recordSkipped(automation.id, scheduledAt, '上一轮任务仍在运行', following)
      return
    }

    this.running.add(automation.id)
    const runAt = this.now()
    try {
      const result = await this.runAutomation(automation)
      recordTriggered(automation.id, scheduledAt, result.sessionId)
      const run: AutomationRun = {
        runAt,
        sessionId: result.sessionId,
        status: 'succeeded',
        durationMs: this.now() - runAt,
      }
      recordRunOutcome(automation.id, scheduledAt, run)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const run: AutomationRun = {
        runAt,
        sessionId: '',
        status: 'failed',
        durationMs: this.now() - runAt,
        error: message,
      }
      recordRunOutcome(automation.id, scheduledAt, run)
    } finally {
      this.running.delete(automation.id)
    }
  }

  /** 供手动触发或测试读取最新任务，避免使用 tick 前的旧快照。 */
  get(id: string): Automation | undefined {
    return getAutomation(id)
  }
}

let scheduler: AutomationScheduler | undefined

export function startAutomationScheduler(deps: AutomationSchedulerDependencies): AutomationScheduler {
  if (!scheduler) scheduler = new AutomationScheduler(deps)
  scheduler.start()
  return scheduler
}

export function stopAutomationScheduler(): void {
  scheduler?.stop()
  scheduler = undefined
}
