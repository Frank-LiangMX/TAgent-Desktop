import type { Automation } from '../types/automation'

export type AutomationScheduleInput = Pick<
  Automation,
  | 'scheduleType'
  | 'intervalMinutes'
  | 'timeOfDay'
  | 'dayOfWeek'
  | 'dayOfMonth'
  | 'scheduledAt'
  | 'enabled'
  | 'lastRunAt'
  | 'runCount'
  | 'maxRuns'
>

/**
 * 计算下次运行时间
 */
export function computeNextRunAt(automation: AutomationScheduleInput, now: number): number {
  if (!automation.enabled) return 0
  if (automation.maxRuns && (automation.runCount ?? 0) >= automation.maxRuns) return 0

  const nowDate = new Date(now)

  switch (automation.scheduleType) {
    case 'interval': {
      const last = automation.lastRunAt ?? now
      return last + (automation.intervalMinutes ?? 60) * 60_000
    }
    case 'daily': {
      return nextTimeOfDay(nowDate, automation.timeOfDay ?? '09:00').getTime()
    }
    case 'weekly': {
      return nextWeeklyTime(
        nowDate,
        automation.dayOfWeek ?? 1,
        automation.timeOfDay ?? '09:00'
      ).getTime()
    }
    case 'monthly': {
      return nextMonthlyTime(
        nowDate,
        automation.dayOfMonth ?? 1,
        automation.timeOfDay ?? '09:00'
      ).getTime()
    }
    case 'once': {
      return automation.scheduledAt ? new Date(automation.scheduledAt).getTime() : 0
    }
    default:
      return 0
  }
}

/** 判断两个时间戳是否落在同一个本地自然日 */
export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/** 生成调度文案（用于 UI 显示） */
export function formatScheduleLabel(automation: AutomationScheduleInput): string {
  if (automation.scheduleType === 'once') {
    const when = automation.scheduledAt
      ? new Date(automation.scheduledAt).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '指定时间'
    return `仅运行一次（${when}）`
  }
  if (automation.scheduleType === 'daily') return `每天 ${automation.timeOfDay ?? '09:00'}`
  if (automation.scheduleType === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[automation.dayOfWeek ?? 1]} ${automation.timeOfDay ?? '09:00'}`
  }
  if (automation.scheduleType === 'monthly') {
    return `每月 ${automation.dayOfMonth ?? 1} 号 ${automation.timeOfDay ?? '09:00'}`
  }
  const min = automation.intervalMinutes ?? 60
  if (min < 60) return `每 ${min} 分钟`
  if (min < 1440) return `每 ${min / 60} 小时`
  return `每 ${min / 1440} 天`
}

function nextTimeOfDay(now: Date, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number)
  const next = new Date(now)
  next.setHours(h!, m!, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

function nextWeeklyTime(now: Date, dayOfWeek: number, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number)
  const next = new Date(now)
  next.setHours(h!, m!, 0, 0)

  const currentDay = next.getDay()
  let daysUntil = dayOfWeek - currentDay
  if (daysUntil < 0 || (daysUntil === 0 && next.getTime() <= now.getTime())) {
    daysUntil += 7
  }
  next.setDate(next.getDate() + daysUntil)
  return next
}

function nextMonthlyTime(now: Date, dayOfMonth: number, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number)
  const next = new Date(now)

  const thisMonth = new Date(
    next.getFullYear(),
    next.getMonth(),
    Math.min(dayOfMonth, daysInMonth(next.getFullYear(), next.getMonth() + 1))
  )
  thisMonth.setHours(h!, m!, 0, 0)
  if (thisMonth.getTime() > now.getTime()) {
    return thisMonth
  }

  const nextMonth = new Date(
    next.getFullYear(),
    next.getMonth() + 1,
    Math.min(dayOfMonth, daysInMonth(next.getFullYear(), next.getMonth() + 2))
  )
  nextMonth.setHours(h!, m!, 0, 0)
  return nextMonth
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}
