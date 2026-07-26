/**
 * 工作区服务：注册 WORKSPACE 相关 IPC handler
 *
 * 使用 @tagent/shared 的 AGENT_IPC_CHANNELS 中已定义的通道名。
 * 职责：
 * - 列出所有工作区
 * - 创建项目工作区（弹出文件夹选择对话框 → getOrCreateWorkspace）
 * - 获取当前工作区（从 settings 读 currentWorkspaceId）
 * - 切换当前工作区（写 settings 的 currentWorkspaceId）
 *
 * 见 shared/types/agent.ts 的 AGENT_IPC_CHANNELS。
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@tagent/shared'
import type { AgentWorkspace } from '@tagent/shared'
import {
  getOrCreateWorkspace,
  listWorkspaces,
} from '../workspace/workspace-manager'
import { getConfigDir } from '../config/config-paths'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** settings 文件中工作区相关字段 */
interface WorkspaceSettings {
  currentWorkspaceId?: string
}

/** 读 settings.json 中的工作区部分 */
function readWorkspaceSettings(): WorkspaceSettings {
  const settingsPath = join(getConfigDir(), 'settings.json')
  if (!existsSync(settingsPath)) return {}
  try {
    const raw = readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as WorkspaceSettings
    return parsed
  } catch {
    return {}
  }
}

/** 写 settings.json 中的工作区部分（合并写入，不影响其他字段） */
function writeWorkspaceSettings(patch: WorkspaceSettings): void {
  const settingsPath = join(getConfigDir(), 'settings.json')
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8')
      existing = JSON.parse(raw) as Record<string, unknown>
    } catch {
      // 忽略解析错误，从空对象开始
    }
  }
  const merged = { ...existing, ...patch }
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8')
}

export class WorkspaceService {
  private constructor(private readonly getWindow: () => BrowserWindow | null) {}

  static create(getWindow: () => BrowserWindow | null): WorkspaceService {
    const svc = new WorkspaceService(getWindow)
    svc.registerIpc()
    return svc
  }

  /** 注册 IPC handler */
  private registerIpc(): void {
    // 列出所有工作区
    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_WORKSPACES, async (): Promise<AgentWorkspace[]> => {
      return listWorkspaces()
    })

    // 创建项目工作区（弹出文件夹选择对话框 → 创建 workspace）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.CREATE_PROJECT_WORKSPACE,
      async (): Promise<AgentWorkspace | null> => {
        const win = this.getWindow()
        const result = await dialog.showOpenDialog(win!, {
          properties: ['openDirectory'],
          title: '选择项目目录',
        })
        if (result.canceled || result.filePaths.length === 0) return null
        const projectPath = result.filePaths[0]!
        const workspace = getOrCreateWorkspace(projectPath)
        // 创建后自动切换为当前工作区
        writeWorkspaceSettings({ currentWorkspaceId: workspace.id })
        console.log(`[工作区] 已创建并切换到：${workspace.name}（${workspace.id}）`)
        return workspace
      }
    )

    // 获取当前工作区
    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_WORKSPACES + ':current', async (): Promise<AgentWorkspace | undefined> => {
      const settings = readWorkspaceSettings()
      if (!settings.currentWorkspaceId) return undefined
      const workspaces = listWorkspaces()
      return workspaces.find((w) => w.id === settings.currentWorkspaceId)
    })

    // 切换当前工作区
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_WORKSPACE + ':switch',
      async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
        const workspaces = listWorkspaces()
        const target = workspaces.find((w) => w.id === id)
        if (!target) {
          return { ok: false, error: `工作区不存在：${id}` }
        }
        writeWorkspaceSettings({ currentWorkspaceId: id })
        console.log(`[工作区] 已切换到：${target.name}（${id}）`)
        return { ok: true }
      }
    )
  }
}
