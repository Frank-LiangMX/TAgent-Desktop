/**
 * 全局权限审批队列同步
 *
 * 问题：PermissionBanner 挂在 key=sessionId 的 Chat 树里，切 tab 会卸载；
 * 仅在组件内 onPermissionRequest 会丢并发请求 / 切走再切回看不到 pending。
 *
 * 本 hook 在 App 根挂载一次：
 * - PERMISSION_REQUEST → 入 per-session FIFO atom
 * - PERMISSION_RESOLVED → 按 reqId 出队；超时 deny 推 SessionErrorBanner
 */
import { useEffect } from 'react'
import { getDefaultStore, useSetAtom } from 'jotai'
import {
  enqueuePermissionAtom,
  resolvePermissionAtom,
  buildPermissionTimeoutSessionError,
  type PermissionReq,
  type PermissionResolvedPayload,
} from '../atoms/permission-atoms'
import { setSessionErrorAtom } from '../atoms/session-error-atoms'
import { adoptSessionRunAtom, sessionRunMapAtom } from '../atoms/session-run-atoms'

export function useGlobalPermissionSync(): void {
  const enqueue = useSetAtom(enqueuePermissionAtom)
  const resolve = useSetAtom(resolvePermissionAtom)
  const setSessionError = useSetAtom(setSessionErrorAtom)
  const adoptSessionRun = useSetAtom(adoptSessionRunAtom)

  useEffect(() => {
    const offRequest = window.electronAPI.onPermissionRequest((raw: unknown) => {
      const pr = raw as PermissionReq
      if (!pr?.id || !pr.sessionId) return
      enqueue(pr)
      const entry = getDefaultStore().get(sessionRunMapAtom)[pr.sessionId]
      if (entry?.startedAt != null) {
        adoptSessionRun({ id: pr.sessionId, startedAt: entry.startedAt })
      }
    })
    const offResolved = window.electronAPI.onPermissionResolved?.((raw: unknown) => {
      const p = raw as PermissionResolvedPayload
      if (!p?.reqId) return
      resolve({ reqId: p.reqId, sessionId: p.sessionId })
      if (p.behavior === 'deny' && p.reason === 'timeout' && p.sessionId) {
        setSessionError({
          sessionId: p.sessionId,
          error: buildPermissionTimeoutSessionError(p.toolName),
        })
      }
    })
    return () => {
      offRequest?.()
      offResolved?.()
    }
  }, [enqueue, resolve, setSessionError, adoptSessionRun])
}
