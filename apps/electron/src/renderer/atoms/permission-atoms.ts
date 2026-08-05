/**
 * 权限审批队列（Jotai）—— per-session FIFO
 *
 * 对齐 session-run-atoms：Record map + 派生工厂；全局存活，不随 Chat
 * key=sessionId remount 丢 pending。PermissionBanner 显示 queue[0] + (+N)。
 *
 * 写入路径：
 * - useGlobalPermissionSync：PERMISSION_REQUEST 入队 / PERMISSION_RESOLVED 按 reqId 出队
 * - PermissionBanner respond：乐观出队（主进程已无 pending 时静默；RESOLVED 幂等）
 */
import { atom } from 'jotai'
import { PERMISSION_TIMEOUT_MS } from '@tagent/shared'
import type { SessionErrorState } from './session-error-atoms'

/** 单条权限请求（与主进程 PermissionRequest 对齐） */
export interface PermissionReq {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  dangerous: boolean
  /** 主进程发出请求的时间戳；缺省按入队时刻（兼容旧 payload） */
  requestedAt?: number
}

/** PERMISSION_RESOLVED 载荷（主 → 渲染） */
export interface PermissionResolvedPayload {
  reqId: string
  sessionId?: string
  behavior?: 'allow' | 'deny'
  reason?: 'timeout' | 'user'
  toolName?: string
}

/** 会话 → 待审批队列（FIFO：队首为当前展示） */
export const pendingPermissionMapAtom = atom<Record<string, PermissionReq[]>>({})

/** 派生：某会话的待审批队列（未设置时空数组） */
export const sessionPermissionQueueAtom = (sessionId: string) =>
  atom((get) => get(pendingPermissionMapAtom)[sessionId] ?? [])

/** 剩余毫秒（≤0 表示已到期，等 RESOLVED 清横幅） */
export function getPermissionRemainingMs(
  req: Pick<PermissionReq, 'requestedAt'>,
  now = Date.now(),
): number {
  const startedAt = req.requestedAt ?? now
  return Math.max(0, startedAt + PERMISSION_TIMEOUT_MS - now)
}

/** 横幅倒计时文案 */
export function formatPermissionCountdown(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000)
  if (totalSec <= 0) return '即将超时'
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) return `剩余 ${min}:${String(sec).padStart(2, '0')}`
  return `剩余 ${sec}s`
}

/** 超时 deny 后推 SessionErrorBanner 的状态 */
export function buildPermissionTimeoutSessionError(toolName?: string): SessionErrorState {
  const detail = toolName ? `工具 ${toolName} 未在时限内确认。` : '请在时限内确认或拒绝。'
  return {
    title: '权限确认超时，已拒绝',
    message: `${detail}如需执行，请重新发送指令并允许。`,
    retryable: true,
    code: 'permission_denied',
    at: Date.now(),
  }
}

/** 入队（write-only）。同 id 幂等，不重复塞。 */
export const enqueuePermissionAtom = atom(null, (get, set, req: PermissionReq) => {
  const map = { ...get(pendingPermissionMapAtom) }
  const queue = [...(map[req.sessionId] ?? [])]
  if (queue.some((r) => r.id === req.id)) return
  queue.push({
    ...req,
    requestedAt: req.requestedAt ?? Date.now(),
  })
  map[req.sessionId] = queue
  set(pendingPermissionMapAtom, map)
})

/**
 * 按 reqId 出队（write-only）。
 * 已知 sessionId 时 O(会话队列)；未知时扫全表（RESOLVED 应带 sessionId）。
 * 幂等：已不在队列则 no-op。
 */
export const resolvePermissionAtom = atom(
  null,
  (
    get,
    set,
    payload: { reqId: string; sessionId?: string },
  ) => {
    const map = { ...get(pendingPermissionMapAtom) }
    const sessionIds =
      payload.sessionId != null && payload.sessionId !== ''
        ? [payload.sessionId]
        : Object.keys(map)

    let changed = false
    for (const sid of sessionIds) {
      const queue = map[sid]
      if (!queue?.length) continue
      const next = queue.filter((r) => r.id !== payload.reqId)
      if (next.length === queue.length) continue
      if (next.length === 0) {
        delete map[sid]
      } else {
        map[sid] = next
      }
      changed = true
      break
    }
    if (changed) set(pendingPermissionMapAtom, map)
  },
)
