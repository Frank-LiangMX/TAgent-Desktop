/**
 * 系统托盘（常驻）
 *
 * 对齐 Proma：关窗 = 隐藏，托盘右键「退出」才真正 quit。
 * 图标用彩色 mark（logo/tray/color-*.png），跟应用主题浅/深切换。
 */
import { Tray, Menu, app, nativeImage, BrowserWindow, type NativeImage } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { setQuitting } from './lib/app-lifecycle'

let tray: Tray | null = null
let trayActions: TrayActions | null = null
/** 与窗口图标一致的解析深浅 */
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

function getTrayIconPath(dark: boolean): string {
  const name = dark ? 'color-dark.png' : 'color-light.png'
  const preferred = path.join(getResourcesDir(), 'logo', 'tray', name)
  if (existsSync(preferred)) return preferred
  // 回退 appicon
  const fallback = path.join(
    getResourcesDir(),
    'logo',
    'appicon',
    dark ? 'dark.png' : 'light.png',
  )
  return fallback
}

function loadTrayImage(dark: boolean): NativeImage | null {
  const iconPath = getTrayIconPath(dark)
  if (!existsSync(iconPath)) {
    console.warn('[tray] icon not found:', iconPath)
    return null
  }
  try {
    let image = nativeImage.createFromPath(iconPath)
    // Windows 托盘建议 16/32；过大时缩小
    const size = image.getSize()
    if (size.width > 32 || size.height > 32) {
      image = image.resize({ width: 16, height: 16, quality: 'best' })
    }
    return image
  } catch (err) {
    console.error('[tray] failed to load icon:', err)
    return null
  }
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

    // 左键：显示主窗口（Windows 托盘常见习惯）
    tray.on('click', () => {
      actions.showMainWindow()
    })

    // 右键：刷新菜单后弹出（部分平台 setContextMenu 已够用）
    tray.on('right-click', () => {
      if (!tray || !trayActions) return
      const menu = buildTrayMenu(trayActions)
      tray.setContextMenu(menu)
      tray.popUpContextMenu(menu)
    })

    console.log('[tray] system tray created')
    return tray
  } catch (err) {
    console.error('[tray] create failed:', err)
    tray = null
    return null
  }
}

/** 主题浅/深变化时更新托盘图标 */
export function updateTrayTheme(dark: boolean): void {
  trayDark = dark
  if (!tray) return
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
