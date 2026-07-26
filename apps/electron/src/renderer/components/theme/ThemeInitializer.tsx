/**
 * ThemeInitializer — 主题初始化 + 系统主题监听
 *
 * 1. 挂载时读 atom（localStorage 初值）+ matchMedia 系统 → applyThemeToDOM（首屏防闪）
 * 2. 订阅 matchMedia change → setSystemIsDarkAtom
 * 3. 监听 themeMode/themeStyle/systemIsDark 变化 → applyThemeToDOM
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

export function ThemeInitializer({ children }: { children: React.ReactNode }): React.ReactElement {
  const mode = useAtomValue(themeModeAtom)
  const style = useAtomValue(themeStyleAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const setSystemIsDark = useSetAtom(systemIsDarkAtom)
  const store = useStore()

  // 订阅系统明暗变化（matchMedia），同步到 atom
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemIsDark(mql.matches)
    const onChange = (e: MediaQueryListEvent): void => setSystemIsDark(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [setSystemIsDark])

  // 三要素变化 → 应用 DOM（用 store 读最新值，避免闭包旧值）
  useEffect(() => {
    const m = store.get(themeModeAtom)
    const s = store.get(themeStyleAtom)
    const d = store.get(systemIsDarkAtom)
    applyThemeToDOM(m, s, d)
  }, [mode, style, systemIsDark, store])

  return <>{children}</>
}
