/**
 * 会话摘要：Chat 发布本场协作目录，标签栏右侧固定入口消费。
 * 点击条目再回写 action，由对应 Chat 实例跳转 / 打开讨论室 / 开班组。
 */
import { atom } from 'jotai'
import type { SessionCollabItem } from '../components/chat/session-collab-outline'

export interface SessionSummaryHost {
  sessionId: string
  timelineItems: SessionCollabItem[]
  sessionBoardId: string | null
  hasCrewBoards: boolean
}

export const sessionSummaryHostsAtom = atom<Record<string, SessionSummaryHost>>({})

export const setSessionSummaryHostAtom = atom(null, (get, set, host: SessionSummaryHost) => {
  const prev = get(sessionSummaryHostsAtom)
  const existing = prev[host.sessionId]
  if (
    existing &&
    existing.sessionBoardId === host.sessionBoardId &&
    existing.hasCrewBoards === host.hasCrewBoards &&
    existing.timelineItems === host.timelineItems
  ) {
    return
  }
  set(sessionSummaryHostsAtom, { ...prev, [host.sessionId]: host })
})

export const clearSessionSummaryHostAtom = atom(null, (get, set, sessionId: string) => {
  const prev = get(sessionSummaryHostsAtom)
  if (!(sessionId in prev)) return
  const next = { ...prev }
  delete next[sessionId]
  set(sessionSummaryHostsAtom, next)
})

export interface SessionSummaryAction {
  sessionId: string
  item: SessionCollabItem
  requestId: number
}

export const sessionSummaryActionAtom = atom<SessionSummaryAction | null>(null)
