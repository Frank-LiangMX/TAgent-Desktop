/**
 * TAgent-Desktop 主进程入口
 *
 * 2.0 骨架重构版。见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md。
 * 当前阶段：最小骨架，起一个 Electron 窗口加载 renderer。
 * 后续接入：双核适配层 + 长驻会话运行时 + agent 功能。
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { SessionService } from './lib/ipc/session-service'

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
  createWindow()
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
