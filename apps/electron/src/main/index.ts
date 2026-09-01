/**
 * TAgent-Desktop 主进程入口
 *
 * 2.0 骨架：双核适配 + 长驻会话 + 托盘常驻（关窗隐藏，托盘退出）。
 */
import { app, BrowserWindow, Menu, ipcMain, nativeImage, nativeTheme } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { SessionService } from './lib/ipc/session-service'
import { ChannelService } from './lib/ipc/channel-service'
import { WorkspaceService } from './lib/ipc/workspace-service'
import { BrowserService } from './lib/ipc/browser-service'
import { McpService } from './lib/ipc/mcp-service'
import { PluginService } from './lib/ipc/plugin-service'
import { MemoryService } from './lib/ipc/memory-service'
import { UserProfileService } from './lib/ipc/user-profile-service'
import { SystemPromptService } from './lib/ipc/system-prompt-service'
import { BalanceService } from './lib/ipc/balance-service'
import { PermissionService } from './lib/permission/permission-service'
import {
  seedBuiltinChannels,
  migrateModelWindows,
  syncKsccChannelAvailability,
  syncKsccDefaultModels,
  syncCodexDefaultModels,
} from './lib/channel/channel-store'
import { getIsQuitting, setQuitting } from './lib/app-lifecycle'
import { stopAutomationScheduler } from './lib/automation-scheduler'
import { createTray, destroyTray, getTray, updateTrayTheme } from './tray'
import { initAutoUpdater, configureUpdater, cleanupUpdater, registerUpdaterIpc } from './lib/updater'
import {
  memoryLayerService,
  scheduledCleanupService,
  selfRepairService,
  reflectService,
  resolveIdleConsolidationFlag,
  setMemoryForegroundActivityProbe,
  startIdleConsolidationScheduler,
  stopIdleConsolidationScheduler,
} from './lib/memory'
// type-only：esbuild 去类型不引入运行时模块；仅用于持有 transport bootstrap 句柄类型。
import type { FusionRoomTransportBootstrapResult } from './lib/collaboration/fusion-room-transport-bootstrap'

// cjs 打包格式下 __dirname 是全局可用，无需 fileURLToPath

/** 主窗口引用（SessionService 推 IPC 用） */
let mainWindow: BrowserWindow | null = null
let sessionService: SessionService | null = null
let browserService: BrowserService | null = null
let permissionService: PermissionService | null = null
/** P0-3c：FusionRoom transport bootstrap 结果句柄；`before-quit` 时 close 其 runtime。 */
let fusionTransportBootstrap: FusionRoomTransportBootstrapResult | null = null

// Windows 的 LCD/ClearType 次像素文字在透明渐变与 backdrop-filter 叠层上滚动时，
// 容易出现彩色高光边缘和视觉拖影。与旧版保持一致，改用灰度抗锯齿。
// Chromium 命令行开关必须在 app ready 之前设置，热更新无法使其生效。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-lcd-text')
}

