/**
 * 工作区服务：注册 WORKSPACE 相关 IPC handler
 *
 * 使用 @tagent/shared 的 AGENT_IPC_CHANNELS 中已定义的通道名。
 * 职责：
 * - 列出所有工作区
 * - 创建项目工作区（弹出文件夹选择对话框 → getOrCreateWorkspace）
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
        console.log(`[工作区] 已创建：${workspace.name}（${workspace.id}）`)
        return workspace
      }
    )
  }
}
