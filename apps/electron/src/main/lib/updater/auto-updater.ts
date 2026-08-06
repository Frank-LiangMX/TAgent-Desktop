/**
 * 自动更新核心模块
 *
 * 设计目标（从 TAgent_General 痛点修正）：
 * 1. 网络容错 — GitHub 拉取失败不直接报 error，静默重试，下次定时再检查
 * 2. Agent 感知 — 有运行中 Agent 时不自动安装，等空闲后再装
 * 3. 状态持久化 — 记录 lastSeenVersion，更新后展示 release notes
 * 4. 不自动退出 — autoInstallOnAppQuit=false，避免 Agent 运行中被杀
 * 5. 退出前清理 — 移除窗口 close 监听器，避免托盘隐藏阻止退出
 */

import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app, shell } from 'electron'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { createIdleInstallScheduler } from './idle-install-scheduler'
import { getIsQuitting, setQuitting } from '../app-lifecycle'

let currentStatus: UpdateStatus = { status: 'idle' }
let win: BrowserWindow | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null
let consecutiveFailures = 0
const MAX_CONSECUTIVE_FAILURES = 3

let hasActiveAgents = (): boolean => false

const idleInstallScheduler = createIdleInstallScheduler({
  canInstall: () => currentStatus.status === 'downloaded' && !hasActiveAgents(),
  install: () => {
    console.log('[更新] 当前没有运行中的 Agent，开始安装已下载更新')
    quitAndInstall()
  },
})

// ── 版本状态持久化 ──
const VERSION_STATE_FILE = 'updater-version-state.json'

function versionStatePath(): string {
  return join(app.getPath('userData'), VERSION_STATE_FILE)
}

interface VersionState {
  lastSeenVersion?: string
  pendingUpdate?: {
    version: string
    releaseNotes?: string
  }
}

