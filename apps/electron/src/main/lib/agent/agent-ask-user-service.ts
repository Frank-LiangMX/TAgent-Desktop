/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 核心职责：
 * - 拦截 AskUserQuestion 工具调用
 * - 解析问题列表，发送到渲染进程展示交互 UI
 * - 等待用户回答，通过 updatedInput 注入 answers 字段
 * - 管理 pending 请求生命周期
 *
 * 复用权限系统的 Promise + Map 异步等待模式。
 *
 * 移植自 TAgent_General（同 SDK 0.3.185 已证可用）：
 * canUseTool 拦截 AskUserQuestion → 本服务阻塞等用户作答 → updatedInput.answers 回灌，
 * SDK 因此不再发 request_user_dialog 控制帧（无需接 control_response）。
 */

import { randomUUID } from 'node:crypto'

import type { AskUserRequest, AskUserQuestion, AskUserQuestionOption } from '@tagent/shared'

/** canUseTool 返回的权限结果 */
type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message: string
      /** true：让 SDK/适配层硬停本轮，避免软 deny 后模型当失败重试 */
      interrupt?: boolean
    }

/** 待处理的 AskUser 请求 */
interface PendingAskUser {
  resolve: (result: PermissionResult) => void
  request: AskUserRequest
}

/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 单例模式，管理所有会话的 AskUser 请求。
 */
export class AgentAskUserService {
  /** 待处理的 AskUser 请求 Map（requestId → PendingAskUser） */
  private pendingRequests = new Map<string, PendingAskUser>()

  /**
   * 处理 AskUserQuestion 工具调用
   *
   * 解析问题列表，发送到渲染进程，阻塞等待用户回答，
   * 回答后通过 updatedInput 注入 answers 字段。
   */
  handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: AskUserRequest) => void
  ): Promise<PermissionResult> {
    const questions = this.parseQuestions(input)

    const request: AskUserRequest = {
      requestId: randomUUID(),
      sessionId,
      questions,
      toolInput: input,
    }

    sendToRenderer(request)

    return new Promise<PermissionResult>((resolve) => {
      this.pendingRequests.set(request.requestId, { resolve, request })

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
   * 响应 AskUser 请求（由 IPC handler 调用）
   *
   * @returns 对应的 sessionId，用于向渲染进程发送 resolved 事件；未找到返回 null
   */
  respondToAskUser(requestId: string, answers: Record<string, string>): string | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null

    const sessionId = pending.request.sessionId

    // 构建 updatedInput：保留原始输入 + 注入 answers
    const updatedInput: Record<string, unknown> = {
      ...pending.request.toolInput,
      answers,
    }

    pending.resolve({
      behavior: 'allow' as const,
      updatedInput,
    })
    this.pendingRequests.delete(requestId)
    return sessionId
  }

  /**
   * 用户关闭选项卡 / 取消作答（非选择提交）。
   * 只 resolve 软 deny 并清 pending，不中断当前轮：Agent 收到「用户未选择」后，
   * 可自行采用默认方案、换一种方式继续、重新说明必要性，或结束本轮。
   */
  dismissToAskUser(requestId: string): string | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null
    const sessionId = pending.request.sessionId
    pending.resolve({
      behavior: 'deny',
      message:
        '用户关闭了选项弹窗，未提供选择。请自行判断是采用合理默认方案、换一种方式继续，还是结束当前任务；不要立即重复提出同一个问题。',
    })
    this.pendingRequests.delete(requestId)
    return sessionId
  }

  /**
   * 获取当前所有待处理的 AskUser 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): AskUserRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request)
  }

  /**
   * 清除指定会话的所有待处理 AskUser 请求
   */
  clearSessionPending(sessionId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        this.pendingRequests.delete(requestId)
      }
    }
  }

  /**
   * 从工具输入中解析问题列表
   *
   * SDK AskUserQuestion 工具输入格式：
   * { questions: [{ question, header, options: [{ label, description, preview }], multiSelect }] }
   */
  private parseQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return []

    return rawQuestions.map((q: unknown): AskUserQuestion => {
      const raw = q as Record<string, unknown>
      const options = Array.isArray(raw.options)
        ? (raw.options as Array<Record<string, unknown>>).map(
            (o): AskUserQuestionOption => ({
              label: typeof o.label === 'string' ? o.label : '',
              description: typeof o.description === 'string' ? o.description : undefined,
              preview: typeof o.preview === 'string' ? o.preview.slice(0, 10_000) : undefined,
            })
          )
        : []

      return {
        ...(typeof raw.answerKey === 'string' && raw.answerKey
          ? { answerKey: raw.answerKey }
          : {}),
        question: typeof raw.question === 'string' ? raw.question : '',
        header: typeof raw.header === 'string' ? raw.header : undefined,
        options,
        multiSelect: raw.multiSelect === true,
        ...(typeof raw.allowOther === 'boolean'
          ? { allowOther: raw.allowOther }
          : {}),
        ...(raw.secret === true ? { secret: true } : {}),
      }
    })
  }
}

/** 全局 AskUser 服务实例 */
export const askUserService = new AgentAskUserService()
