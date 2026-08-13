/**
 * 各会话仍在跑的后台进程（主进程 registry 推送）。
 */
import { useEffect } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { SessionBackgroundProcess } from '@tagent/shared'

export const sessionProcessesMapAtom = atom<Record<string, SessionBackgroundProcess[]>>({})

export function useSessionProcesses(sessionId: string | null): SessionBackgroundProcess[] {
  const map = useAtomValue(sessionProcessesMapAtom)
  const setMap = useSetAtom(sessionProcessesMapAtom)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void window.electronAPI.listSessionProcesses?.(sessionId).then((list) => {
      if (cancelled) return
      setMap((prev) => ({ ...prev, [sessionId]: Array.isArray(list) ? list : [] }))
    })
    const off = window.electronAPI.onSessionProcessesChanged?.((payload) => {
      if (payload.sessionId !== sessionId) return
      setMap((prev) => ({
        ...prev,
        [sessionId]: Array.isArray(payload.processes)
          ? (payload.processes as SessionBackgroundProcess[])
          : [],
      }))
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [sessionId, setMap])

  if (!sessionId) return []
  return map[sessionId] ?? []
}