/**
 * 权限审批服务
 *
 * 给 kscc 核（createCanUseTool，SDK 签名）+ Pi 核（createBeforeToolCall，pi-agent-core 签名）
 * 共享的权限审批逻辑。只读静默放行（isAutoModeAutoAllowTool）/ 危险命令拦截 / 写操作弹框
 * （发 IPC PERMISSION_REQUEST 给 renderer，等 PERMISSION_RESPOND 响应）。
 *
 * 「始终允许」见 session-whitelist.ts（Bash 会话整类放行，对齐 General）。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import {
  AGENT_IPC_CHANNELS,
  extractBashCommand,
  hasWriteStructure,
  isAutoModeAutoAllowTool,
  isDangerousCommand,
  isWriteTool,
} from '@tagent/shared'
import type { TAgentPermissionMode } from '@tagent/shared'
import {
  addToSessionWhitelist,
  clearSessionWhitelist,
  isSessionWhitelisted,
} from './session-whitelist'

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
  toolName: string
  input: Record<string, unknown>
}

/** pending 请求 Map：reqId → Pending */
const pending = new Map<string, Pending>()

let counter = 0
function nextId(): string {
  counter += 1
  return `perm-${Date.now()}-${counter}`
}

/** 规范化工具入参（Pi 优先用 beforeToolCall 的 validated args） */
function resolveToolInput(
  toolCall: { arguments?: Record<string, unknown> },
  args?: unknown,
): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  if (toolCall.arguments && typeof toolCall.arguments === 'object') {
    return toolCall.arguments
  }
  return {}
}

/** 发权限请求给 renderer 弹框，返回 Promise<allow|deny> */
function askRenderer(
  win: BrowserWindow | null,
  req: PermissionRequest,
): Promise<'allow' | 'deny'> {
  return new Promise((resolve) => {
    pending.set(req.id, {
      resolve,
      sessionId: req.sessionId,
      toolName: req.toolName,
      input: req.input,
    })
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

  // 会话白名单：「始终允许」后放行（危险/写结构 Bash 除外）
  if (isSessionWhitelisted(sessionId, toolName, input)) {
    return { allow: true }
  }

  // 只读 / 项目内非破坏性 Bash：静默放行（auto/plan 都放行只读工具）
  if (isAutoModeAutoAllowTool(toolName, input, cwd)) return { allow: true }

  // plan 模式：写操作拒绝（只读已放行，其余拒绝）
  if (permissionMode === 'plan') {
    return { allow: false, reason: '计划模式下不允许写操作/执行命令' }
  }

  // auto 模式：写操作/命令弹框确认
  const isBash = toolName.toLowerCase() === 'bash'
  const command = isBash ? extractBashCommand(input) : typeof input.command === 'string' ? input.command : ''
  const dangerous =
    isDangerousCommand(command) ||
    (isBash && hasWriteStructure(command)) ||
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
    ipcMain.on(
      AGENT_IPC_CHANNELS.PERMISSION_RESPOND,
      (
        _e,
        args: { reqId: string; behavior: 'allow' | 'deny'; remember?: boolean },
      ) => {
        const p = pending.get(args.reqId)
        if (!p) return
        pending.delete(args.reqId)
        // 始终允许 → 会话级工具白名单（Bash 整类，非单条 command）
        if (args.behavior === 'allow' && args.remember) {
          addToSessionWhitelist(p.sessionId, p.toolName, p.input)
        }
        p.resolve(args.behavior)
      },
    )
  }

  /**
   * kscc 核 canUseTool（Claude Agent SDK 签名）
   * 返回 { behavior: 'allow'|'deny', message? }
   */
  createCanUseTool(sessionId: string, getMode: () => TAgentPermissionMode, cwd?: string) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
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
   * 返回 { block: true, reason } 阻止；undefined 则放行。
   * 入参优先用 validated `args`（schema 校验后），回退 toolCall.arguments。
   */
  createBeforeToolCall(sessionId: string, getMode: () => TAgentPermissionMode, cwd?: string) {
    return async (ctx: {
      toolCall: { name: string; arguments?: Record<string, unknown> }
      args?: unknown
    }): Promise<{ block: true; reason: string } | undefined> => {
      const input = resolveToolInput(ctx.toolCall, ctx.args)
      const { allow, reason } = await checkPermission({
        win: this.getWindow,
        sessionId,
        toolName: ctx.toolCall.name,
        input,
        cwd,
        permissionMode: getMode(),
      })
      return allow ? undefined : { block: true, reason: reason ?? '权限拒绝' }
    }
  }

  /** 清除会话白名单（会话删除时） */
  static clearWhitelist(sessionId: string): void {
    clearSessionWhitelist(sessionId)
  }
}
