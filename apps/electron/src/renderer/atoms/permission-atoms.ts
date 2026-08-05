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

/** 单条权限请求（与主进程 PermissionRequest 对齐） */
export interface PermissionReq {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  dangerous: boolean
}

/** 会话 → 待审批队列（FIFO：队首为当前展示） */
export const pendingPermissionMapAtom = atom<Record<string, PermissionReq[]>>({})

/** 派生：某会话的待审批队列（未设置时空数组） */
export const sessionPermissionQueueAtom = (sessionId: string) =>
  atom((get) => get(pendingPermissionMapAtom)[sessionId] ?? [])

/** 入队（write-only）。同 id 幂等，不重复塞。 */
export const enqueuePermissionAtom = atom(null, (get, set, req: PermissionReq) => {
  const map = { ...get(pendingPermissionMapAtom) }
  const queue = [...(map[req.sessionId] ?? [])]
  if (queue.some((r) => r.id === req.id)) return
  queue.push(req)
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
