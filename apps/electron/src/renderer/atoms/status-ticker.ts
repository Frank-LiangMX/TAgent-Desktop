/**
 * 顶栏滚动状态条：班组进度、系统提示等轻量消息
 * 替代占空间的居中 sonner toast（交互型 Nudge 仍可走 toast）
 */
import { atom } from 'jotai'

export type StatusTickerTone = 'info' | 'success' | 'warn' | 'error'

export interface StatusTickerItem {
  id: string
  text: string
  tone?: StatusTickerTone
  at: number
  /** 展示毫秒，默认 6000 */
  ttlMs?: number
}

/** 当前展示队列（最新在前） */
export const statusTickerQueueAtom = atom<StatusTickerItem[]>([])

let seq = 0

export function makeStatusTickerItem(
  text: string,
  tone: StatusTickerTone = 'info',
  ttlMs = 6000,
): StatusTickerItem {
  seq += 1
  return {
    id: `st-${Date.now()}-${seq}`,
    text: text.trim(),
    tone,
    at: Date.now(),
    ttlMs,
  }
}

/** 写入队列（最多保留 8 条） */
export const pushStatusTickerAtom = atom(
  null,
  (get, set, item: StatusTickerItem | string) => {
    const next =
      typeof item === 'string' ? makeStatusTickerItem(item) : item
    if (!next.text) return
    const prev = get(statusTickerQueueAtom)
    set(statusTickerQueueAtom, [next, ...prev].slice(0, 8))
  },
)

export const dismissStatusTickerAtom = atom(null, (get, set, id: string) => {
  set(
    statusTickerQueueAtom,
    get(statusTickerQueueAtom).filter((i) => i.id !== id),
  )
})
