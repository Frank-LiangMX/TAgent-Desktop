/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 核心职责：
 * - 拦截 ExitPlanMode 工具调用
 * - 解析 allowedPrompts + 计划正文（plan / planFilePath），发送到渲染进程展示审批 UI
 * - 等待用户选择（批准/拒绝/反馈），返回对应 PermissionResult
 * - 返回用户选择的目标权限模式，由调用方（permission-service）切换权限模式
 *
 * 复用 AskUserService 的 Promise + Map 异步等待模式。
 *
 * 移植自 TAgent_General agent-exit-plan-service.ts；新增 plan 正文解析（spec §2.2）。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type {
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ExitPlanAllowedPrompt,
  TAgentPermissionMode,
} from '@tagent/shared'

/** 计划正文最长 64KB（与 spec §2.2 一致，避免超大 plan 撑爆渲染层） */
const PLAN_TEXT_MAX_BYTES = 64 * 1024

/** ExitPlanMode 审批结果（扩展 SDK PermissionResult，附加 targetMode） */
export type ExitPlanPermissionResult =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
      /** 用户选择的目标权限模式 */
      targetMode?: TAgentPermissionMode
    }
  | {
      behavior: 'deny'
      message: string
    }

/** 待处理的 ExitPlanMode 请求 */
interface PendingExitPlan {
  resolve: (result: ExitPlanPermissionResult) => void
  request: ExitPlanModeRequest
  toolInput: Record<string, unknown>
}

/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 单例模式，管理所有会话的 ExitPlanMode 请求。
 */
export class AgentExitPlanService {
  /** 待处理的请求 Map（requestId → PendingExitPlan） */
  private pendingRequests = new Map<string, PendingExitPlan>()

  /**
   * 处理 ExitPlanMode 工具调用
   *
   * 解析 allowedPrompts + 计划正文，发送到渲染进程，阻塞等待用户选择。
   */
  handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: ExitPlanModeRequest) => void
  ): Promise<ExitPlanPermissionResult> {
    const allowedPrompts = this.parseAllowedPrompts(input)
    const plan = this.resolvePlanText(input)

    const request: ExitPlanModeRequest = {
      requestId: randomUUID(),
      sessionId,
      toolInput: input,
      plan,
      allowedPrompts,
    }

    sendToRenderer(request)

    return new Promise<ExitPlanPermissionResult>((resolve) => {
      this.pendingRequests.set(request.requestId, { resolve, request, toolInput: input })

      signal.addEventListener(
        'abort',
        () => {
          if (this.pendingRequests.has(request.requestId)) {
            this.pendingRequests.delete(request.requestId)
            resolve({ behavior: 'deny', message: '操作已中止' })
          }
        },
        { once: true }
      )
    })
  }

  /**
   * 响应 ExitPlanMode 请求（由 IPC handler 调用）
   *
   * @returns { sessionId, targetMode } 用于通知编排层切换权限模式；未找到返回 null
   */
  respondToExitPlanMode(
    response: ExitPlanModeResponse
  ): { sessionId: string; targetMode: TAgentPermissionMode | null } | null {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return null

    const sessionId = pending.request.sessionId
    this.pendingRequests.delete(response.requestId)

    switch (response.action) {
      case 'approve_auto': {
        // 批准 + 切换到完全自动模式
        pending.resolve({
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'bypassPermissions',
        })
        return { sessionId, targetMode: 'bypassPermissions' }
      }
      case 'approve_edit': {
        // 批准 + 切换到自动审批模式
        pending.resolve({
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'auto',
        })
        return { sessionId, targetMode: 'auto' }
      }
      case 'deny': {
        // 拒绝计划
        pending.resolve({
          behavior: 'deny' as const,
          message: '用户拒绝了计划',
        })
        return { sessionId, targetMode: null }
      }
      case 'feedback': {
        // 用户提供反馈，拒绝并附带反馈内容
        pending.resolve({
          behavior: 'deny' as const,
          message: response.feedback ?? '用户要求修改计划',
        })
        return { sessionId, targetMode: null }
      }
      default: {
        pending.resolve({
          behavior: 'deny' as const,
          message: '未知操作',
        })
        return { sessionId, targetMode: null }
      }
    }
  }

  /**
   * 获取当前所有待处理的 ExitPlanMode 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): ExitPlanModeRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request)
  }

  /**
   * 清除指定会话的所有待处理请求（会话停止 / 删除时调用）。
   * @returns 被清除的 requestId 列表（供调用方推 EXIT_PLAN_MODE_RESOLVED 让渲染层出队，避免停后残留横幅）
   */
  clearSessionPending(sessionId: string): string[] {
    const cleared: string[] = []
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        this.pendingRequests.delete(requestId)
        cleared.push(requestId)
      }
    }
    return cleared
  }

  /**
   * 从工具输入中解析 allowedPrompts
   */
  private parseAllowedPrompts(input: Record<string, unknown>): ExitPlanAllowedPrompt[] {
    const raw = input.allowedPrompts
    if (!Array.isArray(raw)) return []

    return raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(
        (item): ExitPlanAllowedPrompt => ({
          tool: typeof item.tool === 'string' ? (item.tool as 'Bash') : 'Bash',
          prompt: typeof item.prompt === 'string' ? item.prompt : '',
        })
      )
      .filter((item) => item.prompt.length > 0)
  }

  /**
   * 解析计划正文：优先 toolInput.plan；空则读 toolInput.planFilePath（UTF-8，限 64KB）。
   * 读失败 / 超限 / 都缺 → 返回 ''（Banner 仅展示选项，不渲染正文）。
   */
  private resolvePlanText(input: Record<string, unknown>): string {
    const directPlan = typeof input.plan === 'string' ? input.plan : ''
    if (directPlan.trim()) return this.capText(directPlan)

    const planFilePath = typeof input.planFilePath === 'string' ? input.planFilePath : ''
    if (!planFilePath) return ''
    try {
      const buf = readFileSync(planFilePath)
      const text = buf.subarray(0, PLAN_TEXT_MAX_BYTES).toString('utf8')
      return this.capText(text)
    } catch (err) {
      console.warn('[ExitPlanService] 读取 planFilePath 失败:', planFilePath, err)
      return ''
    }
  }

  /** 截断到 64KB（按字符保守截，避免超大 plan 撑爆渲染层） */
  private capText(text: string): string {
    if (text.length <= PLAN_TEXT_MAX_BYTES) return text
    return text.slice(0, PLAN_TEXT_MAX_BYTES)
  }
}

/** 全局 ExitPlanMode 服务实例 */
export const exitPlanService = new AgentExitPlanService()