// macOS：首次启动时自动清除 quarantine 隔离属性
// 用户从 GitHub Releases / 浏览器下载的 .zip/.dmg 会被 macOS 标记为"已下载的应用"，
// 导致 Gatekeeper 拦截显示"TAgent 已损坏，无法打开"。
// 此处以静默方式移除自身 quarantine 属性，避免用户手动执行 xattr 命令。
if (process.platform === 'darwin' && app.isPackaged) {
  try {
    const appBundlePath = path.join(process.execPath, '..', '..', '..')
    execSync(`xattr -cr "${appBundlePath}"`, { timeout: 5000 })
    console.log('[启动] 已自动清除 macOS quarantine 隔离属性')
  } catch (err) {
    console.warn('[启动] 清除 quarantine 属性失败（可忽略）:', (err as Error).message)
  }
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

/** P0-3c：把 transport bootstrap 结果摘要打到主进程日志（替代旧 console.log 占位）。 */
function logFusionTransportBootstrap(bootstrap: FusionRoomTransportBootstrapResult): void {
  switch (bootstrap.status) {
    case 'listening':
      console.log(
        `[collaboration] 非 loopback HTTPS transport 监听中：https://${bootstrap.host}:${bootstrap.address.port}`,
      )
      break
    case 'loopback_only':
      console.log(
        `[collaboration] loopback-only HTTP transport 监听中：http://127.0.0.1:${bootstrap.address.port}`,
      )
      break
    case 'failed':
      console.warn('[collaboration] transport 启动失败：', bootstrap.error)
      break
    case 'disabled':
      console.log('[collaboration] transport 未启动：', bootstrap.reasons.join('; '))
      break
  }
}

/** P0-3c：进程退出前关闭 transport runtime（fire-and-forget；OS 退出回收端口）。 */
function closeFusionTransportOnQuit(): void {
  const bootstrap = fusionTransportBootstrap
  fusionTransportBootstrap = null
  if (!bootstrap) return
  if (bootstrap.status === 'listening' || bootstrap.status === 'loopback_only') {
    void bootstrap.runtime.close().catch((err) => {
      console.warn('[collaboration] transport close failed:', err)
    })
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

  try {
    seedBuiltinChannels()
    // 这些渠道初始化包含本机 CLI 路径判断，必须在窗口创建前完成，
    // 避免窗口已显示后主进程被同步 where/spawn 卡住。
    syncKsccChannelAvailability()
    syncKsccDefaultModels()
    syncCodexDefaultModels()
    migrateModelWindows()
  } catch (err) {
    // 渠道迁移失败不能阻断后续 IPC 注册；用户仍应能打开设置并修复配置。
    console.error('[渠道存储] 启动初始化失败，已跳过本轮迁移:', err)
  }
  createWindow()

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
  SystemPromptService.create()
  BalanceService.create()
  MemoryService.create()
  // 角色库 IPC（seed DEFAULT_ROLES + CRUD + 商店）
  const { registerAgentRoleIpcHandlers } = await import('./lib/role/agent-role-ipc')
  registerAgentRoleIpcHandlers()
  const { registerBotIpcHandlers } = await import('./lib/bot/bot-profile-ipc')
  registerBotIpcHandlers()
  // 看板 IPC + 调度器（Work 守卫、resolveForWorker、stub 工人状态机）
  const { registerKanbanIpc } = await import('./lib/kanban/kanban-ipc')
  registerKanbanIpc()
  const { bootstrapKanban } = await import('./lib/kanban/kanban-bootstrap')
  bootstrapKanban(() => mainWindow)
  // 协作室 / 网络显式闸门（P0-3）：开发环境恒开 IPC；打包版默认全关，
  // 仅当用户显式打开 enableCollaboration 才注册协作室 IPC；enableNetworkListen 还需
  // 存在 active 且未过期的 TLS 证书。默认 prefs 全关 → 打包行为与原先 !app.isPackaged 一致。
  const {
    decidePackagedCollaborationGate,
    loadFusionRoomNetworkPrefs,
  } = await import('./lib/collaboration/fusion-room-network-prefs')
  const { FusionRoomCertStore } = await import('./lib/collaboration/fusion-room-cert-store')
  const {
    getCollaborationDir,
    getFusionRoomNetworkPrefsPath,
    getFusionRoomSnapshotsPath,
    getFusionRoomInviteTokensPath,
  } = await import('./lib/config/config-paths')
  const { registerFusionRoomNetworkPrefsIpc } = await import(
    './lib/collaboration/fusion-room-network-prefs-ipc'
  )
  const fusionPrefs = loadFusionRoomNetworkPrefs(getFusionRoomNetworkPrefsPath())
  const fusionCertStore = new FusionRoomCertStore({ dir: getCollaborationDir() })
  const fusionGate = decidePackagedCollaborationGate({
    isPackaged: app.isPackaged,
    prefs: fusionPrefs,
    hasActiveCert: fusionCertStore.hasActiveCert(),
  })
  if (fusionGate.registerIpc) {
    const { registerCollaborationRoomIpc } = await import('./lib/collaboration/collaboration-ipc')
    registerCollaborationRoomIpc(
      () => mainWindow,
      (sessionId) => sessionService?.notifySessionMetaChanged(sessionId),
    )
  } else {
    console.log('[collaboration] disabled:', fusionGate.reasons.join('; '))
  }
  // P0-3c：据闸门 + cert store 的 active TLS 材料接通 transport 启动。默认 prefs 全关 / 无证书
  // → disabled（与今天默认打包行为一致）；仅 allowNonLoopbackListen + active 证书才起 HTTPS 非 loopback。
  // 本切片不做真实账户 OAuth：fallback 认证 deny-all，仅邀请令牌可访问。enableDefaultMemberExecution
  // 始终 false（远程 / 打包不自动开执行）；enableDevLoopbackTransport 默认 false（不无显式开关就起 loopback HTTP）。
  const { bootstrapFusionRoomTransport } = await import(
    './lib/collaboration/fusion-room-transport-bootstrap'
  )
  fusionTransportBootstrap = await bootstrapFusionRoomTransport({
    gate: fusionGate,
    certStore: fusionCertStore,
    snapshotPath: getFusionRoomSnapshotsPath(),
    inviteTokenPath: getFusionRoomInviteTokensPath(),
  })
  logFusionTransportBootstrap(fusionTransportBootstrap)
  // 始终注册偏好 / 证书管理 IPC，让用户能显式控制闸门；它本身不注册协作室 IPC、不开网络监听。
  // gate-status 用启动时应用的决策（fusionGate）作为 applied，渲染层据此显示「需重启生效」徽章；
  // transport:status 用 bootstrap 结果的只读投影（剥离 runtime 句柄）回传渲染层。
  registerFusionRoomNetworkPrefsIpc({
    isPackaged: app.isPackaged,
    appliedGate: fusionGate,
    getTransportBootstrap: () => fusionTransportBootstrap,
  })
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
  const { registerAutomationIpc } = await import('./lib/automation-ipc')
  registerAutomationIpc()
  // Automation：复用当前 2.0 SessionService，后台执行不经过 renderer IPC。
  const { startAutomationScheduler } = await import('./lib/automation-scheduler')
  const { isSameLocalDay } = await import('@tagent/shared')
  const { createSession, getSessionMeta, updateSessionMeta } = await import('./lib/agent/session-store')
  startAutomationScheduler({
    runAutomation: async (automation) => {
      let sessionId: string | undefined
      const last = automation.lastSessionId ? getSessionMeta(automation.lastSessionId) : undefined
      if (last && !last.automationGraduated) {
        const dailyReuse = automation.sessionMode !== 'reuse' &&
          automation.lastRunAt !== undefined &&
          isSameLocalDay(automation.lastRunAt, Date.now())
        if (automation.sessionMode === 'reuse' || dailyReuse) sessionId = last.id
      }
      if (!sessionId) {
        const created = createSession({
          title: automation.name,
          channelId: automation.channelId,
          modelId: automation.modelId,
          workspaceId: automation.workspaceId,
          mode: 'general',
          executionMode: 'work',
          permissionMode: automation.permissionMode ?? 'bypassPermissions',
        })
        sessionId = created.id
        updateSessionMeta(sessionId, { sourceAutomationId: automation.id })
      }
      const currentSessionId = sessionId
      const service = sessionService
      if (!service) throw new Error('SessionService 尚未初始化')
      await service.runAutomatedTurn({
        sessionId: currentSessionId,
        prompt: automation.prompt,
        channelId: automation.channelId,
        model: automation.modelId,
        workspaceId: automation.workspaceId,
        contextPrompt: `这是定时任务「${automation.name}」的自动执行。直接执行当前任务，不要再次创建定时任务；如需调整频率或内容，请更新当前任务。`,
      })
      return { sessionId: currentSessionId }
    },
  })
  browserService = BrowserService.create(() => mainWindow)
  setMemoryForegroundActivityProbe(() => sessionService?.hasActiveAgents() ?? false)
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

  // CLI 工人探测改为设置页显式触发；避免启动后同步 where/--version 扫描占用主进程。
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
  stopAutomationScheduler()
  try {
    stopIdleConsolidationScheduler()
    memoryLayerService.close()
    scheduledCleanupService.close()
    selfRepairService.close()
    reflectService.close()
  } catch (err) {
    console.error('[memory] shutdown cleanup failed:', err)
  }
  // P0-3c：关闭 FusionRoom transport runtime（若有）
  closeFusionTransportOnQuit()
  cleanupUpdater()
  browserService?.dispose()
  sessionService?.disposeAll()
  destroyTray()
})
