/**
 * Ask 档位相关类型定义
 *
 * Composer 档位（per-session）：ask | agent
 * - ask：只对话，不能写文件、不能执行命令、不能使用 MCP/Skills
 * - agent：可动手（走 SDK orchestrator，不在此模块范围）
 *
 * Ask 消息存储：`~/.tagent/agent-sessions/{id}.ask.jsonl`，与 SDK JSONL 并列。
 * 不污染 SDK resume（resume 仍读 `{id}.jsonl`）。
 */

import type { FileAttachment } from './chat'

// ===== Composer 档位 =====

/** Composer 档位：输入区 Ask / Agent */
export type ComposerMode = 'ask' | 'agent'

/** 默认 Composer 档位（首次创建会话时） */
export const DEFAULT_COMPOSER_MODE: ComposerMode = 'agent'

// ===== Ask 消息 =====

/**
 * Ask 消息：与 ChatMessage 类似但更轻量
 * - 不含 ChatToolActivity（Ask 工具白名单受限）
 * - 持久化到 `{sessionId}.ask.jsonl`
 */
export interface AskMessage {
  /** 消息唯一标识 */
  id: string
  /** 角色 */
  role: 'user' | 'assistant'
  /** 内容 */
  content: string
  /** 创建时间戳 */
  createdAt: number
  /** 推理内容（如果模型支持） */
  reasoning?: string
  /** 使用的渠道 ID（assistant 消息） */
  channelId?: string
  /** 使用的模型 ID（assistant 消息） */
  modelId?: string
  /** 文件附件（user 消息） */
  attachments?: FileAttachment[]
  /** 是否为流式中断残留（被中止时为 true） */
  partial?: boolean
  /** 流式错误信息 */
  error?: string
  /** 耗时（毫秒，assistant 消息） */
  durationMs?: number
}

// ===== 发送输入 =====

/**
 * Ask 发送消息的输入参数
 */
export interface AskSendInput {
  /** Agent 会话 ID（与 SDK 主会话共享 ID） */
  agentSessionId: string
  /** 用户消息内容 */
  content: string
  /** 渠道 ID */
  channelId: string
  /** 模型 ID */
  modelId: string
  /** 文件附件（结构与 FileAttachment 对齐） */
  attachments?: FileAttachment[]
  /**
   * 注入 Ask 契约后的系统提示（主进程也可内置，此字段为可选覆盖）
   * 留空时主进程 ask-prompt-builder 会自动组装
   */
  systemPromptOverride?: string
  /** 流式开始时间戳（用于竞态保护） */
  startedAt?: number
}

// ===== 升级引导 =====

/**
 * Ask → Agent 升级引导（由 suggest_agent_switch 工具结果或模型自检触发）
 *
 * 与 Chat 的 `agent_recommendation` 共享结构，但语义更直接：
 * 用户已在 Agent 会话中，"升级"=把 Composer 切到 agent 档位并预填 draft。
 */
export interface AgentSwitchSuggestion {
  type: 'agent_switch_suggestion'
  /** 推荐理由（AI 生成，说明为何 Ask 不够用） */
  reason: string
  /** 建议的 Agent 初始提示词（用于预填 Composer draft） */
  suggestedPrompt: string
}

// ===== 流式事件载荷 =====

/**
 * Ask 流式内容片段事件
 */
export interface AskStreamChunkEvent {
  /** Agent 会话 ID */
  agentSessionId: string
  /** 内容增量 */
  delta: string
  /** 当前消息 ID（用于定位写入哪条 assistant 消息） */
  messageId: string
}

/**
 * Ask 流式推理片段事件
 */
export interface AskStreamReasoningEvent {
  /** Agent 会话 ID */
  agentSessionId: string
  /** 推理增量 */
  delta: string
  /** 当前消息 ID */
  messageId: string
}

/**
 * Ask 流式完成事件
 */
export interface AskStreamCompleteEvent {
  /** Agent 会话 ID */
  agentSessionId: string
  /** 助手消息 ID（持久化后回传） */
  messageId: string
  /** 使用的模型 */
  model: string
  /** 耗时（毫秒） */
  durationMs?: number
  /** 是否由用户手动中止 */
  stoppedByUser?: boolean
}

/**
 * Ask 流式错误事件
 */
export interface AskStreamErrorEvent {
  /** Agent 会话 ID */
  agentSessionId: string
  /** 错误信息 */
  error: string
}

/**
 * Ask 升级引导事件（主进程 → 渲染进程推送）
 */
export interface AskStreamSwitchSuggestionEvent {
  /** Agent 会话 ID */
  agentSessionId: string
  /** 升级引导 payload */
  suggestion: AgentSwitchSuggestion
}

// ===== IPC 通道常量 =====

/**
 * Ask 相关 IPC 通道常量
 */
export const ASK_IPC_CHANNELS = {
  /** 获取 Ask 消息列表（从 ask.jsonl 读取） */
  GET_MESSAGES: 'ask:get-messages',
  /** 发送 Ask 消息（触发流式） */
  SEND_MESSAGE: 'ask:send-message',
  /** 中止当前会话的 Ask 生成 */
  STOP_GENERATION: 'ask:stop-generation',
  /** 删除单条 Ask 消息（P1 留位） */
  DELETE_MESSAGE: 'ask:delete-message',
  /** 持久化 Composer 档位（per-session 同步到 AgentSessionMeta.lastComposerMode） */
  SET_COMPOSER_MODE: 'ask:set-composer-mode',
  /** 获取会话的 Composer 档位 */
  GET_COMPOSER_MODE: 'ask:get-composer-mode',

  // 主进程 → 渲染进程（流式推送）
  /** 内容片段 */
  STREAM_CHUNK: 'ask:stream:chunk',
  /** 推理片段 */
  STREAM_REASONING: 'ask:stream:reasoning',
  /** 流式完成 */
  STREAM_COMPLETE: 'ask:stream:complete',
  /** 流式错误 */
  STREAM_ERROR: 'ask:stream:error',
  /** 升级引导（解析自 suggest_agent_switch 工具） */
  STREAM_SWITCH_SUGGESTION: 'ask:stream:switch-suggestion',
} as const
