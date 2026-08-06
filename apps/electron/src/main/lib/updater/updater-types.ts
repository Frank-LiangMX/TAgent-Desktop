/**
 * 更新状态类型定义
 */

export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | {
      status: 'downloading'
      version: string
      progress: {
        percent: number
        transferred: number
        total: number
        bytesPerSecond: number
      }
    }
  | { status: 'downloaded'; version: string }
  | { status: 'not-available' }
  | { status: 'error'; error: string }
  | { status: 'installing' }

export const UPDATER_IPC_CHANNELS = {
  CHECK_FOR_UPDATES: 'updater:check',
  GET_STATUS: 'updater:status',
  INSTALL_UPDATE: 'updater:install',
  INSTALL_WHEN_IDLE: 'updater:install-when-idle',
  CANCEL_IDLE_INSTALL: 'updater:cancel-idle-install',
  ON_STATUS_CHANGED: 'updater:on-status-changed',
} as const