function readVersionState(): VersionState {
  try {
    const raw = readFileSync(versionStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as VersionState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeVersionState(state: VersionState): void {
  try {
    const p = versionStatePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.warn('[更新] 写入版本状态失败:', err)
  }
}

// ── 状态管理 ──
function setStatus(status: UpdateStatus): void {
  currentStatus = status
  if (status.status !== 'downloaded') {
    idleInstallScheduler.cancel()
  }
  win?.webContents?.send(UPDATER_IPC_CHANNELS.ON_STATUS_CHANGED, status)
}

export function configureUpdater(
  mainWindow: BrowserWindow,
  options?: { hasActiveAgents?: () => boolean },
): void {
  hasActiveAgents = options?.hasActiveAgents ?? hasActiveAgents
  win = mainWindow
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

// ── 检查更新 ──
export async function checkForUpdates(): Promise<void> {
  if (currentStatus.status === 'downloading' || currentStatus.status === 'downloaded') {
    console.log('[更新] 跳过检查：已在下载中或已下载完成')
    return
  }

  if (!app.isPackaged) {
    console.log('[更新] 开发环境跳过自动更新检查')
    return
  }

  try {
    setStatus({ status: 'checking' })
    await autoUpdater.checkForUpdates()
    consecutiveFailures = 0
  } catch (err) {
    consecutiveFailures++
    const message = err instanceof Error ? err.message : String(err)

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`[更新] 连续 ${consecutiveFailures} 次检查失败，上报错误:`, message)
      setStatus({ status: 'error', error: message })
    } else {
      // 静默重试：网络波动不打扰用户，下次定时再试
      console.warn(`[更新] 检查失败（第 ${consecutiveFailures} 次），静默重试:`, message)
      setStatus({ status: 'idle' })
    }
  }
}

// ── 空闲安装 ──
export function installWhenIdle(): boolean {
  if (currentStatus.status !== 'downloaded') {
    console.warn('[更新] 跳过空闲安装：当前没有已下载的更新')
    return false
  }
  console.log('[更新] 已请求空闲安装，等待所有 Agent 结束')
  idleInstallScheduler.request()
  return true
}

export function cancelIdleInstall(): void {
  idleInstallScheduler.cancel()
  console.log('[更新] 已取消空闲安装请求')
}

// ── 安装 ──
function quitAndInstall(): void {
  if (!app.isPackaged) {
    console.warn('[更新] 开发环境不支持安装更新')
    return
  }

  if (hasActiveAgents()) {
    console.log('[更新] 检测到运行中的 Agent，改为等待空闲后安装')
    installWhenIdle()
    return
  }

  setImmediate(() => {
    if (hasActiveAgents()) {
      console.log('[更新] 安装前出现新的运行中 Agent，继续等待空闲')
      installWhenIdle()
      return
    }

    setQuitting()

    // 移除所有窗口的 close 监听器，避免托盘隐藏逻辑阻止退出
    for (const w of BrowserWindow.getAllWindows()) {
      w.removeAllListeners('close')
    }

    console.log('[更新] 退出并安装更新')
    autoUpdater.quitAndInstall(true, true)
  })
}

// ── 清理 ──
export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  idleInstallScheduler.dispose()
}

// ── 更新后展示 release notes ──
export async function showPostUpdateReleaseNotes(): Promise<void> {
  if (!app.isPackaged) return

  const currentVersion = app.getVersion().trim()
  const state = readVersionState()

  // 首次安装，记录当前版本
  if (!state.lastSeenVersion) {
    writeVersionState({ ...state, lastSeenVersion: currentVersion })
    return
  }

  // 版本没变，跳过
  if (state.lastSeenVersion === currentVersion) return

  // 检查是否真的是升级（而不是降级）
  const isNewer = isVersionGreater(currentVersion, state.lastSeenVersion)
  if (!isNewer) return

  const pendingUpdate =
    state.pendingUpdate?.version === currentVersion ? state.pendingUpdate : undefined

  writeVersionState({ lastSeenVersion: currentVersion })

  // 在主窗口中展示更新提示
  const window = win
  if (!window || window.isDestroyed()) return

  const { dialog } = await import('electron')
  const result = await dialog.showMessageBox(window, {
    type: 'info',
    title: 'TAgent 已更新',
    message: `已更新到 TAgent ${currentVersion}`,
    detail:
      pendingUpdate?.releaseNotes ??
      '此版本的完整更新内容可在 GitHub Releases 中查看。',
    buttons: ['查看更新日志', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })

  if (result.response === 0) {
    await shell.openExternal(
      `https://github.com/auser7x2y/TAgent-Desktop/releases/tag/v${currentVersion}`,
    )
  }
}

function parseVersionParts(v: string): number[] {
  const cleaned = v.trim().replace(/^v/i, '').replace(/-.*$/, '')
  return cleaned.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function isVersionGreater(latest: string, current: string): boolean {
  const a = parseVersionParts(latest)
  const b = parseVersionParts(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

// ── 初始化 ──
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  configureUpdater(mainWindow)

  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log('[更新-updater]', ...args),
    warn: (...args: unknown[]) => console.warn('[更新-updater]', ...args),
    error: (...args: unknown[]) => console.error('[更新-updater]', ...args),
    debug: (...args: unknown[]) => console.log('[更新-updater:debug]', ...args),
  }

  // 自动下载，但不在用户退出时自动安装
  // autoInstallOnAppQuit=false 是关键：避免 Agent 运行中被杀
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    console.log('[更新] 正在检查更新...')
    setStatus({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[更新] 发现新版本:', info.version)
    consecutiveFailures = 0
    setStatus({
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setStatus({
      status: 'downloading',
      version: (currentStatus as { version?: string }).version || '',
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[更新] 下载完成:', info.version)
    consecutiveFailures = 0

    // 持久化 pending update 信息，供下次启动展示
    const state = readVersionState()
    writeVersionState({
      ...state,
      pendingUpdate: {
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      },
    })

    setStatus({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[更新] 已是最新版本')
    consecutiveFailures = 0
    setStatus({ status: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    consecutiveFailures++
    console.error('[更新] 更新出错:', err)

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      setStatus({
        status: 'error',
        error: err.message,
      })
    } else {
      // 偶发网络错误静默处理，不打扰用户
      console.warn(`[更新] 偶发错误（第 ${consecutiveFailures} 次），静默处理`)
      if (currentStatus.status === 'checking') {
        setStatus({ status: 'idle' })
      }
    }
  })

  // 启动后延迟 30 秒首次检查（比 10 秒更稳，避免启动竞争）
  setTimeout(() => {
    console.log('[更新] 首次自动检查更新')
    void checkForUpdates()
  }, 30_000)

  // 每 4 小时自动检查一次
  checkInterval = setInterval(() => {
    console.log('[更新] 定时自动检查更新')
    void checkForUpdates()
  }, 4 * 60 * 60 * 1000)

  mainWindow.on('closed', () => {
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
    idleInstallScheduler.dispose()
    win = null
  })

  // 启动后检查是否刚更新过，展示 release notes
  void showPostUpdateReleaseNotes()

  console.log('[更新] 自动更新模块已初始化（自动下载，Agent 空闲时安装）')
}
