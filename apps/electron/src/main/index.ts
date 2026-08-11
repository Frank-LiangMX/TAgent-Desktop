/**
 * TAgent-Desktop 主进程入口
 *
 * 2.0 骨架：双核适配 + 长驻会话 + 托盘常驻（关窗隐藏，托盘退出）。
 */
import { app, BrowserWindow, Menu, ipcMain, nativeImage, nativeTheme } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { SessionService } from './lib/ipc/session-service'
import { ChannelService } from './lib/ipc/channel-service'
import { WorkspaceService } from './lib/ipc/workspace-service'
import { McpService } from './lib/ipc/mcp-service'
import { PluginService } from './lib/ipc/plugin-service'
import { MemoryService } from './lib/ipc/memory-service'
import { UserProfileService } from './lib/ipc/user-profile-service'
import { BalanceService } from './lib/ipc/balance-service'
import { PermissionService } from './lib/permission/permission-service'
import {
  seedBuiltinChannels,
  migrateModelWindows,
  syncKsccChannelAvailability,
} from './lib/channel/channel-store'
import { discoverAndReconcileCliWorkers } from './lib/agent/cli-workers-service'
import { getIsQuitting, setQuitting } from './lib/app-lifecycle'
import { createTray, destroyTray, getTray, updateTrayTheme } from './tray'
import { initAutoUpdater, configureUpdater, cleanupUpdater, registerUpdaterIpc } from './lib/updater'
import {
  memoryLayerService,
  scheduledCleanupService,
  selfRepairService,
  reflectService,
  resolveIdleConsolidationFlag,
  startIdleConsolidationScheduler,
  stopIdleConsolidationScheduler,
} from './lib/memory'

// cjs 打包格式下 __dirname 是全局可用，无需 fileURLToPath

/** 主窗口引用（SessionService 推 IPC 用） */
let mainWindow: BrowserWindow | null = null
let sessionService: SessionService | null = null
let permissionService: PermissionService | null = null

// Windows 的 LCD/ClearType 次像素文字在透明渐变与 backdrop-filter 叠层上滚动时，
// 容易出现彩色高光边缘和视觉拖影。与旧版保持一致，改用灰度抗锯齿。
// Chromium 命令行开关必须在 app ready 之前设置，热更新无法使其生效。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-lcd-text')
}

/**
 * 解析 resources 根目录：
 * - 开发：`dist/resources`（build:resources 拷贝）或源码 `resources/`
 * - 打包：`dist/resources` 在 asar 内，与 main.cjs 同级
 */
function getResourcesDir(): string {
  const fromDist = path.join(__dirname, 'resources')
  if (existsSync(fromDist)) return fromDist
  return path.join(__dirname, '..', 'resources')
}

/**
 * 应用内解析后的深浅（由渲染进程根据 浅色/深色/跟随系统 算好后上报）。
 * 窗口/Dock/托盘图标跟这个走。
 */
let appResolvedDark: boolean | null = null

/** App / 窗口图标（圆角底板 PNG）——跟应用主题解析结果联动 */
function getAppIconPath(darkOverride?: boolean): string {
  const dark =
    typeof darkOverride === 'boolean'
      ? darkOverride
      : appResolvedDark !== null
        ? appResolvedDark
        : nativeTheme.shouldUseDarkColors
  const name = dark ? 'dark.png' : 'light.png'
  return path.join(getResourcesDir(), 'logo', 'appicon', name)
}

function applyChromeIcon(dark?: boolean): void {
  if (typeof dark === 'boolean') appResolvedDark = dark
  const resolved =
    appResolvedDark !== null ? appResolvedDark : nativeTheme.shouldUseDarkColors
  const iconPath = getAppIconPath(resolved)
  if (existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath)
    mainWindow?.setIcon(img)
    if (process.platform === 'darwin') app.dock?.setIcon(img)
  }
  // 托盘彩色图标同步
  updateTrayTheme(resolved)
}

function focusMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 主窗口：开发态加载 Vite dev server，生产态加载打包产物 */
function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow()
    return
  }

  const iconPath = getAppIconPath()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // 对齐 TAgent_General：保证侧栏 + 会话主区不被无限压扁
    minWidth: 800,
    minHeight: 600,
    // Windows 隐藏系统标题栏，用自定义 WindowControls（对齐 TAgent_General）。
    // mac 用 hiddenInset 保留红绿灯；此处 Windows 走 hidden。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    show: true,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // macOS Dock 图标
  if (process.platform === 'darwin' && existsSync(iconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  }

  mainWindow = win

  // 窗口控制 IPC（自定义 WindowControls 用）
  // 注意：close 走 win.close() → 触发 close 事件 → 非退出则 hide
  ipcMain.removeHandler('window:is-maximized')
  ipcMain.handle('window:is-maximized', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    return mainWindow.isMaximized()
  })
  // 避免重复 bind（热重载/二次 createWindow）
  ipcMain.removeAllListeners('window:minimize')
  ipcMain.removeAllListeners('window:maximize')
  ipcMain.removeAllListeners('window:close')
  ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
  })
  ipcMain.on('window:maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })

  win.on('resize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:resize')
  })

  // 关窗 = 隐藏到托盘（真正退出见托盘「退出 TAgent」）
  win.on('close', (event) => {
    if (getIsQuitting()) return
    // 有托盘才隐藏；托盘创建失败时允许正常关闭并退出
    if (getTray()) {
      event.preventDefault()
      win.hide()
      // mac：隐藏窗口时也像后台应用一样可从 Dock/托盘唤回
      if (process.platform === 'darwin' && app.dock) {
        // 保持 Dock 图标，仅 hide 窗口
      }
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 转发 renderer console 到主进程 stdout
  win.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message === 'string' && message.includes('[诊断')) {
      console.log(`[renderer] ${message}`)
    }
  })

  const isDev = !app.isPackaged
  if (isDev) {
    void win.loadURL('http://localhost:5174')
    // DevTools 必须在页面加载完成后再开：本窗口 sandbox 默认开启（contextIsolation + !nodeIntegration），
    // 若在 did-finish-load 前就 openDevTools，会与 sandboxed_renderer.bundle.js 启动竞态，触发一次性报错
    // `Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null`（噪音，不影响后续加载）。
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.openDevTools()
    })
  } else {
    void win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  }
}

