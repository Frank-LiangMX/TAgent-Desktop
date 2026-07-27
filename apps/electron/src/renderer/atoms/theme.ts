/**
 * 主题系统 atoms + applyThemeToDOM（轻量版，对齐 TAgent_General 机制）
 *
 * 机制：纯 CSS class 切换。tokens.css 已预生成 12 套 .theme-{color}-{light|dark} class
 * （default 用 :root + .dark，其余 5 色系各 light/dark）。applyThemeToDOM 只对
 * documentElement.classList add/remove theme-* 类 + .dark，不动态注入 CSS。
 * 换主题 = 切 class = CSS 变量自然重算 = scene 背景自动变。
 *
 * 与 TAgent_General 的差异（更干净）：
 * - themeStyle 只存色系（ocean/forest/...），不带 -light/-dark 后缀；
 *   明暗统一由 themeMode（light/dark/system）决定，不搞 special 双轨。
 * - default 色系走 light/dark mode（:root + .dark），其余色系拼 theme-${style}-${dark?dark:light}。
 * - 持久化用 localStorage（TAgent-Desktop 无 settings IPC 基建），系统主题用 matchMedia。
 */
import { atom, getDefaultStore } from 'jotai'

/** 深浅模式 */
export type ThemeMode = 'light' | 'dark' | 'system'
/** 色系（不带明暗后缀，明暗由 mode 决定） */
export type ThemeStyle = 'default' | 'ocean' | 'forest' | 'slate' | 'orange' | 'purple'

const THEME_MODE_CACHE_KEY = 'tagent-theme-mode'
const THEME_STYLE_CACHE_KEY = 'tagent-theme-style'

const ALL_STYLES: ThemeStyle[] = ['ocean', 'forest', 'slate', 'orange', 'purple']

function getCachedThemeMode(): ThemeMode {
  try {
    const cached = localStorage.getItem(THEME_MODE_CACHE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'system') return cached
  } catch {
    /* ignore */
  }
  return 'light'
}

function getCachedThemeStyle(): ThemeStyle {
  try {
    const cached = localStorage.getItem(THEME_STYLE_CACHE_KEY) as ThemeStyle | null
    if (cached && (cached === 'default' || ALL_STYLES.includes(cached))) return cached
  } catch {
    /* ignore */
  }
  return 'default'
}

function cacheThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_MODE_CACHE_KEY, mode)
  } catch {
    /* ignore */
  }
}

function cacheThemeStyle(style: ThemeStyle): void {
  try {
    localStorage.setItem(THEME_STYLE_CACHE_KEY, style)
  } catch {
    /* ignore */
  }
}

// ===== atoms =====

export const themeModeAtom = atom<ThemeMode>(getCachedThemeMode())
export const themeStyleAtom = atom<ThemeStyle>(getCachedThemeStyle())
/** 系统是否深色（matchMedia 驱动，ThemeInitializer 维护） */
export const systemIsDarkAtom = atom<boolean>(false)

/** 解析后是否深色：system 跟系统，否则跟 mode */
export const resolvedDarkAtom = atom<boolean>((get) => {
  const mode = get(themeModeAtom)
  if (mode === 'system') return get(systemIsDarkAtom)
  return mode === 'dark'
})

// ===== DOM 切换 =====

/** 所有非 default 色系的 theme-* class（default 用 :root + .dark，无 theme- 类） */
const ALL_THEME_CLASSES = ALL_STYLES.flatMap((s) => [`theme-${s}-light`, `theme-${s}-dark`])

/**
 * 把主题应用到 DOM：切 .dark + theme-{style}-{light|dark} class（幂等）
 *
 * @param mode  深浅模式
 * @param style 色系（default 不加 theme- 类，走 :root/.dark）
 * @param systemIsDark system 模式下用此值
 */
export function applyThemeToDOM(
  mode: ThemeMode,
  style: ThemeStyle = 'default',
  systemIsDark = false
): void {
  const html = document.documentElement

  const targetDark = mode === 'system' ? systemIsDark : mode === 'dark'
  const targetClass = style === 'default' ? null : `theme-${style}-${targetDark ? 'dark' : 'light'}`

  const currentDark = html.classList.contains('dark')
  const currentClass = ALL_THEME_CLASSES.find((c) => html.classList.contains(c)) ?? null

  // 幂等：签名未变直接 return
  if (currentDark === targetDark && currentClass === targetClass) return

  if (currentClass !== targetClass) {
    if (currentClass) html.classList.remove(currentClass)
    if (targetClass) html.classList.add(targetClass)
  }
  if (currentDark !== targetDark) {
    html.classList.toggle('dark', targetDark)
  }
}

/** 切深浅模式（写 atom + localStorage + 立即应用 DOM） */
export function setThemeMode(mode: ThemeMode, style: ThemeStyle): void {
  cacheThemeMode(mode)
  applyThemeToDOM(mode, style, matchMediaDark())
  getDefaultStore().set(themeModeAtom, mode)
}

/** 切色系（写 atom + localStorage + 立即应用 DOM） */
export function setThemeStyle(style: ThemeStyle, mode: ThemeMode): void {
  cacheThemeStyle(style)
  applyThemeToDOM(mode, style, matchMediaDark())
  getDefaultStore().set(themeStyleAtom, style)
}

/** 当前系统是否深色（matchMedia） */
export function matchMediaDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}
