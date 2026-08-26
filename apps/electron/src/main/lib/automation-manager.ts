/** Automation 本地持久化：任务定义 + 有限运行历史 + 触发审计事件。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Automation, AutomationRun, CreateAutomationInput, UpdateAutomationInput } from '@tagent/shared'
import { AUTOMATION_DEFAULT_PERMISSION_MODE, AUTOMATION_DEFAULT_SESSION_MODE, AUTOMATION_MAX_HISTORY, computeNextRunAt } from '@tagent/shared'
import { readJsonSafe, writeJsonAtomic } from './atomic-json'
import { getAutomationEventsPath, getAutomationsPath } from './config/config-paths'

export interface AutomationStore {
  version: 1
  automations: Automation[]
}

export type AutomationEventKind = 'triggered' | 'skipped' | 'failed' | 'succeeded'

export interface AutomationEvent {
  id: string
  automationId: string
  kind: AutomationEventKind
  scheduledAt: number
  createdAt: number
  runAt?: number
  sessionId?: string
  error?: string
  reason?: string
}

const STORE_VERSION = 1 as const

function emptyStore(): AutomationStore {
  return { version: STORE_VERSION, automations: [] }
}

function readStore(): AutomationStore {
  const value = readJsonSafe<Partial<AutomationStore>>(getAutomationsPath(), emptyStore())
  if (value?.version !== STORE_VERSION || !Array.isArray(value.automations)) return emptyStore()
  return { version: STORE_VERSION, automations: value.automations }
}

function writeStore(store: AutomationStore): void {
  writeJsonAtomic(getAutomationsPath(), store)
}

function appendEvent(event: Omit<AutomationEvent, 'id' | 'createdAt'>): void {
  const path = getAutomationEventsPath()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify({ ...event, id: randomUUID(), createdAt: Date.now() })}\n`, 'utf8')
}

export function listAutomationEvents(automationId?: string): AutomationEvent[] {
  const path = getAutomationEventsPath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line) as AutomationEvent
      return !automationId || value.automationId === automationId ? [value] : []
    } catch {
      return []
    }
  })
}

export function listAutomations(): Automation[] {
  return readStore().automations
}

export function getAutomation(id: string): Automation | undefined {
  return readStore().automations.find((item) => item.id === id)
}

export function createAutomation(input: CreateAutomationInput): Automation {
  const now = Date.now()
  const automation: Automation = {
    id: randomUUID(), name: input.name.trim(), prompt: input.prompt,
    enabled: input.active !== false, scheduleType: input.scheduleType,
    intervalMinutes: input.intervalMinutes, timeOfDay: input.timeOfDay,
    dayOfWeek: input.dayOfWeek, dayOfMonth: input.dayOfMonth, scheduledAt: input.scheduledAt,
    maxRuns: input.maxRuns, channelId: input.channelId, modelId: input.modelId,
    workspaceId: input.workspaceId, sessionMode: input.sessionMode ?? AUTOMATION_DEFAULT_SESSION_MODE,
    permissionMode: input.permissionMode ?? AUTOMATION_DEFAULT_PERMISSION_MODE,
    notification: input.notification ?? { system: true }, sourceSessionId: input.sourceSessionId,
    createdAt: now, updatedAt: now, nextRunAt: 0, consecutiveFailures: 0, runCount: 0, runHistory: [],
  }
  automation.nextRunAt = computeNextRunAt(automation, now)
  const store = readStore()
  store.automations.push(automation)
  writeStore(store)
  return automation
}

export function updateAutomation(input: UpdateAutomationInput): Automation {
  const store = readStore()
  const index = store.automations.findIndex((item) => item.id === input.id)
  if (index < 0) throw new Error(`定时任务不存在: ${input.id}`)
  const current = store.automations[index]!
  const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  const updated = { ...current, ...patch, updatedAt: Date.now() } as Automation
  if (input.scheduleType !== undefined || input.intervalMinutes !== undefined || input.timeOfDay !== undefined || input.dayOfWeek !== undefined || input.dayOfMonth !== undefined || input.scheduledAt !== undefined || input.enabled !== undefined || input.maxRuns !== undefined) updated.nextRunAt = computeNextRunAt(updated, Date.now())
  store.automations[index] = updated
  writeStore(store)
  return updated
}

export function deleteAutomation(id: string): boolean {
  const store = readStore()
  const before = store.automations.length
  store.automations = store.automations.filter((item) => item.id !== id)
  if (store.automations.length === before) return false
  writeStore(store)
  return true
}

export function toggleAutomation(id: string): Automation {
  const automation = getAutomation(id)
  if (!automation) throw new Error(`定时任务不存在: ${id}`)
  return updateAutomation({ id, enabled: !automation.enabled })
}

export function claimAutomationTrigger(id: string, scheduledAt: number): boolean {
  const store = readStore()
  const index = store.automations.findIndex((item) => item.id === id)
  if (index < 0) return false
  const automation = store.automations[index]!
  if (automation.lastTriggerAt === scheduledAt) return false
  automation.lastTriggerAt = scheduledAt
  automation.updatedAt = Date.now()
  store.automations[index] = automation
  writeStore(store)
  return true
}

export function setNextRunAt(id: string, nextRunAt: number): Automation | undefined {
  const store = readStore()
  const index = store.automations.findIndex((item) => item.id === id)
  if (index < 0) return undefined
  const updated = { ...store.automations[index]!, nextRunAt, updatedAt: Date.now() }
  store.automations[index] = updated
  writeStore(store)
  return updated
}

export function appendRun(id: string, run: AutomationRun): Automation | undefined {
  const store = readStore()
  const index = store.automations.findIndex((item) => item.id === id)
  if (index < 0) return undefined
  const current = store.automations[index]!
  const updated = { ...current, runHistory: [...current.runHistory, run].slice(-AUTOMATION_MAX_HISTORY), updatedAt: Date.now() }
  store.automations[index] = updated
  writeStore(store)
  return updated
}

export function recordSkipped(id: string, scheduledAt: number, reason: string, nextRunAt: number): void {
  appendRun(id, { runAt: Date.now(), sessionId: '', status: 'skipped', skipReason: reason })
  appendEvent({ automationId: id, kind: 'skipped', scheduledAt, reason })
  setNextRunAt(id, nextRunAt)
}

export function recordRunOutcome(id: string, scheduledAt: number, run: AutomationRun): Automation | undefined {
  const store = readStore()
  const index = store.automations.findIndex((item) => item.id === id)
  if (index < 0) return undefined
  const current = store.automations[index]!
  const runCount = (current.runCount ?? 0) + (run.status === 'succeeded' || run.status === 'failed' ? 1 : 0)
  const consecutiveFailures = run.status === 'failed' ? (current.consecutiveFailures ?? 0) + 1 : 0
  const reachedMax = current.maxRuns !== undefined && runCount >= current.maxRuns
  const completed = current.scheduleType === 'once' || reachedMax || consecutiveFailures >= 5
  const updated: Automation = {
    ...current, runHistory: [...current.runHistory, run].slice(-AUTOMATION_MAX_HISTORY),
    lastRunAt: run.runAt, lastSessionId: run.sessionId || current.lastSessionId,
    runCount, consecutiveFailures, enabled: completed ? false : current.enabled,
    completedAt: completed ? Date.now() : current.completedAt,
    nextRunAt: completed ? 0 : computeNextRunAt({ ...current, lastRunAt: run.runAt, runCount, enabled: current.enabled }, Date.now()),
    updatedAt: Date.now(),
  }
  store.automations[index] = updated
  writeStore(store)
  appendEvent({ automationId: id, kind: run.status === 'succeeded' ? 'succeeded' : 'failed', scheduledAt, runAt: run.runAt, sessionId: run.sessionId, error: run.error })
  return updated
}

export function recordTriggered(id: string, scheduledAt: number, sessionId: string): void {
  appendEvent({ automationId: id, kind: 'triggered', scheduledAt, runAt: Date.now(), sessionId })
}
