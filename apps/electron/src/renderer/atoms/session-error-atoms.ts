/**
 * 会话错误条状态（Jotai）—— per-session
 *
 * session_error 不再塞进消息列表，改为独立 banner 状态。
 * 按 sessionId 键存，切会话/Chat remount 不丢、不串。
 */
import { atom } from 'jotai'
import type { UserFacingError, UserFacingErrorCode } from '@tagent/shared'

/** 单会话可见错误（标题 + 详情 + 是否可重试） */
export interface SessionErrorState {
  title: string
  message: string
  retryable: boolean
  code?: UserFacingErrorCode
  action?: UserFacingError['action']
  /** 收到错误的时间戳（用于 key / 调试） */
  at: number
}

/** sessionId → 当前未关闭的错误（无则缺省） */
export const sessionErrorMapAtom = atom<Record<string, SessionErrorState>>({})

/** Clear only the error that triggered recovery, never a newer failure. */
export const clearRecoveredSessionErrorAtom = atom(null, (get, set, payload: { sessionId: string; error: SessionErrorState }) => {
  const map = get(sessionErrorMapAtom)
  if (map[payload.sessionId] !== payload.error) return
  const next = { ...map }
  delete next[payload.sessionId]
  set(sessionErrorMapAtom, next)
})

/**
 * 写入/清除某会话错误（write-only）。
 * error=null 表示关闭（dismiss / 重试开始 / 新发送）。
 */
export const setSessionErrorAtom = atom(
  null,
  (get, set, payload: { sessionId: string; error: SessionErrorState | null }) => {
    const map = { ...get(sessionErrorMapAtom) }
    if (payload.error == null) {
      if (!(payload.sessionId in map)) return
      delete map[payload.sessionId]
    } else {
      map[payload.sessionId] = payload.error
    }
    set(sessionErrorMapAtom, map)
  },
)
