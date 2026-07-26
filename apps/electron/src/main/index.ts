/**
 * TAgent-Desktop 主进程入口
 *
 * 2.0 骨架重构版。见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md。
 * 当前阶段：最小骨架，起一个 Electron 窗口加载 renderer。
 * 后续接入：双核适配层 + 长驻会话运行时 + agent 功能。
 */
import { app, BrowserWindow, Menu } from 'electron'
import path from 'node:path'
import { SessionService } from './lib/ipc/session-service'
import { ChannelService } from './lib/ipc/channel-service'
import { WorkspaceService } from './lib/ipc/workspace-service'
import { seedBuiltinChannels } from './lib/channel/channel-store'

// cjs 打包格式下 __dirname 是全局可用，无需 fileURLToPath

/** 主窗口引用（SessionService 推 IPC 用） */
let mainWindow: BrowserWindow | null = null
let sessionService: SessionService | null = null

/** 主窗口：开发态加载 Vite dev server，生产态加载打包产物 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow = win

  // 转发 renderer console 到主进程 stdout（诊断输入框焦点 bug：renderer 的 [诊断] 日志会出现在 dev 日志里）
  win.webContents.on('console-message', (_e, _level, message, _line, _source) => {
    if (typeof message === 'string' && message.includes('[诊断')) {
      console.log(`[renderer] ${message}`)
    }
  })

  // 开发态：Vite dev server（端口 5174，避开 TAgent 的 5173）
  // 生产态：打包后的 renderer
  const isDev = !app.isPackaged
  if (isDev) {
    void win.loadURL('http://localhost:5174')
    win.webContents.openDevTools()
  } else {
    void win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  }
}

app.whenReady().then(() => {
  // 禁用默认应用菜单：Electron 默认菜单的 Edit 项（Cut/Copy/Paste/Select All）在 Windows 上
  // 会注册全局快捷键，间歇性触发焦点重定向到菜单 owner，导致 input/textarea 点一下就失焦（输入不进去）。
  // 1.x 设了自定义菜单所以无此问题；2.0 未设菜单走默认，需显式置 null 关闭。
  // 文本编辑快捷键由 renderer 的 contentEditable/input 原生处理，不受影响。
  Menu.setApplicationMenu(null)
  createWindow()
  // seed kscc-internal 内置渠道（幂等，首次启动写入）
  seedBuiltinChannels()
  // 起渠道服务（注册渠道 IPC handler）
  ChannelService.create()
  // 起工作区服务（注册工作区 IPC handler）
  WorkspaceService.create(() => mainWindow)
  // 起会话服务（注册 IPC handler）
  sessionService = SessionService.create(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessionService?.disposeAll()
})
