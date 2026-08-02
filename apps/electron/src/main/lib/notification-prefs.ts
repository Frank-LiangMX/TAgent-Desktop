/**
 * 主进程通知偏好（系统 Notification 是否弹出）
 * 渲染层改设置时通过 IPC 同步。
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getConfigDir } from './config/config-paths'
import { writeJsonAtomic } from './atomic-json'

export interface NotificationPrefs {
  titlebarTicker: boolean
  systemDesktop: boolean
  panelToast: boolean
}

const DEFAULTS: NotificationPrefs = {
  titlebarTicker: true,
  systemDesktop: true,
  panelToast: true,
}

let cache: NotificationPrefs | null = null

function prefsPath(): string {
  return join(getConfigDir(), 'notification-prefs.json')
}

export function loadNotificationPrefs(): NotificationPrefs {
  if (cache) return cache
  const path = prefsPath()
  if (!existsSync(path)) {
    cache = { ...DEFAULTS }
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<NotificationPrefs>
    cache = {
      titlebarTicker: raw.titlebarTicker !== false,
      systemDesktop: raw.systemDesktop !== false,
      panelToast: raw.panelToast !== false,
    }
    return cache
  } catch {
    cache = { ...DEFAULTS }
    return cache
  }
}

export function saveNotificationPrefs(prefs: Partial<NotificationPrefs>): NotificationPrefs {
  const next = { ...loadNotificationPrefs(), ...prefs }
  cache = next
  const path = prefsPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeJsonAtomic(path, next)
  return next
}

export function isSystemDesktopNotifyEnabled(): boolean {
  return loadNotificationPrefs().systemDesktop
}
