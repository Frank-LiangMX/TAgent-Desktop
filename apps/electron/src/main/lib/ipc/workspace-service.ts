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
  deleteWorkspace,
  getOrCreateWorkspace,
  listWorkspaces,
  reorderWorkspaces,
} from '../workspace/workspace-manager'

export class WorkspaceService {
  private constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly deleteSessionsForWorkspace: (workspaceId: string) => number,
  ) {}

  static create(
    getWindow: () => BrowserWindow | null,
    deleteSessionsForWorkspace: (workspaceId: string) => number,
  ): WorkspaceService {
    const svc = new WorkspaceService(getWindow, deleteSessionsForWorkspace)
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

    // 删除工作区索引及其全部会话；本地项目源码目录保持不变。
    ipcMain.handle(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, async (_event, id: string): Promise<void> => {
      if (!listWorkspaces().some((workspace) => workspace.id === id)) {
        throw new Error(`工作区不存在: ${id}`)
      }
      const deletedSessionCount = this.deleteSessionsForWorkspace(id)
      deleteWorkspace(id)
      console.log(`[工作区] 已删除：${id}（同时删除 ${deletedSessionCount} 个会话）`)
    })

    ipcMain.handle(
      AGENT_IPC_CHANNELS.REORDER_WORKSPACES,
      async (_event, orderedIds: string[]): Promise<AgentWorkspace[]> => {
        return reorderWorkspaces(orderedIds)
      }
    )
  }
}
