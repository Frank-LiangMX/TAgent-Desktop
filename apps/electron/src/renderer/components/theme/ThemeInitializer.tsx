/**
 * ThemeInitializer — 主题初始化 + 系统主题监听
 *
 * 1. 挂载时读 atom + 主进程 nativeTheme / matchMedia → applyThemeToDOM
 * 2. 订阅系统明暗变化（优先 Electron nativeTheme IPC，回退 matchMedia）
 * 3. 监听 themeMode / themeStyle / systemIsDark → applyThemeToDOM
 *
 * 挂到 main.tsx 根（App 之上），确保主题在任何子组件渲染前应用。
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  themeModeAtom,
  themeStyleAtom,
  systemIsDarkAtom,
  applyThemeToDOM,
  matchMediaDark,
} from '../../atoms/theme'
import { useDynamicBackground } from '../../hooks/useDynamicBackground'

function getElectronThemeApi():
  | {
      getSystemDark?: () => Promise<boolean>
      onSystemThemeUpdated?: (cb: (dark: boolean) => void) => () => void
      setResolvedDark?: (dark: boolean) => void
    }
  | undefined {
  try {
    return (window as unknown as { electronAPI?: {
      getSystemDark?: () => Promise<boolean>
      onSystemThemeUpdated?: (cb: (dark: boolean) => void) => () => void
      setResolvedDark?: (dark: boolean) => void
    } }).electronAPI
  } catch {
    return undefined
  }
}

export function ThemeInitializer({ children }: { children: React.ReactNode }): React.ReactElement {
  useDynamicBackground()
  const mode = useAtomValue(themeModeAtom)
  const style = useAtomValue(themeStyleAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const setSystemIsDark = useSetAtom(systemIsDarkAtom)
  const store = useStore()

  // 系统明暗：Electron nativeTheme（权威）+ matchMedia 兜底
  useEffect(() => {
    const api = getElectronThemeApi()
    let disposed = false
    let unsubElectron: (() => void) | undefined

    const applySystem = (dark: boolean): void => {
      if (disposed) return
      setSystemIsDark(dark)
    }

    // 立即：matchMedia 兜底，避免 IPC 返回前闪错
    applySystem(matchMediaDark())

    if (api?.getSystemDark) {
      void api.getSystemDark().then((dark) => applySystem(!!dark))
    }
    if (api?.onSystemThemeUpdated) {
      unsubElectron = api.onSystemThemeUpdated((dark) => applySystem(!!dark))
    }

    // 浏览器 / Electron 内 matchMedia 同步（部分环境会随 OS 变）
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onMql = (e: MediaQueryListEvent): void => {
      // 有 Electron IPC 时以主进程为准，忽略可能滞后的 matchMedia
      if (api?.onSystemThemeUpdated) return
      applySystem(e.matches)
    }
    mql.addEventListener('change', onMql)

    return () => {
      disposed = true
      unsubElectron?.()
      mql.removeEventListener('change', onMql)
    }
  }, [setSystemIsDark])

  // 三要素变化 → 应用 DOM + 通知主进程换窗口/Dock 图标
  useEffect(() => {
    const m = store.get(themeModeAtom)
    const s = store.get(themeStyleAtom)
    const d = store.get(systemIsDarkAtom)
    applyThemeToDOM(m, s, d)
    const resolvedDark = m === 'system' ? d : m === 'dark'
    document.documentElement.style.colorScheme = resolvedDark ? 'dark' : 'light'
  }, [mode, style, systemIsDark, store])

  return <>{children}</>
}
