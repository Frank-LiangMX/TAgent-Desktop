/**
 * 会话后台进程登记：主会话 Bash / CLI 工人 spawn 后挂在这里，
 * 摘要里列出，用户可停掉「管生不管关」的进程。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { SessionBackgroundProcess, SessionProcessSource } from '@tagent/shared'
import { killCliProcessTree } from './cli-workers/kill-cli-process'

export type SessionProcessRecord = SessionBackgroundProcess & {
  child?: ChildProcess
}

type Listener = (sessionId: string, processes: SessionBackgroundProcess[]) => void

let seq = 0
const byId = new Map<string, SessionProcessRecord>()
const listeners = new Set<Listener>()

function publicView(rec: SessionProcessRecord): SessionBackgroundProcess {
  return {
    id: rec.id,
    sessionId: rec.sessionId,
    pid: rec.pid,
    command: rec.command,
    source: rec.source,
    startedAt: rec.startedAt,
  }
}

function emit(sessionId: string): void {
  const list = listSessionProcesses(sessionId)
  for (const fn of listeners) {
    try {
      fn(sessionId, list)
    } catch {
      /* ignore listener */
    }
  }
}

export function subscribeSessionProcesses(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function listSessionProcesses(sessionId: string): SessionBackgroundProcess[] {
  const out: SessionBackgroundProcess[] = []
  for (const rec of byId.values()) {
    if (rec.sessionId === sessionId) out.push(publicView(rec))
  }
  out.sort((a, b) => a.startedAt - b.startedAt)
  return out
}

export function trackSessionProcess(input: {
  sessionId: string
  command: string
  source: SessionProcessSource
  pid?: number
  child?: ChildProcess
}): string {
  const id = `proc-${Date.now().toString(36)}-${++seq}`
  const rec: SessionProcessRecord = {
    id,
    sessionId: input.sessionId,
    pid: input.pid ?? input.child?.pid,
    command: input.command.trim() || input.source,
    source: input.source,
    startedAt: Date.now(),
    child: input.child,
  }
  byId.set(id, rec)
  if (input.child) {
    const done = (): void => {
      untrackSessionProcess(id)
    }
    input.child.once('exit', done)
    input.child.once('error', done)
  }
  emit(input.sessionId)
  return id
}

export function untrackSessionProcess(id: string): void {
  const rec = byId.get(id)
  if (!rec) return
  byId.delete(id)
  emit(rec.sessionId)
}

export function killSessionProcess(sessionId: string, id: string): { ok: boolean; error?: string } {
  const rec = byId.get(id)
  if (!rec || rec.sessionId !== sessionId) {
    return { ok: false, error: '进程不存在或已结束' }
  }
  if (rec.child) {
    killCliProcessTree(rec.child, rec.source)
  } else if (rec.pid && rec.pid > 0) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(rec.pid, 'SIGTERM')
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  } else {
    return { ok: false, error: '没有可停止的进程句柄' }
  }
  untrackSessionProcess(id)
  return { ok: true }
}

export function bashHooksForSession(sessionId: string): {
  onSpawn: (info: { pid?: number; command: string }) => void
  onExit: (info: { pid?: number; command: string }) => void
} {
  const ids = new Map<string, string>()
  const keyOf = (info: { pid?: number; command: string }): string =>
    `${info.pid ?? 0}:${info.command}`
  return {
    onSpawn: (info) => {
      const id = trackSessionProcess({
        sessionId,
        command: info.command,
        source: 'bash',
        pid: info.pid,
      })
      ids.set(keyOf(info), id)
    },
    onExit: (info) => {
      const id = ids.get(keyOf(info))
      if (id) untrackSessionProcess(id)
    },
  }
}

export function resetSessionProcessRegistryForTests(): void {
  byId.clear()
  seq = 0
}