app.whenReady().then(async () => {
  // 禁用默认应用菜单（Windows 全局 Edit 快捷键抢焦点问题）
  Menu.setApplicationMenu(null)

  // 强制 OS 级跟随：Chromium prefers-color-scheme 与 nativeTheme 对齐
  nativeTheme.themeSource = 'system'

  // 系统明暗 → 渲染进程
  ipcMain.handle('theme:get-system-dark', () => nativeTheme.shouldUseDarkColors)
  // 应用内解析后的深浅 → 窗口/Dock/托盘图标
  ipcMain.on('theme:set-resolved-dark', (_e, dark: boolean) => {
    applyChromeIcon(!!dark)
  })
  const broadcastSystemTheme = (): void => {
    const dark = nativeTheme.shouldUseDarkColors
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('theme:system-updated', dark)
    }
  }
  nativeTheme.on('updated', () => {
    broadcastSystemTheme()
  })

  // 系统托盘（先于窗口，确保 close 时 getTray() 可用）
  createTray({
    showMainWindow: () => focusMainWindow(),
    quitApp: () => {
      setQuitting(true)
      destroyTray()
      app.quit()
    },
  })

  createWindow()
  seedBuiltinChannels()
  // 无本机 kscc 时强制停用内置渠道，避免用户无脑打开后发送才失败
  syncKsccChannelAvailability()
  migrateModelWindows()

  // Phase 2：全局记忆 L5 服务启动 wiring
  try {
    memoryLayerService.initialize()
    scheduledCleanupService.initialize()
    selfRepairService.initialize()
    const idleOn = resolveIdleConsolidationFlag(app.isPackaged)
    // 空闲整理接管时不另起 Reflect LLM 日调度
    reflectService.initialize(!idleOn)
    if (idleOn) {
      void startIdleConsolidationScheduler().catch((err) => {
        console.error('[memory] startIdleConsolidationScheduler failed:', err)
      })
    }
    console.log(`[memory] services initialized (idleConsolidation=${idleOn})`)
  } catch (err) {
    console.error('[memory] initializeMemoryServices failed:', err)
  }

  ChannelService.create()
  McpService.create()
  PluginService.create()
  UserProfileService.create()
  BalanceService.create()
  MemoryService.create()
  // 角色库 IPC（seed DEFAULT_ROLES + CRUD + 商店）
  const { registerAgentRoleIpcHandlers } = await import('./lib/role/agent-role-ipc')
  registerAgentRoleIpcHandlers()
  // 看板 IPC + 调度器（Work 守卫、resolveForWorker、stub 工人状态机）
  const { registerKanbanIpc } = await import('./lib/kanban/kanban-ipc')
  registerKanbanIpc()
  const { bootstrapKanban } = await import('./lib/kanban/kanban-bootstrap')
  bootstrapKanban(() => mainWindow)
  // 协作室 IPC（Stage 1：房间壳 + 静态成员 + 静态消息，不运行 Agent / 不 A2A / 不调度）
  const { registerCollaborationRoomIpc } = await import('./lib/collaboration/collaboration-ipc')
  registerCollaborationRoomIpc()
  // 通知偏好 IPC（通用设置 ↔ 主进程系统通知）
  const {
    loadNotificationPrefs,
    saveNotificationPrefs,
  } = await import('./lib/notification-prefs')
  ipcMain.handle('notification-prefs:get', () => loadNotificationPrefs())
  ipcMain.handle(
    'notification-prefs:set',
    (_e, prefs: Partial<ReturnType<typeof loadNotificationPrefs>>) =>
      saveNotificationPrefs(prefs ?? {}),
  )
  permissionService = PermissionService.create(() => mainWindow)
  sessionService = SessionService.create(() => mainWindow, permissionService)
  WorkspaceService.create(
    () => mainWindow,
    (workspaceId) => sessionService?.deleteWorkspaceSessions(workspaceId) ?? 0,
  )

  // 自动更新：IPC 处理器始终注册（dev 也能查 status），electron-updater 仅打包后初始化
  if (mainWindow) {
    configureUpdater(mainWindow, {
      hasActiveAgents: () => {
        return sessionService?.hasActiveAgents() ?? false
      },
    })
    registerUpdaterIpc()
    if (app.isPackaged) {
      initAutoUpdater(mainWindow)
    }
  }

  // mac Dock / 再次激活：显示窗口
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else focusMainWindow()
  })

  // CLI 工人启动对账：后台探测本机已安装 coding CLI + 对账落盘（不阻塞启动，失败仅 warn）
  setImmediate(() => {
    try {
      discoverAndReconcileCliWorkers()
    } catch (err) {
      console.warn('[cli-workers] 启动对账失败：', err)
    }
  })
})

// 托盘常驻：所有窗口关了也不退出（真正退出走托盘菜单）
app.on('window-all-closed', () => {
  if (getIsQuitting()) return
  if (!getTray() && process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  setQuitting(true)
  try {
    stopIdleConsolidationScheduler()
    memoryLayerService.close()
    scheduledCleanupService.close()
    selfRepairService.close()
    reflectService.close()
  } catch (err) {
    console.error('[memory] shutdown cleanup failed:', err)
  }
  cleanupUpdater()
  sessionService?.disposeAll()
  destroyTray()
})
