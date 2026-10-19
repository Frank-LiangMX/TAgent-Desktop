import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation, WpsDailyBundle } from '@tagent/shared'

const { wps } = vi.hoisted(() => ({ wps: { collect: vi.fn(), bind: vi.fn(), assertEvidenceRead: vi.fn(), summary: vi.fn(bundle => ({ date: bundle.date, complete: bundle.complete })) } }))
vi.mock('./wps-service', () => ({ wpsService: wps }))
import { dueWpsReportDates, runWpsDailyReports } from './wps-report-runner'

const now = new Date('2026-10-09T20:00:00').getTime()
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagent-wps-run-test-')); process.env.TAGENT_CONFIG_DIR = root
  vi.useFakeTimers(); vi.setSystemTime(now); wps.collect.mockReset(); wps.bind.mockReset()
})
afterEach(() => { vi.useRealTimers(); delete process.env.TAGENT_CONFIG_DIR; rmSync(root, { recursive: true, force: true }) })
const automation = (): Automation => ({ id: 'report', name: 'WPS 日报', prompt: '生成日报', enabled: true, scheduleType: 'daily', intervalMinutes: 1440,
  timeOfDay: '18:00', channelId: 'model', createdAt: new Date('2026-10-07T12:00:00').getTime(), updatedAt: now, nextRunAt: now, runHistory: [],
  wpsDailyReport: { accountId: 'me', companyId: 'company', includeChats: true, includeDocuments: false, chatIds: ['work'] } })
const bundle = (date: string, complete = true): WpsDailyBundle => ({ date, complete, retryable: !complete, accountId: 'me', scope: automation().wpsDailyReport!, collectedAt: now, warnings: [], evidence: [] })

describe('WPS report catchup', () => {
  it('uses local due times, skips dates before creation and bounds long offline periods', () => {
    expect(dueWpsReportDates(new Date('2026-10-08T19:00:00').getTime(), '18:00', now).dates).toEqual(['2026-10-09'])
    expect(dueWpsReportDates(new Date('2026-10-08T12:00:00').getTime(), '18:00', new Date('2026-10-09T10:00:00').getTime()).dates).toEqual(['2026-10-08'])
    const result = dueWpsReportDates(new Date('2026-09-01T12:00:00').getTime(), '18:00', now)
    expect(result.omitted).toBe(true); expect(result.dates).toHaveLength(8)
  })
  it('generates separate dated tasks with frozen sources and never repeats succeeded dates', async () => {
    wps.collect.mockImplementation(async date => bundle(date))
    const createSession = vi.fn(title => title), runTurn = vi.fn(async () => {})
    await runWpsDailyReports(automation(), { createSession, runTurn })
    expect(runTurn).toHaveBeenCalledTimes(3)
    expect(createSession.mock.calls.map(args => args[0])).toEqual(['WPS 日报 · 2026-10-07', 'WPS 日报 · 2026-10-08', 'WPS 日报 · 2026-10-09'])
    expect(wps.collect.mock.calls[0]!.slice(2)).toEqual(['me', undefined, 'company'])
    expect(wps.bind.mock.calls.every(args => args[2] === true)).toBe(true)
    await runWpsDailyReports(automation(), { createSession, runTurn })
    expect(runTurn).toHaveBeenCalledTimes(3)
  })
  it('retries an incomplete draft instead of writing a completion receipt', async () => {
    const task = { ...automation(), createdAt: new Date('2026-10-09T12:00:00').getTime() }
    wps.collect.mockImplementation(async date => bundle(date, false))
    const runTurn = vi.fn(async () => {})
    await runWpsDailyReports(task, { createSession: () => 'draft', runTurn })
    wps.collect.mockImplementation(async date => bundle(date, true))
    await runWpsDailyReports(task, { createSession: () => 'complete', runTurn })
    expect(runTurn).toHaveBeenCalledTimes(2)
    await runWpsDailyReports(task, { createSession: () => 'repeat', runTurn })
    expect(runTurn).toHaveBeenCalledTimes(2)
  })
  it('does not write successful receipts when the model turn fails', async () => {
    const task = { ...automation(), createdAt: new Date('2026-10-09T12:00:00').getTime() }
    wps.collect.mockImplementation(async date => bundle(date))
    await expect(runWpsDailyReports(task, { createSession: () => 'failed', runTurn: async () => { throw new Error('model failed') } })).rejects.toThrow('model failed')
    const runTurn = vi.fn(async () => {})
    await runWpsDailyReports(task, { createSession: () => 'retry', runTurn })
    expect(runTurn).toHaveBeenCalledTimes(1)
  })
  it('records in-range successful days after a long offline gap instead of endlessly repeating them', async () => {
    const task = { ...automation(), createdAt: new Date('2026-09-01T12:00:00').getTime() }
    wps.collect.mockImplementation(async date => bundle(date))
    const runTurn = vi.fn(async () => {})
    await runWpsDailyReports(task, { createSession: title => title, runTurn })
    expect(runTurn).toHaveBeenCalledTimes(8)
    await runWpsDailyReports(task, { createSession: title => title, runTurn })
    expect(runTurn).toHaveBeenCalledTimes(8)
  })
  it('preserves a draft with fixed capability gaps without regenerating it every day', async () => {
    const task = { ...automation(), createdAt: new Date('2026-10-09T12:00:00').getTime() }
    wps.collect.mockImplementation(async date => ({ ...bundle(date, false), retryable: false, warnings: ['历史文档版本可能缺失'] }))
    const runTurn = vi.fn(async () => {})
    await runWpsDailyReports(task, { createSession: () => 'draft', runTurn })
    await runWpsDailyReports(task, { createSession: () => 'duplicate', runTurn })
    expect(runTurn).toHaveBeenCalledTimes(1)
  })
})

it('manually generates today before the scheduled time without consuming its later report', async () => {
  vi.setSystemTime(new Date('2026-10-09T10:00:00').getTime())
  const task = { ...automation(), createdAt: new Date('2026-10-09T09:00:00').getTime() }
  wps.collect.mockImplementation(async date => bundle(date))
  const createSession = vi.fn(() => 'manual'), runTurn = vi.fn(async () => {})
  await runWpsDailyReports(task, { manual: true, createSession, runTurn })
  expect(wps.collect).toHaveBeenCalledWith('2026-10-09', task.wpsDailyReport, 'me', undefined, 'company')
  expect(runTurn).toHaveBeenCalledTimes(1)
  vi.setSystemTime(new Date('2026-10-09T18:00:00').getTime())
  await runWpsDailyReports(task, { createSession, runTurn })
  expect(runTurn).toHaveBeenCalledTimes(2)
})
