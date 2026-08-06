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
  CHAT_MODE_BLOCK_REASON,
  buildWorkSwitchSuggestion,
  extractBashCommand,
  hasWriteStructure,
  isAutoModeAutoAllowTool,
  isChatModeBlockedTool,
  isChatModeHardStopTool,
  isDangerousCommand,
  isWriteTool,
  migrateExecutionMode,
  PERMISSION_TIMEOUT_MS,
} from '@tagent/shared'
import type { ExecutionMode, TAgentPermissionMode } from '@tagent/shared'
import { getSessionMeta, updateSessionMeta } from '../agent/session-store'
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
  /** 主进程发出请求的时间戳（renderer 倒计时对齐） */
  requestedAt: number
}

/**
 * 工具必需参数映射（兼容 pi-core 的 path/oldText 与 kscc SDK 的 file_path/old_string 两套命名）。
 * 任一字段组内有一个 key 非空即视为已提供。
 */
const TOOL_REQUIRED_PARAMS: Record<string, string[][]> = {
  Write: [['path', 'file_path'], ['content']],
  Edit: [['path', 'file_path'], ['oldText', 'old_string'], ['newText', 'new_string']],
  Bash: [['command', 'cmd', 'script', 'code']],
  Read: [['path', 'file_path']],
  Glob: [['pattern']],
  Grep: [['pattern']],
}

/**
 * 返回缺失的必需参数字段组（用于引导模型重试，对齐 Proma agent-tool-input-validator）。
 */
function findMissingRequiredParams(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const groups = TOOL_REQUIRED_PARAMS[toolName]
  if (!groups) return []
  const missing: string[] = []
  for (const group of groups) {
    const provided = group.some((key) => {
      const v = input[key]
      return v !== undefined && v !== null && v !== ''
    })
    if (!provided) missing.push(group.join('/'))
  }
  return missing
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

/** 通知渲染层某权限请求已决（超时 deny / 用户 respond 共用） */
function emitPermissionResolved(
  win: BrowserWindow | null,
  payload: {
    reqId: string
    sessionId: string
    behavior: 'allow' | 'deny'
    reason?: 'timeout' | 'user'
    toolName?: string
  },
): void {
  win?.webContents.send(AGENT_IPC_CHANNELS.PERMISSION_RESOLVED, payload)
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
    // 超时自动 deny + 通知渲染清横幅
    setTimeout(() => {
      if (pending.has(req.id)) {
        pending.delete(req.id)
        emitPermissionResolved(win, {
          reqId: req.id,
          sessionId: req.sessionId,
          behavior: 'deny',
          reason: 'timeout',
          toolName: req.toolName,
        })
        resolve('deny')
      }
    }, PERMISSION_TIMEOUT_MS)
  })
}

/**
 * Chat 拦截写操作时 → 持久化建议 + 推渲染进程确认条
 * 节流：同一会话 8s 内不重复刷条
 * dismiss 抑制：用户点过「留在 Chat」后，本会话不再自动推（尊重用户决策，
 * 避免工具循环反复拦截时一直弹「建议切 Work」）；用户主动切换模式时清除抑制。
 */
const lastWorkSuggestAt = new Map<string, number>()
const WORK_SUGGEST_THROTTLE_MS = 8_000
const dismissedSuggestionSessions = new Set<string>()

/** 用户 dismiss 模式建议（DISMISS IPC 调） */
export function dismissModeSuggestion(sessionId: string): void {
  dismissedSuggestionSessions.add(sessionId)
}

/** 用户主动切换 executionMode 时清除抑制（新意图，之后可再建议） */
export function clearModeSuggestionDismissal(sessionId: string): void {
  dismissedSuggestionSessions.delete(sessionId)
}

/**
 * Chat 模式拦截写操作时的终止回调（SessionService 注入）：
 * 终止当前 run 等用户确认切 Work，而非 deny 后让模型继续跑。
 */
let chatModeBlockHandler: ((sessionId: string, toolName: string) => void) | undefined
export function setOnChatModeBlock(
  handler: ((sessionId: string, toolName: string) => void) | undefined,
): void {
  chatModeBlockHandler = handler
}

function emitWorkSwitchSuggestion(
  win: BrowserWindow | null,
  sessionId: string,
  toolName: string,
): void {
  if (dismissedSuggestionSessions.has(sessionId)) return
  const now = Date.now()
  const prevAt = lastWorkSuggestAt.get(sessionId) ?? 0
  if (now - prevAt < WORK_SUGGEST_THROTTLE_MS) return
  lastWorkSuggestAt.set(sessionId, now)

  const suggestion = buildWorkSwitchSuggestion({
    sessionId,
    fromMode: 'chat',
    trigger: 'chat-block',
    toolName,
  })
  try {
    if (getSessionMeta(sessionId)) {
      updateSessionMeta(sessionId, { pendingExecutionModeSuggestion: suggestion })
    }
  } catch (err) {
    console.warn('[权限] 写入 pendingExecutionModeSuggestion 失败:', err)
  }
  win?.webContents.send(AGENT_IPC_CHANNELS.EXECUTION_MODE_SUGGESTION, suggestion)
}

