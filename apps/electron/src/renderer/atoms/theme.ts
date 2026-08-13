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
  // 默认跟随系统（桌面端与 OS 深浅一致）
  return 'system'
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
/**
 * 系统是否深色。
 * - 优先由主进程 nativeTheme 经 IPC 推送（Electron 权威源）
 * - 回退 matchMedia（首屏 / 无 IPC 时）
 */
export const systemIsDarkAtom = atom<boolean>(
  typeof window !== 'undefined' ? matchMediaDarkSafe() : false,
)

/** 模块加载期可读的 matchMedia（theme.ts 顶部初始化用） */
function matchMediaDarkSafe(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** 解析后是否深色：system 跟系统，否则跟 mode */
export const resolvedDarkAtom = atom<boolean>((get) => {
  const mode = get(themeModeAtom)
  if (mode === 'system') return get(systemIsDarkAtom)
  return mode === 'dark'
})

// ===== DOM 切换 =====

/** 所有非 default 色系的 theme-* class（default 用 :root + .dark，无 theme- 类） */
const ALL_THEME_CLASSES = ALL_STYLES.flatMap((s) => [`theme-${s}-light`, `theme-${s}-dark`])

/** 解析当前应使用深色还是浅色 UI */
export function resolveIsDark(mode: ThemeMode, systemIsDark: boolean): boolean {
  return mode === 'system' ? systemIsDark : mode === 'dark'
}

/** 把解析结果同步给主进程（窗口/Dock 图标联动） */
function notifyChromeIcon(dark: boolean): void {
  try {
    const api = (window as unknown as { electronAPI?: { setResolvedDark?: (d: boolean) => void } })
      .electronAPI
    api?.setResolvedDark?.(dark)
  } catch {
    /* ignore */
  }
}

let themeDomReady = false
let activeThemeTransition: { skipTransition?: () => void } | null = null

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function commitThemeClasses(targetDark: boolean, targetClass: string | null): void {
  const html = document.documentElement
  const currentClass = ALL_THEME_CLASSES.find((c) => html.classList.contains(c)) ?? null
  if (currentClass !== targetClass) {
    if (currentClass) html.classList.remove(currentClass)
    if (targetClass) html.classList.add(targetClass)
  }
  html.classList.toggle('dark', targetDark)
  themeDomReady = true
}

/**
 * 把主题应用到 DOM：切 .dark + theme-{style}-{light|dark} class（幂等）
 *
 * 首次应用立即切，避免启动闪一下；之后换色/换深浅用 View Transition 淡过。
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

  const targetDark = resolveIsDark(mode, systemIsDark)
  const targetClass = style === 'default' ? null : `theme-${style}-${targetDark ? 'dark' : 'light'}`

  const currentDark = html.classList.contains('dark')
  const currentClass = ALL_THEME_CLASSES.find((c) => html.classList.contains(c)) ?? null

  // 幂等：签名未变时仍上报图标（主进程可能尚未收到过）
  if (currentDark === targetDark && currentClass === targetClass) {
    themeDomReady = true
    notifyChromeIcon(targetDark)
    return
  }

  const apply = (): void => {
    commitThemeClasses(targetDark, targetClass)
    notifyChromeIcon(targetDark)
  }

  type ViewTransitionLike = {
    finished: Promise<void>
    skipTransition?: () => void
  }
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => ViewTransitionLike
  }
  if (themeDomReady && !prefersReducedMotion() && typeof doc.startViewTransition === 'function') {
    activeThemeTransition?.skipTransition?.()
    const vt = doc.startViewTransition(apply)
    activeThemeTransition = vt
    void vt.finished
      .catch((err: unknown) => {
        // 连点色卡 / 叠两次 apply 会 skip 上一段过渡，不是故障。
        if (err instanceof DOMException && err.name === 'AbortError') return
        const msg = err instanceof Error ? err.message : String(err)
        if (/skipped|abort/i.test(msg)) return
        throw err
      })
      .finally(() => {
        if (activeThemeTransition === vt) activeThemeTransition = null
      })
    return
  }
  apply()
}

/** 切深浅模式（写 atom + localStorage；DOM 由 ThemeInitializer 统一应用，避免叠两次过渡） */
export function setThemeMode(mode: ThemeMode, style: ThemeStyle): void {
  cacheThemeMode(mode)
  getDefaultStore().set(themeModeAtom, mode)
  void style
}
/** 切色系（写 atom + localStorage；DOM 由 ThemeInitializer 统一应用） */
export function setThemeStyle(style: ThemeStyle, mode: ThemeMode): void {
  cacheThemeStyle(style)
  getDefaultStore().set(themeStyleAtom, style)
  void mode
}

/** 当前系统是否深色（matchMedia 回退；Electron 内优先信 nativeTheme IPC） */
export function matchMediaDark(): boolean {
  return matchMediaDarkSafe()
}
