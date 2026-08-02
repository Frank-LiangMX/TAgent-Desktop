/**
 * 通知偏好（通用设置）
 * - 顶栏滚动：应用内顶栏 ticker
 * - 系统通知：OS Notification（后台仍能看到）
 * - 面板 Toast：悬浮 toast（含 Nudge 交互按钮）
 */
import { atom } from 'jotai'

const STORAGE_KEY = 'tagent-notification-prefs'

export interface NotificationPrefs {
  /** 顶栏滚动通知条 */
  titlebarTicker: boolean
  /** 操作系统通知 */
  systemDesktop: boolean
  /** 面板内悬浮 Toast（Nudge 等） */
  panelToast: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  titlebarTicker: true,
  systemDesktop: true,
  panelToast: true,
}

function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS }
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>
    return {
      titlebarTicker: parsed.titlebarTicker !== false,
      systemDesktop: parsed.systemDesktop !== false,
      panelToast: parsed.panelToast !== false,
    }
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS }
  }
}

function persistPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
  // 同步主进程（系统通知开关）
  try {
    void window.electronAPI?.setNotificationPrefs?.(prefs)
  } catch {
    /* ignore */
  }
}

export const notificationPrefsAtom = atom<NotificationPrefs>(loadPrefs())

export const setNotificationPrefsAtom = atom(
  null,
  (get, set, patch: Partial<NotificationPrefs>) => {
    const next = { ...get(notificationPrefsAtom), ...patch }
    set(notificationPrefsAtom, next)
    persistPrefs(next)
  },
)

/** 启动时把 localStorage 偏好推到主进程 */
export function syncNotificationPrefsToMain(): void {
  persistPrefs(loadPrefs())
}

export function getNotificationPrefsSnapshot(): NotificationPrefs {
  return loadPrefs()
}
