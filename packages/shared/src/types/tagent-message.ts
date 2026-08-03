/**
 * TAgentMessage 中间表示（IR）— 双核统一的渲染层消息格式
 *
 * 见 docs/decisions/ADR-0001-dual-core.md + docs/plans/2026-07-25-renderer-decouple-message-ir.md（TAgent_General）。
 *
 * 渲染层吃 TAgentMessage，不认 SDK 格式也不认 pi-ai 格式。
 * 主进程转译：kscc 核 SDKMessage → TAgentMessage；Pi 核 pi-ai Message → TAgentMessage。
 *
 * 只表达「对话转录」语义（user 输入 / assistant 输出 / tool 调用 / tool 结果 / thinking）。
 * 控制消息（result/system/tool_progress）走独立 kind，不混入转录。
 */

import type { FileAttachment } from './chat'

// ===== 内容块（assistant 输出单元） =====
export interface TAgentTextBlock {
  type: 'text'
  text: string
}
export interface TAgentThinkingBlock {
  type: 'thinking'
  thinking: string
}
export interface TAgentToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
export type TAgentContentBlock =
  | TAgentTextBlock
  | TAgentThinkingBlock
  | TAgentToolUseBlock
  | { type: string; [key: string]: unknown } // 兜底：未知块原样保留，渲染层忽略

// ===== 工具结果（user 消息内的 tool_result 块） =====
export interface TAgentToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content?: string | TAgentTextBlock[] | unknown
  isError?: boolean
}

// ===== 转录消息（对话主体） =====
export interface TAgentUserMessage {
  type: 'user'
  uuid?: string
  parentToolUseId?: string | null
  sessionId?: string
  createdAt?: number
  isReplay?: boolean
  isSynthetic?: boolean
  content: Array<TAgentTextBlock | TAgentToolResultBlock | { type: string; [key: string]: unknown }>
  attachments?: FileAttachment[]
}

export interface TAgentUsage {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
}

export interface TAgentAssistantMessage {
  type: 'assistant'
  uuid?: string
  parentToolUseId?: string | null
  sessionId?: string
  createdAt?: number
  isReplay?: boolean
  modelId?: string
  error?: { message: string; code?: string }
  content: TAgentContentBlock[]
  usage?: TAgentUsage
  /**
   * 停止原因（Pi 核流式用）：有值表示该轮已完成（turn_end 最终消息），
   * 无值表示仍在流式中（toolcall_end 等中间 sdk_message）。
   * 渲染层据此区分流式/完成，清 streaming 标记（见 Chat.tsx Pi 核流式处理）。
   * 与 SDKAssistantMessage.stop_reason 命名一致（snake_case）。
   */
  stop_reason?: string
}

// ===== 顶层联合（转录消息） =====
export type TAgentMessage = TAgentUserMessage | TAgentAssistantMessage

// ===== 控制事件（非转录，独立通道，对应 AgentStreamPayload 的其他 kind） =====
export type TAgentControlEvent =
  | { kind: 'result'; subtype?: string; usage?: TAgentUsage; totalCostUsd?: number }
  | { kind: 'stream_text_delta'; text: string; parentToolUseId?: string }
  | { kind: 'stream_thinking_delta'; text: string; parentToolUseId?: string }
  | { kind: 'call_stats'; stats: Record<string, number> }
  | { kind: 'tagent_event'; event: { type: string; [key: string]: unknown } }

// ===== IPC 流式 payload（主→渲染，统一通道 STREAM_EVENT） =====
export type TAgentDesktopStreamPayload =
  | { kind: 'sdk_message'; message: TAgentMessage }
  | TAgentControlEvent

/** IPC 事件信封（STREAM_EVENT 携带） */
export interface TAgentDesktopStreamEvent {
  sessionId: string
  payload: TAgentDesktopStreamPayload
}
