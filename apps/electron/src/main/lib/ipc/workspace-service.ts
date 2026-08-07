/**
 * 工作区服务：注册 WORKSPACE 相关 IPC handler
 *
 * 使用 @tagent/shared 的 AGENT_IPC_CHANNELS 中已定义的通道名。
 * 职责：
 * - 列出所有工作区
 * - 创建项目工作区（弹出文件夹选择对话框 → getOrCreateWorkspace）
 * - 读取文件预览（存在即可读，不因工作区边界拒绝——Agent 能改则应能看）
 *
 * 见 shared/types/agent.ts 的 AGENT_IPC_CHANNELS。
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_IPC_CHANNELS, cleanFilePathInput, msysPathToWindowsDrivePath } from '@tagent/shared'
import type { AgentWorkspace } from '@tagent/shared'
import {
  deleteWorkspace,
  getOrCreateWorkspace,
  listWorkspaces,
  reorderWorkspaces,
  resolveWorkspaceForSession,
} from '../workspace/workspace-manager'

export interface WorkspaceFileReadResult {
  /** 文本内容（html / markdown 等） */
  content?: string
  /** data URL（image / pdf 等二进制） */
  dataUrl?: string
  mime?: string
}

export type ReadWorkspaceFileInput =
  | string
  | {
      path: string
      /** 会话 id：把该会话绑定的 projectDirectory 纳入允许根（listWorkspaces 会跳过 hidden） */
      sessionId?: string
      /** 渲染层注入的 base 路径（草稿会话 / 额外根） */
      bases?: string[]
    }

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.mdc': 'text/markdown',
  '.mdx': 'text/markdown',
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
  '.mjs': 'text/plain',
  '.cjs': 'text/plain',
  '.css': 'text/css',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cc': 'text/plain',
  '.cpp': 'text/plain',
  '.cxx': 'text/plain',
  '.hpp': 'text/plain',
  '.hh': 'text/plain',
  '.cs': 'text/plain',
  '.py': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.kt': 'text/plain',
  '.build.cs': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml']

