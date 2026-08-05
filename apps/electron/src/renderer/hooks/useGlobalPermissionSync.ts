/**
 * 全局权限审批队列同步
 *
 * 问题：PermissionBanner 挂在 key=sessionId 的 Chat 树里，切 tab 会卸载；
 * 仅在组件内 onPermissionRequest 会丢并发请求 / 切走再切回看不到 pending。
 *
 * 本 hook 在 App 根挂载一次：
 * - PERMISSION_REQUEST → 入 per-session FIFO atom
 * - PERMISSION_RESOLVED → 按 reqId 出队（超时 deny / 用户 respond 都清横幅）
 */
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import {
  enqueuePermissionAtom,
  resolvePermissionAtom,
  type PermissionReq,
} from '../atoms/permission-atoms'

export function useGlobalPermissionSync(): void {
  const enqueue = useSetAtom(enqueuePermissionAtom)
  const resolve = useSetAtom(resolvePermissionAtom)

  useEffect(() => {
    const offRequest = window.electronAPI.onPermissionRequest((raw: unknown) => {
      const pr = raw as PermissionReq
      if (!pr?.id || !pr.sessionId) return
      enqueue(pr)
    })
    const offResolved = window.electronAPI.onPermissionResolved?.((raw: unknown) => {
      const p = raw as { reqId?: string; sessionId?: string }
      if (!p?.reqId) return
      resolve({ reqId: p.reqId, sessionId: p.sessionId })
    })
    return () => {
      offRequest?.()
      offResolved?.()
    }
  }, [enqueue, resolve])
}
