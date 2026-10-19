import { join } from 'node:path'
import type { Automation } from '@tagent/shared'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getConfigDir } from '../config/config-paths'
import { wpsService } from './wps-service'
import { localReportDate, WPS_DAILY_REPORT_PROMPT } from './wps-daily-collector'

export function dueWpsReportDates(createdAt: number, timeOfDay: string, now = Date.now()): { dates: string[]; omitted: boolean } {
  const [hour, minute] = timeOfDay.split(':').map(Number)
  const oldest = new Date(now); oldest.setHours(hour!, minute!, 0, 0); oldest.setDate(oldest.getDate() - 7)
  const first = new Date(createdAt); first.setHours(hour!, minute!, 0, 0)
  if (first.getTime() < createdAt) first.setDate(first.getDate() + 1)
  const omitted = first.getTime() < oldest.getTime()
  const cursor = new Date(Math.max(first.getTime(), oldest.getTime()))
  const dates: string[] = []
  while (cursor.getTime() <= now) { dates.push(localReportDate(cursor.getTime())); cursor.setDate(cursor.getDate() + 1) }
  return { dates, omitted }
}

/** 日报补报与普通自动任务分开：最近七天 + 今天，逐日生成，成功日期不重复。 */
export async function runWpsDailyReports(automation: Automation, deps: {
  manual?: boolean
  createSession: (title: string) => string
  runTurn: (sessionId: string, prompt: string, context: string) => Promise<void>
}): Promise<{ sessionId: string }> {
  const source = automation.wpsDailyReport
  if (!source || automation.scheduleType !== 'daily') throw new Error('WPS 日报任务配置无效。')
  const path = join(getConfigDir(), 'wps-report-runs.json')
  const schedule = deps.manual ? { dates: [localReportDate()], omitted: false } : dueWpsReportDates(automation.createdAt, automation.timeOfDay ?? '18:00')
  const omitted = schedule.omitted && (!automation.lastRunAt || automation.lastRunAt < Date.now() - 8 * 86400_000)
  let sessionId = automation.lastSessionId ?? ''
  for (const date of schedule.dates) {
    const receiptKey = `${automation.id}:${date}`
    const receipts = readJsonSafe<Record<string, { sessionId: string; completedAt: number; complete: boolean }>>(path, {})
    if (!deps.manual && receipts[receiptKey]) { sessionId = receipts[receiptKey]!.sessionId; continue }
    const bundle = await wpsService.collect(date, source, source.accountId, undefined, source.companyId)
    const dayComplete = bundle.complete
    if (omitted) { bundle.warnings.push('离线时间超过七天，更早日期未自动补报。'); bundle.complete = false }
    sessionId = deps.createSession(`${automation.name} · ${date}`)
    wpsService.bind(sessionId, bundle, true)
    const context = `这是 WPS 本人工作日报任务，目标日期 ${date}，使用本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}。主进程已采集该日证据，请直接调用 wps_read_daily_evidence，不要重新采集今天。采集摘要：${JSON.stringify(wpsService.summary(bundle))}。${WPS_DAILY_REPORT_PROMPT}`
    await deps.runTurn(sessionId, automation.prompt, context)
    wpsService.assertEvidenceRead(sessionId)
    // 接口失败次日重试；固定能力限制保留显式的草稿状态，避免每天重复同一草稿。
    if (!deps.manual && !bundle.retryable) {
      const latest = readJsonSafe<typeof receipts>(path, {})
      latest[receiptKey] = { sessionId, completedAt: Date.now(), complete: dayComplete }
      const cutoff = Date.now() - 10 * 86400_000
      for (const [key, receipt] of Object.entries(latest)) if (receipt.completedAt < cutoff) delete latest[key]
      writeJsonAtomic(path, latest)
    }
  }
  if (!sessionId) throw new Error('当前没有到期的 WPS 日报。')
  return { sessionId }
}
