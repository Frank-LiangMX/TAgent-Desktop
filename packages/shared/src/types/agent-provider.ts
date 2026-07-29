/**
 * Agent Provider 适配器接口
 *
 * 定义 TAgent 自己的 Agent 接口层，让底层 SDK 可替换。
 * 当前实现：ClaudeAgentAdapter（基于 @anthropic-ai/claude-agent-sdk）
 * 未来可扩展：PiAgentAdapter 等。
 */

import type { SDKMessage } from './agent'

/** SDK 用户消息（队列消息注入用，匹配 SDK SDKUserMessage 结构） */
export interface SDKUserMessageInput {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  priority?: 'now' | 'next' | 'later'
  uuid?: string
  session_id: string
}

/**
 * Agent 查询输入（Provider 无关）
 *
 * 包含所有 Provider 都需要的通用字段。
 * SDK 特定配置通过 Adapter 的扩展输入类型传入。
 */
export interface AgentQueryInput {
  /** 会话 ID */
  sessionId: string
  /** 用户 prompt（已包含上下文注入） */
  prompt: string
  /** 模型 ID */
  model?: string
  /** Agent 工作目录 */
  cwd?: string
  /** 中止信号 */
  abortSignal?: AbortSignal
}

/**
 * Agent Provider 适配器接口
 *
 * 职责：接收查询输入，返回 SDKMessage 异步迭代流。
 * SDK 返回完整 JSON 对象（includePartialMessages: false），外部直接透传。
 */
export interface AgentProviderAdapter {
  /** 发起查询，返回 SDKMessage 异步迭代流 */
  query(input: AgentQueryInput): AsyncIterable<SDKMessage>
  /** 中止指定会话的执行 */
  abort(sessionId: string): void
  /**
   * 软中断当前 turn，但保留活跃 Query/Channel 以便继续注入下一条用户消息。
   * 与 abort() 的区别：不杀子进程，允许立即续跑新消息。
   */
  interruptQuery?(sessionId: string): Promise<void>
  /** 释放资源 */
  dispose(): void
  /** 向活跃查询注入队列消息（可选，仅支持队列的 Provider 实现） */
  sendQueuedMessage?(sessionId: string, message: SDKUserMessageInput): Promise<void>
  /** 查询某会话是否有活跃的长驻 channel（可选，长驻复用判断用） */
  hasActiveChannel?(sessionId: string): boolean
  /** 取消队列中的待发送消息（可选） */
  cancelQueuedMessage?(sessionId: string, messageUuid: string): Promise<void>
  /** 动态切换活跃查询的权限模式（可选，仅支持 SDK 原生 setPermissionMode 的 Provider） */
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
  /** 动态切换活跃查询的模型（可选，仅支持热切模型的 Provider） */
  setModel?(sessionId: string, model: string): Promise<void>
  /** 获取当前会话 Context 分项占用（可选，仅 Claude Agent SDK 支持） */
  getContextUsage?(sessionId: string): Promise<import('@tagent/shared').ContextUsageSnapshot>
  /**
   * 压缩会话上下文（可选，Pi 核实现）。
   * force=true 时忽略自动阈值（手动压缩 / prompt_too_long 重试）。
   */
  compactSession?(
    sessionId: string,
    options?: { force?: boolean; trigger?: 'auto' | 'manual' },
  ): Promise<{
    ok: boolean
    compacted: boolean
    reason?: string
    tokensBefore?: number
    summary?: string
  }>
  /**
   * 后台刷新 Context 分项缓存（stale-while-revalidate 的 revalidate 部分）。
   * 由 orchestrator 在 getContextUsage 返回缓存后 fire-and-forget 调用，
   * 刷新完成后 orchestrator 通过 IPC 通知渲染进程重新获取（命中刚更新的缓存）。
   *
   * @returns 是否成功刷新（true = 缓存已更新，需通知渲染进程）
   */
  refreshContextUsage?(sessionId: string): Promise<boolean>
}
