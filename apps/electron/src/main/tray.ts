/**
 * 系统托盘（常驻）
 *
 * 对齐 Proma：关窗 = 隐藏，托盘右键「退出」才真正 quit。
 *
 * 平台分流：
 * - Windows：彩色 mark + 圆角底板（logo/tray/color-*.png），跟应用主题浅/深切换
 * - macOS：template 单色标（logo/tray/template.png + @2x），系统按菜单栏自动染前景色
 */
import { Tray, Menu, app, nativeImage, BrowserWindow, type NativeImage } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { setQuitting } from './lib/app-lifecycle'

let tray: Tray | null = null
let trayActions: TrayActions | null = null
/** 与窗口图标一致的解析深浅（仅 Windows 彩色托盘使用） */
let trayDark = false

export interface TrayActions {
  showMainWindow: () => void
  quitApp: () => void
}

function getResourcesDir(): string {
  const fromDist = path.join(__dirname, 'resources')
  if (existsSync(fromDist)) return fromDist
  return path.join(__dirname, '..', 'resources')
}

function trayDir(): string {
  return path.join(getResourcesDir(), 'logo', 'tray')
}

/** Windows 彩色托盘路径 */
function getWindowsTrayIconPath(dark: boolean, size: 16 | 32 = 32): string {
  const base = dark ? 'color-dark' : 'color-light'
  const name = size === 16 ? `${base}-16.png` : `${base}.png`
  const preferred = path.join(trayDir(), name)
  if (existsSync(preferred)) return preferred
  const fallback32 = path.join(trayDir(), `${base}.png`)
  if (existsSync(fallback32)) return fallback32
  return path.join(
    getResourcesDir(),
    'logo',
    'appicon',
    dark ? 'dark.png' : 'light.png',
  )
}

/** macOS template 路径（1x；@2x 由 Electron 同目录自动识别） */
function getMacTemplatePath(): string {
  const preferred = path.join(trayDir(), 'template.png')
  if (existsSync(preferred)) return preferred
  // 回退：无 template 时用 color-light 透明边距图（非 template，观感差于原生）
  return path.join(trayDir(), 'color-light.png')
}

function loadWindowsTrayImage(dark: boolean): NativeImage | null {
  try {
    // Windows 托盘多为 16×16：优先预烘焙 16
    const path16 = getWindowsTrayIconPath(dark, 16)
    const path32 = getWindowsTrayIconPath(dark, 32)
    const mainPath = existsSync(path16) ? path16 : path32
    if (!existsSync(mainPath)) {
      console.warn('[tray] win icon not found:', mainPath)
      return null
    }
    let image = nativeImage.createFromPath(mainPath)
    const size = image.getSize()
    if (size.width > 32 || size.height > 32) {
      image = image.resize({ width: 16, height: 16, quality: 'best' })
    }
    return image
  } catch (err) {
    console.error('[tray] win load failed:', err)
    return null
  }
}

function loadMacTemplateImage(): NativeImage | null {
  try {
    const iconPath = getMacTemplatePath()
    if (!existsSync(iconPath)) {
      console.warn('[tray] mac template not found:', iconPath)
      return null
    }
    // 同目录放 template@2x.png 时，createFromPath 会按 Retina 选用
    const image = nativeImage.createFromPath(iconPath)
    // 仅当确实是我们的 template 资源时标记（回退到 color 图则不要 template，否则会染成糊团）
    if (path.basename(iconPath).startsWith('template')) {
      image.setTemplateImage(true)
    }
    return image
  } catch (err) {
    console.error('[tray] mac load failed:', err)
    return null
  }
}

function loadTrayImage(dark: boolean): NativeImage | null {
  if (process.platform === 'darwin') {
    return loadMacTemplateImage()
  }
  // win32 / linux：彩色底板
  return loadWindowsTrayImage(dark)
}

function buildTrayMenu(actions: TrayActions): Menu {
  return Menu.buildFromTemplate([
    {
      label: '打开 TAgent',
      click: () => actions.showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '退出 TAgent',
      click: () => actions.quitApp(),
    },
  ])
}

function defaultActions(): TrayActions {
  return {
    showMainWindow: () => {
      const windows = BrowserWindow.getAllWindows()
      const win = windows[0]
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    quitApp: () => {
      setQuitting(true)
      app.quit()
    },
  }
}

/** 创建系统托盘；失败返回 null（关窗逻辑会 fallback 为直接退出） */
export function createTray(actionsInput?: Partial<TrayActions>): Tray | null {
  if (tray) return tray

  const actions = { ...defaultActions(), ...actionsInput }
  trayActions = actions

  const image = loadTrayImage(trayDark)
  if (!image) return null

  try {
    tray = new Tray(image)
    tray.setToolTip('TAgent')
    tray.setContextMenu(buildTrayMenu(actions))

    // 左键：显示主窗口（Windows 托盘常见习惯；mac 多为右键菜单）
    tray.on('click', () => {
      actions.showMainWindow()
    })

    tray.on('right-click', () => {
      if (!tray || !trayActions) return
      const menu = buildTrayMenu(trayActions)
      tray.setContextMenu(menu)
      tray.popUpContextMenu(menu)
    })

    console.log(
      `[tray] system tray created platform=${process.platform} mode=${
        process.platform === 'darwin' ? 'template' : 'color'
      }`,
    )
    return tray
  } catch (err) {
    console.error('[tray] create failed:', err)
    tray = null
    return null
  }
}

/**
 * 主题浅/深变化时更新托盘图标。
 * - Windows：切换 color-light / color-dark
 * - macOS：template 由系统染前景色，无需换图（忽略 dark）
 */
export function updateTrayTheme(dark: boolean): void {
  trayDark = dark
  if (!tray) return
  if (process.platform === 'darwin') {
    // template 跟随菜单栏，不必随应用主题换文件
    return
  }
  const image = loadTrayImage(dark)
  if (image) tray.setImage(image)
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
  trayActions = null
}

export function getTray(): Tray | null {
  return tray
}

/** 显示并聚焦主窗口（托盘 / activate 复用） */
export function showMainWindow(getOrCreate?: () => BrowserWindow | null): void {
  if (trayActions) {
    trayActions.showMainWindow()
    return
  }
  const win = getOrCreate?.() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
