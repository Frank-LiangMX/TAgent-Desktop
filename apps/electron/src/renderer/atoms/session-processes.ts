/**
 * 各会话仍在跑的后台进程（主进程 registry 推送）。
 */
import { useEffect } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { SessionBackgroundProcess } from '@tagent/shared'

export const sessionProcessesMapAtom = atom<Record<string, SessionBackgroundProcess[]>>({})

const EMPTY_PROCESSES: SessionBackgroundProcess[] = []

function sameProcessList(
  prev: SessionBackgroundProcess[] | undefined,
  next: SessionBackgroundProcess[],
): boolean {
  if (prev === next) return true
  if (!prev || prev.length !== next.length) return false
  return prev.every((item, i) => {
    const other = next[i]
    return (
      item === other ||
      (item.id === other?.id &&
        item.command === other.command &&
        item.source === other.source &&
        item.startedAt === other.startedAt &&
        item.pid === other.pid)
    )
  })
}

export function useSessionProcesses(sessionId: string | null): SessionBackgroundProcess[] {
  const map = useAtomValue(sessionProcessesMapAtom)
  const setMap = useSetAtom(sessionProcessesMapAtom)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const write = (list: SessionBackgroundProcess[]): void => {
      setMap((prev) => {
        if (sameProcessList(prev[sessionId], list)) return prev
        return { ...prev, [sessionId]: list }
      })
    }
    void window.electronAPI.listSessionProcesses?.(sessionId).then((list) => {
      if (cancelled) return
      write(Array.isArray(list) ? list : [])
    })
    const off = window.electronAPI.onSessionProcessesChanged?.((payload) => {
      if (payload.sessionId !== sessionId) return
      write(
        Array.isArray(payload.processes)
          ? (payload.processes as SessionBackgroundProcess[])
          : [],
      )
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [sessionId, setMap])

  if (!sessionId) return EMPTY_PROCESSES
  return map[sessionId] ?? EMPTY_PROCESSES
}