/**
 * 自动更新状态 atom
 *
 * 监听主进程推送的更新状态变化，暴露 checkForUpdates / installWhenIdle 等操作。
 */
import { atom, useSetAtom, useAtomValue } from 'jotai'
import { useEffect } from 'react'

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | {
      status: 'downloading'
      version: string
      progress: { percent: number; transferred: number; total: number; bytesPerSecond: number }
    }
  | { status: 'downloaded'; version: string }
  | { status: 'not-available' }
  | { status: 'error'; error: string }
  | { status: 'installing' }

export const updateStateAtom = atom<UpdateState>({ status: 'idle' })

export const checkForUpdatesAtom = atom(null, async (_get, set) => {
  try {
    await window.electronAPI?.updater?.checkForUpdates?.()
  } catch (err) {
    set(updateStateAtom, { status: 'error', error: String(err) })
  }
})

export const installWhenIdleAtom = atom(null, async () => {
  try {
    await window.electronAPI?.updater?.installWhenIdle?.()
  } catch {
    /* ignore */
  }
})

export const cancelIdleInstallAtom = atom(null, async () => {
  try {
    await window.electronAPI?.updater?.cancelIdleInstall?.()
  } catch {
    /* ignore */
  }
})

/**
 * Hook: 订阅主进程更新状态推送。
 * 在 App 根组件调用一次即可。
 */
export function useInitUpdaterListener(): void {
  const set = useSetAtom(updateStateAtom)

  useEffect(() => {
    const off = window.electronAPI?.updater?.onStatusChanged?.((status: unknown) => {
      set(status as UpdateState)
    })

    // 启动时拉一次当前状态；dev 模式下 IPC 可能未注册，静默忽略
    void window.electronAPI?.updater
      ?.getStatus?.()
      .then((status: unknown) => set(status as UpdateState))
      .catch(() => {
        /* dev mode or updater not initialized — keep idle */
      })

    return () => {
      off?.()
    }
  }, [set])
}

export function useUpdateState(): UpdateState {
  return useAtomValue(updateStateAtom)
}