/** 统一分隔符后 resolve；Win 上再试 MSYS `/f/...` → 盘符路径 */
function normalizeToAbsolute(filePath: string): string {
  const cleaned = cleanFilePathInput(filePath)
  if (!cleaned) return cleaned
  const msys = process.platform === 'win32' ? msysPathToWindowsDrivePath(cleaned) : null
  const raw = msys ?? cleaned
  const sepNormalized = raw.replace(/\//g, path.sep).replace(/\\/g, path.sep)
  return path.resolve(sepNormalized)
}

/** 尽量 realpath（处理 junction / 大小写 / 符号链接）；失败则用 resolve 结果 */
async function resolveReal(absPath: string): Promise<string> {
  try {
    return await realpath(absPath)
  } catch {
    return absPath
  }
}

/**
 * file 是否在 root 内（含 root 自身）。
 * 用 path.relative，避免 startsWith 在尾斜杠 / 大小写 / 混分隔符下误判。
 */
export function isPathInsideRoot(fileAbs: string, rootAbs: string): boolean {
  if (!fileAbs || !rootAbs) return false
  let file = fileAbs
  let root = rootAbs
  if (process.platform === 'win32') {
    file = file.toLowerCase()
    root = root.toLowerCase()
  }
  const rel = path.relative(root, file)
  if (!rel) return true
  // 在 root 外：relative 以 .. 开头，或变成绝对路径
  if (rel.startsWith('..')) return false
  if (path.isAbsolute(rel)) return false
  return true
}

/** 收集允许读取的根：已注册工作区 + 会话工作区 + bases（去空、resolve） */
export function collectAllowedReadRoots(opts?: {
  sessionId?: string
  bases?: string[]
}): string[] {
  const roots = new Set<string>()
  for (const workspace of listWorkspaces()) {
    if (workspace.projectDirectory) {
      roots.add(normalizeToAbsolute(workspace.projectDirectory))
    }
  }
  // listWorkspaces 会跳过 hidden；会话绑定的工作区仍应可读（Files Changed 预览）
  if (opts?.sessionId) {
    const ws = resolveWorkspaceForSession(opts.sessionId)
    if (ws?.projectDirectory) {
      roots.add(normalizeToAbsolute(ws.projectDirectory))
    }
  }
  for (const base of opts?.bases ?? []) {
    if (base?.trim()) roots.add(normalizeToAbsolute(base))
  }
  return [...roots]
}

/**
 * 读取文件供预览（Files Changed / chip / 富内容）。
 *
 * **产品原则**：Agent 能改到的路径就应能预览——不再因「是否登记在工作区列表」拒绝。
 * 仅做存在性 / 普通文件 / 10MB 上限；工作区根仅用于日志诊断。
 * （本 IPC 仅桌面端受信渲染进程可调；沙箱挡预览只会制造「敢改不能看」。）
 */
async function readWorkspaceFile(
  filePath: string,
  opts?: { sessionId?: string; bases?: string[] },
): Promise<WorkspaceFileReadResult | null> {
  const abs = normalizeToAbsolute(filePath)
  if (!abs) {
    console.warn(`[工作区] 拒绝读取：路径为空`)
    return null
  }

  const resolved = await resolveReal(abs)

  // 先 stat：不存在 / 非文件 / 过大 → 明确失败；不再用工作区边界挡预览
  let size = 0
  try {
    const st = await stat(resolved)
    if (!st.isFile()) {
      console.warn(`[工作区] 不是普通文件: ${resolved}`)
      return null
    }
    size = st.size
  } catch (error) {
    console.warn(`[工作区] stat 失败: ${resolved}`, error)
    return null
  }
  if (size > 10 * 1024 * 1024) {
    console.warn(`[工作区] 文件过大，跳过预览: ${resolved}（${size} bytes）`)
    return null
  }

  // 诊断：若在已知根外仍可读（Agent 改了工作区外路径），打 warn 不拦截
  const roots = collectAllowedReadRoots(opts)
  if (roots.length > 0) {
    const realRoots = await Promise.all(roots.map((r) => resolveReal(r)))
    const inside = realRoots.some((root) => isPathInsideRoot(resolved, root))
    if (!inside) {
      console.warn(`[工作区] 预览工作区外文件（仍允许）: ${resolved}`)
    }
  }

  // .Build.cs 这类双扩展：优先取完整后缀再回退 .cs
  const base = path.basename(resolved).toLowerCase()
  const ext = base.endsWith('.build.cs') ? '.cs' : path.extname(resolved).toLowerCase()
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'

  let buf: Buffer
  try {
    buf = await readFile(resolved)
  } catch (error) {
    console.warn(`[工作区] 读取文件失败: ${resolved}`, error)
    return null
  }

  if (mime.startsWith('image/') || mime === 'application/pdf') {
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime }
  }
  if (
    TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) ||
    mime === 'application/octet-stream'
  ) {
    return { content: buf.toString('utf8'), mime }
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
    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_WORKSPACES, async (): Promise<AgentWorkspace[]> => {
      return listWorkspaces()
    })

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
      },
    )

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
      },
    )

    // 读取工作区文件：兼容旧调用 (string) 与新调用 ({ path, sessionId, bases })
    ipcMain.handle(
      AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE,
      async (_event, input: ReadWorkspaceFileInput): Promise<WorkspaceFileReadResult | null> => {
        try {
          if (typeof input === 'string') {
            return await readWorkspaceFile(input)
          }
          if (!input?.path) return null
          return await readWorkspaceFile(input.path, {
            sessionId: input.sessionId,
            bases: input.bases,
          })
        } catch (error) {
          console.warn(`[工作区] 读取文件失败:`, input, error)
          return null
        }
      },
    )
  }
}
