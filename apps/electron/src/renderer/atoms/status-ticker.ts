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
  /** 可选的主动作；例如从班组进度通知直接打开对应面板。 */
  onClick?: () => void
  /** 鼠标悬停和读屏使用的动作说明。 */
  actionLabel?: string
  /** 相同 key 的旧通知会被新状态替换，避免任务结束后又弹出过时进度。 */
  coalesceKey?: string
}

/** 尚未在顶栏完整提醒的队列（最新在前）。 */
export const statusTickerQueueAtom = atom<StatusTickerItem[]>([])

/** 已提醒历史：顶栏超时后折叠在此，供通知中心回溯。 */
export const statusTickerHistoryAtom = atom<StatusTickerItem[]>([])

const MAX_ACTIVE_ITEMS = 8
const MAX_HISTORY_ITEMS = 40

function prependHistory(history: StatusTickerItem[], items: StatusTickerItem[]): StatusTickerItem[] {
  const seen = new Set(items.map((item) => item.id))
  return [...items, ...history.filter((item) => !seen.has(item.id))].slice(0, MAX_HISTORY_ITEMS)
}

let seq = 0

export function makeStatusTickerItem(
  text: string,
  tone: StatusTickerTone = 'info',
  ttlMs = 6000,
  action?: Pick<StatusTickerItem, 'onClick' | 'actionLabel' | 'coalesceKey'>,
): StatusTickerItem {
  seq += 1
  return {
    id: `st-${Date.now()}-${seq}`,
    text: text.trim(),
    tone,
    at: Date.now(),
    ttlMs,
    ...action,
  }
}

/** 写入待提醒队列；相同任务的新状态会同步取代历史中的旧状态。 */
export const pushStatusTickerAtom = atom(
  null,
  (get, set, item: StatusTickerItem | string) => {
    const next =
      typeof item === 'string' ? makeStatusTickerItem(item) : item
    if (!next.text) return
    const prev = get(statusTickerQueueAtom)
    const withoutSuperseded = next.coalesceKey
      ? prev.filter((item) => item.coalesceKey !== next.coalesceKey)
      : prev
    const nextActive = [next, ...withoutSuperseded]
    const overflow = nextActive.slice(MAX_ACTIVE_ITEMS)
    set(statusTickerQueueAtom, nextActive.slice(0, MAX_ACTIVE_ITEMS))
    const history = get(statusTickerHistoryAtom)
    const withoutSupersededHistory = next.coalesceKey
      ? history.filter((item) => item.coalesceKey !== next.coalesceKey)
      : history
    set(statusTickerHistoryAtom, prependHistory(withoutSupersededHistory, overflow))
  },
)

/** 当前提醒完成后折叠至历史，而不是直接删除。 */
export const archiveStatusTickerAtom = atom(null, (get, set, id: string) => {
  const active = get(statusTickerQueueAtom)
  const item = active.find((entry) => entry.id === id)
  if (!item) return
  set(statusTickerQueueAtom, active.filter((entry) => entry.id !== id))
  set(statusTickerHistoryAtom, prependHistory(get(statusTickerHistoryAtom), [item]))
})

/** 兼容现有调用：dismiss 语义改为“折叠到已提醒历史”。 */
export const dismissStatusTickerAtom = archiveStatusTickerAtom

/** 用户主动删除一条通知（待提醒或历史），不进已提醒。 */
export const removeStatusTickerAtom = atom(null, (get, set, id: string) => {
  set(
    statusTickerQueueAtom,
    get(statusTickerQueueAtom).filter((entry) => entry.id !== id),
  )
  set(
    statusTickerHistoryAtom,
    get(statusTickerHistoryAtom).filter((entry) => entry.id !== id),
  )
})

/** 用户在通知中心主动清理已提醒历史。 */
export const clearStatusTickerHistoryAtom = atom(null, (_get, set) => {
  set(statusTickerHistoryAtom, [])
})
