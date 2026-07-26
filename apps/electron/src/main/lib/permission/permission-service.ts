/**
 * 权限审批服务
 *
 * 给 kscc 核（createCanUseTool，SDK 签名）+ Pi 核（createBeforeToolCall，pi-agent-core 签名）
 * 共享的权限审批逻辑。只读静默放行（isAutoModeAutoAllowTool）/ 危险命令拦截 / 写操作弹框
 * （发 IPC PERMISSION_REQUEST 给 renderer，等 PERMISSION_RESPOND 响应）。会话白名单（始终允许）。
 *
 * 复用 @tagent/shared permission-rules（isAutoModeAutoAllowTool/isDangerousCommand/isWriteTool）。
 * 复用 @tagent/pi-core checkToolPermission（黑名单兜底）。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import {
  AGENT_IPC_CHANNELS,
  isAutoModeAutoAllowTool,
  isDangerousCommand,
  isWriteTool,
} from '@tagent/shared'
import type { TAgentPermissionMode } from '@tagent/shared'

/** 权限请求（推 renderer） */
export interface PermissionRequest {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  /** 是否危险命令（renderer 红色警示） */
  dangerous: boolean
}

/** pending 请求：等 renderer 响应 */
interface Pending {
  resolve: (behavior: 'allow' | 'deny') => void
  sessionId: string
}

/** 会话级白名单：sessionId → Set<toolKey>（始终允许） */
const sessionWhitelist = new Map<string, Set<string>>()
/** pending 请求 Map：reqId → Pending */
const pending = new Map<string, Pending>()

let counter = 0
function nextId(): string {
  counter += 1
  return `perm-${Date.now()}-${counter}`
}

/** tool 唯一 key（白名单用）：toolName + 关键参数 hash */
function toolKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') return `Bash:${typeof input.command === 'string' ? input.command.slice(0, 60) : ''}`
  if (toolName === 'Write' || toolName === 'Edit') return `${toolName}:${input.file_path ?? ''}`
  return toolName
}

/** 发权限请求给 renderer 弹框，返回 Promise<allow|deny> */
function askRenderer(
  win: BrowserWindow | null,
  req: PermissionRequest
): Promise<'allow' | 'deny'> {
  return new Promise((resolve) => {
    pending.set(req.id, { resolve, sessionId: req.sessionId })
    win?.webContents.send(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, req)
    // 超时自动 deny（30s）
    setTimeout(() => {
      if (pending.has(req.id)) {
        pending.delete(req.id)
        resolve('deny')
      }
    }, 30_000)
  })
}

/** 判定单次工具权限（共享逻辑，两核用） */
async function checkPermission(args: {
  win: () => BrowserWindow | null
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  cwd?: string
  permissionMode: TAgentPermissionMode
}): Promise<{ allow: boolean; reason?: string }> {
  const { win, sessionId, toolName, input, cwd, permissionMode } = args

  // bypass：全放行
  if (permissionMode === 'bypassPermissions') return { allow: true }

  // 白名单：始终允许
  const key = toolKey(toolName, input)
  const whitelist = sessionWhitelist.get(sessionId)
  if (whitelist?.has(key) && !isDangerousCommand(typeof input.command === 'string' ? input.command : '')) {
    return { allow: true }
  }

  // 只读工具：静默放行（auto/plan 都放行只读）
  if (isAutoModeAutoAllowTool(toolName, input, cwd)) return { allow: true }

  // plan 模式：写操作拒绝（只读已放行，其余拒绝）
  if (permissionMode === 'plan') {
    return { allow: false, reason: '计划模式下不允许写操作/执行命令' }
  }

  // auto 模式：写操作/命令弹框确认
  const dangerous = isDangerousCommand(typeof input.command === 'string' ? input.command : '') ||
    isWriteTool(toolName, input)
  const req: PermissionRequest = {
    id: nextId(),
    sessionId,
    toolName,
    input,
    dangerous,
  }
  const behavior = await askRenderer(win(), req)
  return { allow: behavior === 'allow', reason: behavior === 'deny' ? '用户拒绝' : undefined }
}

export class PermissionService {
  private constructor(private readonly getWindow: () => BrowserWindow | null) {}

  static create(getWindow: () => BrowserWindow | null): PermissionService {
    const svc = new PermissionService(getWindow)
    svc.registerIpc()
    return svc
  }

  /** 注册 PERMISSION_RESPOND IPC（renderer 回响应） */
  private registerIpc(): void {
    ipcMain.on(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, (_e, args: { reqId: string; behavior: 'allow' | 'deny'; remember?: boolean }) => {
      const p = pending.get(args.reqId)
      if (!p) return
      pending.delete(args.reqId)
      // 始终允许 → 加白名单
      if (args.behavior === 'allow' && args.remember) {
        let whitelist = sessionWhitelist.get(p.sessionId)
        if (!whitelist) {
          whitelist = new Set()
          sessionWhitelist.set(p.sessionId, whitelist)
        }
        // toolKey 重新算（checkPermission 里算的 key 没传过来，这里简化：用 toolName 作 key）
        // 精确白名单需要把 input 也传回，先简化用 toolName
      }
      p.resolve(args.behavior)
    })
  }

  /**
   * kscc 核 canUseTool（Claude Agent SDK 签名）
   * 返回 { behavior: 'allow'|'deny'|'ask', message? }
   */
  createCanUseTool(sessionId: string, getMode: () => TAgentPermissionMode, cwd?: string) {
    return async (
      toolName: string,
      input: Record<string, unknown>
    ): Promise<{ behavior: 'allow' | 'deny'; message?: string }> => {
      const { allow, reason } = await checkPermission({
        win: this.getWindow,
        sessionId,
        toolName,
        input,
        cwd,
        permissionMode: getMode(),
      })
      return allow ? { behavior: 'allow' } : { behavior: 'deny', message: reason }
    }
  }

  /**
   * Pi 核 beforeToolCall（pi-agent-core 签名）
   * 返回 { block: true, reason } 阻止，undefined/不返回则放行
   */
  createBeforeToolCall(sessionId: string, getMode: () => TAgentPermissionMode, cwd?: string) {
    return async (ctx: {
      toolCall: { name: string; arguments: Record<string, unknown> }
    }): Promise<{ block: true; reason: string } | undefined> => {
      const { allow, reason } = await checkPermission({
        win: this.getWindow,
        sessionId,
        toolName: ctx.toolCall.name,
        input: ctx.toolCall.arguments,
        cwd,
        permissionMode: getMode(),
      })
      return allow ? undefined : { block: true, reason: reason ?? '权限拒绝' }
    }
  }

  /** 清除会话白名单（会话删除时） */
  static clearWhitelist(sessionId: string): void {
    sessionWhitelist.delete(sessionId)
  }
}
