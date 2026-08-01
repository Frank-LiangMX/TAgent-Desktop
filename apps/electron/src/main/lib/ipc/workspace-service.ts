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
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_IPC_CHANNELS } from '@tagent/shared'
import type { AgentWorkspace } from '@tagent/shared'
import {
  deleteWorkspace,
  getOrCreateWorkspace,
  listWorkspaces,
  reorderWorkspaces,
} from '../workspace/workspace-manager'

export interface WorkspaceFileReadResult {
  /** 文本内容（html / markdown 等） */
  content?: string
  /** data URL（image / pdf 等二进制） */
  dataUrl?: string
  mime?: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'text/xml',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml']

/** 读取工作区文件（仅限已注册工作区目录内，防路径穿越） */
async function readWorkspaceFile(filePath: string): Promise<WorkspaceFileReadResult | null> {
  const resolved = path.resolve(filePath)
  const workspaces = listWorkspaces()
  const inside = workspaces.some((workspace) => {
    const root = workspace.projectDirectory
    if (!root) return false
    const rootResolved = path.resolve(root)
    return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)
  })
  if (!inside) {
    console.warn(`[工作区] 拒绝读取工作区外文件: ${resolved}`)
    return null
  }

  const ext = path.extname(resolved).toLowerCase()
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  const buf = await readFile(resolved)
  if (buf.length > 10 * 1024 * 1024) {
    console.warn(`[工作区] 文件过大，跳过预览: ${resolved}（${buf.length} bytes）`)
    return null
  }

  if (mime.startsWith('image/') || mime === 'application/pdf') {
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime }
  }
  if (TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) || mime === 'application/octet-stream') {
    const content = buf.toString('utf8')
    return { content, mime }
  }
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime }
}

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

    // 读取工作区文件（富内容预览块用；仅限已注册工作区目录内）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE,
      async (_event, filePath: string): Promise<WorkspaceFileReadResult | null> => {
        try {
          return await readWorkspaceFile(filePath)
        } catch (error) {
          console.warn(`[工作区] 读取文件失败: ${filePath}`, error)
          return null
        }
      }
    )
  }
}