/** 判定单次工具权限（共享逻辑，两核用） */
async function checkPermission(args: {
  win: () => BrowserWindow | null
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  cwd?: string
  permissionMode: TAgentPermissionMode
  /** 协作形态；缺省按 legacy work 兼容旧会话 */
  executionMode?: ExecutionMode
}): Promise<{ allow: boolean; reason?: string }> {
  const { win, sessionId, toolName, input, cwd, permissionMode } = args
  const executionMode = migrateExecutionMode(args.executionMode)

  // 必需参数缺失 → 直接 deny + 引导模型补全重试（不弹窗；弹窗会打断且模型无法响应）
  const missingParams = findMissingRequiredParams(toolName, input)
  if (missingParams.length > 0) {
    return {
      allow: false,
      reason: `工具 ${toolName} 缺少必需参数（${missingParams.join('、')}），请补全参数后重试`,
    }
  }

  // Chat：硬只读（在 bypass/白名单之前，防止「完全自动」穿透 Chat）
  if (executionMode === 'chat' && isChatModeBlockedTool(toolName, input, cwd)) {
    // 写盘/破坏性命令：整轮中断 + 建议切 Work。
    // Plan/SubAgent/看板等误用：软拒绝，让模型改口建议切 Work，避免「开个 Plan 就打断」。
    if (isChatModeHardStopTool(toolName, input, cwd)) {
      chatModeBlockHandler?.(sessionId, toolName)
    }
    emitWorkSwitchSuggestion(win(), sessionId, toolName)
    return { allow: false, reason: CHAT_MODE_BLOCK_REASON }
  }

  // bypass：Work 下全放行
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
    requestedAt: Date.now(),
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
        // pending 已无（超时 / 重复点击）→ 静默忽略，不报错
        if (!p) return
        pending.delete(args.reqId)
        // 始终允许 → 会话级工具白名单（Bash 整类，非单条 command）
        if (args.behavior === 'allow' && args.remember) {
          addToSessionWhitelist(p.sessionId, p.toolName, p.input)
        }
        emitPermissionResolved(this.getWindow(), {
          reqId: args.reqId,
          sessionId: p.sessionId,
          behavior: args.behavior,
          reason: 'user',
          toolName: p.toolName,
        })
        p.resolve(args.behavior)
      },
    )
  }

  /**
   * kscc 核 canUseTool（Claude Agent SDK 签名）
   *
   * allow 必须带 updatedInput（SDK Zod 联合类型运行时校验：缺字段整次权限失败，
   * 表现成「Tool permission request failed: ZodError…」——用户以为一直权限不通）。
   * 对齐 TAgent_General agent-orchestrator：{ behavior:'allow', updatedInput: input }。
   * deny 的 message 必填 string。
   */
  createCanUseTool(
    sessionId: string,
    getMode: () => TAgentPermissionMode,
    cwd?: string,
    getExecutionMode?: () => ExecutionMode,
  ) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string }
    > => {
      const { allow, reason } = await checkPermission({
        win: this.getWindow,
        sessionId,
        toolName,
        input,
        cwd,
        permissionMode: getMode(),
        executionMode: getExecutionMode?.() ?? migrateExecutionMode(undefined),
      })
      if (allow) {
        return { behavior: 'allow', updatedInput: input }
      }
      return { behavior: 'deny', message: reason ?? '权限拒绝' }
    }
  }

  /**
   * Pi 核 beforeToolCall（pi-agent-core 签名）
   * 返回 { block: true, reason } 阻止；undefined 则放行。
   * 入参优先用 validated `args`（schema 校验后），回退 toolCall.arguments。
   */
  createBeforeToolCall(
    sessionId: string,
    getMode: () => TAgentPermissionMode,
    cwd?: string,
    getExecutionMode?: () => ExecutionMode,
  ) {
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
        executionMode: getExecutionMode?.() ?? migrateExecutionMode(undefined),
      })
      return allow ? undefined : { block: true, reason: reason ?? '权限拒绝' }
    }
  }

  /** 清除会话白名单（会话删除时） */
  static clearWhitelist(sessionId: string): void {
    clearSessionWhitelist(sessionId)
  }
}
