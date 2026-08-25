/**
 * Agent 相关类型定义
 *
 * 包含 Agent SDK 集成所需的事件类型、会话管理、消息持久化和 IPC 通道常量。
 */

import type { ComposerMode } from "./ask";
import type {
  ExecutionMode,
  ExecutionModeHistoryEntry,
  ExecutionModeSuggestion,
} from "./execution-mode";
import type { NoProgressEvent } from "./no-progress";
import type { FusionConversationMode } from "./fusion-session";

// ===== 记忆 IPC 通道 =====

/**
 * 记忆系统 IPC 通道常量（Nudge 机制 + L0-L5 本地记忆层）
 */
export const MEMORY_IPC_CHANNELS = {
  // ===== Nudge 相关 =====
  /** 获取待处理的 Nudge 候选项 */
  GET_PENDING_NUDGES: "memory:get-pending-nudges",
  /** 响应 Nudge */
  RESPOND_NUDGE: "memory:respond-nudge",
  /** Nudge 事件通知 */
  NUdge_EVENT: "memory:nudge-event",

  // ===== Stage 队列相关（P2.2 写入门控三态） =====
  /** 获取 stage 待审批列表 */
  GET_STAGE_QUEUE: "memory:get-stage-queue",
  /** 批量 accept stage 条目（写入 L0/L1/L2） */
  ACCEPT_STAGE_ALL: "memory:accept-stage-all",
  /** 批量 reject stage 条目（记录到 rejected.jsonl） */
  REJECT_STAGE_ALL: "memory:reject-stage-all",
  /** 单条 accept */
  ACCEPT_STAGE_ONE: "memory:accept-stage-one",
  /** 单条 reject */
  REJECT_STAGE_ONE: "memory:reject-stage-one",

  // ===== Memory Graph 可视化（P3-MG.1） =====
  /** 获取 Memory Graph 数据（nodes + edges + stats） */
  GET_GRAPH_DATA: "memory:get-graph-data",
} as const;

/**
 * TA 意图检测 IPC 通道常量
 */
export const TA_INTENT_IPC_CHANNELS = {
  /** TA 意图提示事件 */
  TA_INTENT_PROMPT: "agent:ta-intent-prompt",
} as const;

/**
 * Btw (By The Way) IPC 通道常量
 */
export const BTW_IPC_CHANNELS = {
  /** 发送侧面提问 */
  SEND_BTW: "btw:send",
  /** 侧面提问流式事件 */
  BTW_EVENT: "btw:event",
  /** 取消侧面提问 */
  CANCEL_BTW: "btw:cancel",
} as const;

// ===== Nudge 类型 =====

/** Nudge 类型 */
export type NudgeType =
  "behavior_repeat" | "fact_repeat" | "correction" | "project_repeat";

/** Nudge 候选项 */
export interface NudgeCandidate {
  id: string;
  type: NudgeType;
  targetLayer: "L0" | "L1" | "L2" | "L3";
  pattern: string;
  evidence: string[];
  suggestedContent: string;
  userMessage: string;
}

/**
 * Stage 队列条目（P2.2 写入门控三态）
 *
 * background nudge（LLM review）写入暂存到此队列，
 * 用户批量 accept 后才写入 L0/L1/L2。
 */
export interface StageEntry {
  /** 唯一 id（与 NudgeCandidate.id 共享） */
  id: string;
  /** 入队时间戳 */
  enqueuedAt: number;
  /** 来源：background（LLM review 自动） */
  origin: "background";
  /** Nudge 类型 */
  type: NudgeType;
  /** 目标层 */
  targetLayer: "L0" | "L1" | "L2" | "L3";
  /** 记忆内容 */
  pattern: string;
  /** 证据消息（用户消息截断） */
  evidence: string[];
  /** 建议内容 */
  suggestedContent: string;
  /** 用户友好提示 */
  userMessage: string;
  /** 来源会话 id 前 8 位 */
  sourceSession: string;
}

/**
 * Memory Graph 节点（P3-MG.1）
 */
export interface GraphNode {
  id: string;
  kind: "memory" | "session";
  shape: "diamond" | "circle";
  source?: "L0" | "L2" | "L5";
  title: string;
  content: string;
  timestamp: number;
  useCount?: number;
}

/**
 * Memory Graph 边（P3-MG.1）
 */
export interface GraphEdge {
  source: string;
  target: string;
  type: "memory-memory" | "memory-session";
  weight?: number;
}

/**
 * Memory Graph 装配结果（P3-MG.1）
 */
export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    memoryNodes: number;
    sessionNodes: number;
    edges: number;
  };
}

// ===== Btw (By The Way) 侧面提问 =====

/** 侧面提问消息 */
export interface BtwMessage {
  /** 消息 ID */
  id: string;
  /** 角色 */
  role: "user" | "assistant";
  /** 内容 */
  content: string;
  /** 创建时间 */
  createdAt: number;
  /** 是否在流式输出 */
  streaming?: boolean;
}

// ===== Agent 工作区 =====

/** Agent 工作区（项目模式） */
export interface AgentWorkspace {
  /** 工作区唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** URL-safe 目录名（创建后不可变） */
  slug: string;
  /** 项目目录 — 用户选择的本地代码目录，Agent 直接在该目录工作 */
  projectDirectory?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}

// ===== SDK 新增类型声明（0.2.52 ~ 0.2.63） =====

/**
 * 思考模式配置
 *
 * 控制 Claude 的推理/思考行为：
 * - adaptive: Claude 自行决定何时以及思考多少（Opus 4.6+ 默认）
 * - enabled: 固定思考 Token 预算（旧模型）
 * - disabled: 不使用扩展思考
 */
export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

/**
 * 推理深度等级
 *
 * 与 adaptive thinking 配合使用，引导思考深度：
 * - low: 最少思考，最快响应
 * - medium: 适度思考
 * - high: 深度推理（默认）
 * - max: 最大深度（仅 Opus 4.6）
 */
export type AgentEffort = "low" | "medium" | "high" | "max";

/**
 * 思考强度档位（UI 层独立命名，语义更清晰）
 *
 * - low:    最少思考，最快响应
 * - medium: 适度思考（默认）
 * - high:   深度推理
 * - max:    最大深度
 */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "max",
];

/** 规范化思考强度：非法 / 缺省值统一回退默认 medium */
export function migrateReasoningEffort(
  value: string | undefined,
): ReasoningEffort {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  ) {
    return value;
  }
  return DEFAULT_REASONING_EFFORT;
}

/**
 * Claude Agent SDK query options.effort 档位。
 * 即 `@anthropic-ai/claude-agent-sdk` 的 `EffortLevel`（sdk.d.ts:488-496, 1565-1576）。
 * TAgent 仅暴露 low|medium|high|max（不引入 xhigh）；映射见 {@link reasoningEffortToSdkEffort}。
 * 与 ThinkingConfig（adaptive/enabled/disabled）正交：effort 配合 adaptive thinking 引导思考深度。
 */
export type SdkEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 把会话 {@link ReasoningEffort} 映射到 Claude Agent SDK `effort` query option。
 *
 * - TAgent 枚举是 SDK EffortLevel 的子集，1:1 直传（low/medium/high/max）。
 * - `max` → `max`：仅 select models（Opus 4.6+ / Sonnet 4.6 等）支持；SDK 会按所选模型
 *   静默降级（sdk.d.ts:174），TAgent 侧无需自行降级。
 * - 不暴露 `xhigh`（ultracode 专用档，UI 不开放）。
 * - 入参应先经 {@link migrateReasoningEffort} 归一化；default 分支兜底 medium。
 *
 * 证据：`ClaudeAgentAdapter.buildSdkOptions` 注入 `options.effort`；SDK 在 sdk.mjs 运行时引用
 * effort（spawn/query 路径），kscc 为 claude-code 兼容 CLI 由 SDK 驱动。
 */
export function reasoningEffortToSdkEffort(
  effort: ReasoningEffort,
): SdkEffortLevel {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "max";
    default:
      return "medium";
  }
}

/**
 * Pi 核 thinkingLevel 档位（@earendil-works/pi-ai / pi-agent-core）。
 * Pi 没有 `max`；TAgent `max` 降级到 `high`。
 */
export type PiThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * 把会话 {@link ReasoningEffort} 映射到 Pi 核 thinkingLevel。
 * low→low / medium→medium / high→high / max→high（Pi 无 max）。
 * 仅当渠道开启 thinking（thinkingEnabled）时才生效；默认关闭时该值为 no-op（不回归既有行为）。
 */
export function reasoningEffortToPiThinkingLevel(
  effort: ReasoningEffort,
): PiThinkingLevel {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "high";
    default:
      return "medium";
  }
}

/**
 * 自定义子代理定义
 *
 * 通过 SDK 的 agents 选项注册可被 Agent 工具调用的自定义子代理。
 */
export interface AgentDefinition {
  /** 自然语言描述，说明何时使用该代理 */
  description: string;
  /** 允许使用的工具名称列表，省略则继承父级所有工具 */
  tools?: string[];
  /** 明确禁止使用的工具名称列表 */
  disallowedTools?: string[];
  /** 自定义系统提示词 */
  prompt?: string;
  /** 使用的模型（覆盖父级） */
  model?: string;
  /** 最大轮次（覆盖父级） */
  maxTurns?: number;
}

/**
 * SDK 会话信息（listSessions 返回）
 *
 * SDK 0.2.53 新增，用于发现和列出历史会话。
 */
export interface SDKSessionInfo {
  /** 会话 ID */
  sessionId: string;
  /** 项目路径 */
  projectPath?: string;
  /** 会话标题（从 transcript 提取） */
  title?: string;
  /** 创建时间 ISO 字符串 */
  createdAt?: string;
  /** 最后更新时间 ISO 字符串 */
  lastUpdatedAt?: string;
  /** 消息计数概要 */
  messageCount?: number;
}

/**
 * SDK 会话消息（getSessionMessages 返回）
 *
 * SDK 0.2.59 新增，用于读取会话的完整对话历史。
 */
export interface SDKSessionMessage {
  /** 消息类型（SDK 原始类型标识） */
  type: string;
  /** 消息角色 */
  role?: "user" | "assistant";
  /** 消息内容 */
  content?: unknown;
  /** 时间戳 */
  timestamp?: string;
}

/**
 * SDK Beta 特性标识
 *
 * 当前支持：
 * - context-1m-2025-08-07: 启用 1M token 上下文窗口（Claude Sonnet 4+ / Opus 4.6+、DeepSeek V4 系列）
 */
export type SdkBeta = "context-1m-2025-08-07";

/**
 * JSON Schema 输出格式
 *
 * 用于指定结构化输出，Agent 将返回符合 Schema 的 JSON 数据。
 */
export interface JsonSchemaOutputFormat {
  type: "json_schema";
  /** JSON Schema 定义 */
  schema: Record<string, unknown>;
  /** Schema 名称（可选） */
  name?: string;
  /** Schema 描述（可选） */
  description?: string;
}

// ===== SDK 消息类型（直接透传，不再翻译） =====

/** SDK 文本内容块 */
export interface SDKTextBlock {
  type: "text";
  text: string;
}

/** SDK 工具调用内容块 */
export interface SDKToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** SDK 思考内容块 */
export interface SDKThinkingBlock {
  type: "thinking";
  thinking: string;
}

/** SDK 内容块联合类型 */
export type SDKContentBlock =
  | SDKTextBlock
  | SDKToolUseBlock
  | SDKThinkingBlock
  | { type: string; [key: string]: unknown };

/** SDK tool_result 内容块（在 user 消息中） */
export interface SDKToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

/** SDK user 消息内容块联合类型 */
export type SDKUserContentBlock =
  SDKToolResultBlock | SDKTextBlock | { type: string; [key: string]: unknown };

/** SDK assistant 消息 */
export interface SDKAssistantMessage {
  type: "assistant";
  message: {
    content: SDKContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    model?: string;
    stop_reason?: string;
  };
  parent_tool_use_id: string | null;
  session_id?: string;
  /** SDK 消息唯一标识，用于 forkSession / resumeSessionAt */
  uuid?: string;
  error?: { message: string; errorType?: string };
  isReplay?: boolean;
  /** 渠道配置的模型 ID，持久化/流式期间注入，用于正确匹配模型显示名 */
  _channelModelId?: string;
  /** Claude Agent SDK `includePartialMessages:true` 时携带的流式中间态标记。
   *  与 Proma/Pi 的 IR `_partial` 同义，渲染层按 uuid 原地 upsert，final 替换。
   *  不在官方 SDK 类型中，自定义顶层字段。 */
  _partial?: boolean;
}

/** SDK user 消息 */
export interface SDKUserMessage {
  type: "user";
  message?: {
    content?: SDKUserContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id?: string;
  /** SDK 消息唯一标识 */
  uuid?: string;
  tool_use_result?: unknown;
  isReplay?: boolean;
  /** SDK 合成的消息（如 Skill 展开 prompt），非人类用户输入 */
  isSynthetic?: boolean;
  /** TAgent 标注：运行中引导消息，供面板按同一执行回合渲染。 */
  isSteer?: boolean;
}

/** SDK result 消息（查询结束时返回） */
export interface SDKResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_during_execution"
    /** No-Progress Guard 安全暂停（§7.3 / §20.5）：非错误，会话可继续，不触发崩溃恢复 */
    | "paused_no_progress"
    | (string & {});
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  modelUsage?: Record<string, { contextWindow?: number }>;
  errors?: string[];
  terminal_reason?: string;
  background_tasks?: SDKBackgroundTaskSummary[];
  session_crons?: SDKSessionCronSummary[];
  session_id?: string;
}

/** SDK system 消息（init / compact_boundary / permission_denied / task_started / task_progress / task_notification） */
export interface SDKSystemMessage {
  type: "system";
  subtype?: string;
  session_id?: string;
  /** init: 确认的模型 */
  model?: string;
  /** task 相关字段 */
  task_id?: string;
  description?: string;
  task_type?: string;
  tool_use_id?: string;
  status?: string;
  summary?: string;
  output_file?: string;
  last_tool_name?: string;
  /** permission_denied 相关字段 */
  tool_name?: string;
  message?: string;
  decision_reason_type?: string;
  decision_reason?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  [key: string]: unknown;
}

/** SDK thinking token 估算消息（Claude Agent SDK 0.3.156+） */
export interface SDKThinkingTokensMessage {
  type: "system";
  subtype: "thinking_tokens";
  estimated_tokens: number;
  estimated_tokens_delta: number;
  uuid?: string;
  session_id?: string;
}

/** SDK 后台任务摘要（result / hook 中可能出现） */
export interface SDKBackgroundTaskSummary {
  id: string;
  type: string;
  status: string;
  description: string;
  command?: string;
  agent_type?: string;
  server?: string;
  tool?: string;
  name?: string;
}

/** SDK 会话级定时任务摘要（result / hook 中可能出现） */
export interface SDKSessionCronSummary {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

/** SDK tool_progress 消息（工具执行心跳） */
export interface SDKToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds?: number;
  /** 所属 SDK 子任务 / SubAgent 任务 ID */
  task_id?: string;
  session_id?: string;
}

/** SDK prompt_suggestion 消息 */
export interface SDKPromptSuggestionMessage {
  type: "prompt_suggestion";
  suggestion?: string;
  session_id?: string;
}

/** SDK tool_use_summary 消息 */
export interface SDKToolUseSummaryMessage {
  type: "tool_use_summary";
  summary?: string;
  preceding_tool_use_ids?: string[];
  session_id?: string;
}

/** SDK 消息联合类型（v1 query + includePartialMessages: false 返回的完整 JSON 对象） */
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKThinkingTokensMessage
  | SDKSystemMessage
  | SDKToolProgressMessage
  | SDKPromptSuggestionMessage
  | SDKToolUseSummaryMessage
  | {
      type: string;
      session_id?: string;
      parent_tool_use_id?: string | null;
      [key: string]: unknown;
    };

// ===== Agent 事件类型 =====

/** 错误代码 */
export type ErrorCode =
  | "invalid_api_key"
  | "invalid_credentials"
  | "response_too_large"
  | "expired_oauth_token"
  | "token_expired"
  | "rate_limited"
  | "service_error"
  | "service_unavailable"
  | "network_error"
  | "mcp_auth_required"
  | "mcp_unreachable"
  | "billing_error"
  | "model_no_tool_support"
  | "invalid_model"
  | "data_policy_error"
  | "invalid_request"
  | "image_too_large"
  | "prompt_too_long"
  | "thinking_signature_invalid"
  | "provider_error"
  // 环境 / 配置类错误（本地可修复）
  | "windows_shell_missing"
  | "channel_not_found"
  | "api_key_decrypt_failed"
  | "claude_binary_not_found"
  | "session_busy"
  | "ta_dependency_missing"
  | "kscc_not_found"
  | "unknown_error";

/** 恢复操作 */
export interface RecoveryAction {
  /** 操作键（用于快捷键） */
  key: string;
  /** 操作标签 */
  label: string;
  /** 操作类型 */
  action:
    | "settings"
    | "retry"
    | "cancel"
    | "compact"
    | "open_environment_check"
    | "open_channel_settings"
    | "open_external"
    | "report_feedback"
    | (string & {});
  /** 操作附带的载荷，例如 open_external 的 URL */
  payload?: string;
}

/** 类型化错误 */
export interface TypedError {
  /** 错误代码，用于程序化处理 */
  code: ErrorCode;
  /** 用户友好的标题 */
  title: string;
  /** 详细的错误消息 */
  message: string;
  /** 建议的恢复操作 */
  actions: RecoveryAction[];
  /** 是否可以自动重试 */
  canRetry: boolean;
  /** 重试延迟（毫秒） */
  retryDelayMs?: number;
  /** 诊断详情（用于调试） */
  details?: string[];
  /** 原始错误消息（用于调试） */
  originalError?: string;
}

/** Agent 事件 Usage 信息 */
export interface AgentEventUsage {
  inputTokens: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  contextWindow?: number;
}

/** SDK 子任务 / SubAgent 用量统计 */
export interface TaskUsage {
  /** 总 Token 数 */
  totalTokens: number;
  /** 工具调用次数 */
  toolUses: number;
  /** 运行耗时（毫秒） */
  durationMs: number;
}

/**
 * 重试尝试记录
 *
 * 记录每次重试尝试的详细信息，用于错误诊断和 UI 展示。
 */
export interface RetryAttempt {
  /** 第几次尝试 (1-based) */
  attempt: number;
  /** 时间戳 */
  timestamp: number;
  /** 错误原因（简短描述，如"SDK 响应超时"） */
  reason: string;
  /** 完整错误消息 */
  errorMessage: string;
  /** stderr 输出（可选） */
  stderr?: string;
  /** 堆栈跟踪（可选） */
  stack?: string;
  /** 运行环境信息（可选） */
  environment?: {
    /** 运行时，如 "Bun 1.0.0" */
    runtime: string;
    /** 平台，如 "darwin arm64" */
    platform: string;
    /** 模型，如 "claude-sonnet-4-5-20250929" */
    model: string;
    /** 工作区名称 */
    workspace?: string;
    /** 工作目录 */
    cwd?: string;
  };
  /** 延迟秒数 */
  delaySeconds: number;
}

/**
 * Agent 事件类型
 *
/** MCP 工具结果中的图片附件 */
export interface AgentToolResultImage {
  localPath: string;
  filename: string;
  mediaType: string;
}

/** 计划阶段状态变化来源 */
export type AgentPlanModeChangeSource = "initial" | "tool" | "permission";

/**
 * Agent 事件流类型
 *
 * 从 SDK 消息转换而来的扁平事件流，用于驱动 UI 渲染。
 */
export type AgentEvent =
  // 文本流式输出
  | {
      type: "text_delta";
      text: string;
      turnId?: string;
      parentToolUseId?: string;
    }
  | {
      type: "text_complete";
      text: string;
      isIntermediate: boolean;
      turnId?: string;
      parentToolUseId?: string;
    }
  | {
      type: "thinking_delta";
      text: string;
      turnId?: string;
      parentToolUseId?: string;
    }
  | {
      type: "thinking_complete";
      text: string;
      turnId?: string;
      parentToolUseId?: string;
    }
  // 工具执行
  | {
      type: "tool_start";
      toolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
      intent?: string;
      displayName?: string;
      turnId?: string;
      parentToolUseId?: string;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      toolName?: string;
      result: string;
      isError: boolean;
      input?: Record<string, unknown>;
      turnId?: string;
      parentToolUseId?: string;
      imageAttachments?: AgentToolResultImage[];
    }
  // 后台任务
  | {
      type: "task_backgrounded";
      toolUseId: string;
      taskId: string;
      intent?: string;
      turnId?: string;
    }
  | {
      type: "task_started";
      taskId: string;
      toolUseId?: string;
      description: string;
      taskType?: string;
      turnId?: string;
    }
  | {
      type: "task_progress";
      toolUseId: string;
      elapsedSeconds?: number;
      turnId?: string;
      taskId?: string;
      description?: string;
      lastToolName?: string;
      usage?: TaskUsage;
    }
  | {
      type: "task_notification";
      taskId: string;
      toolUseId?: string;
      status: "completed" | "failed" | "stopped";
      summary: string;
      outputFile?: string;
      usage?: TaskUsage;
      turnId?: string;
    }
  | { type: "run_resumed"; sessionId: string }
  | {
      type: "thinking_tokens";
      estimatedTokens: number;
      estimatedTokensDelta: number;
    }
  | {
      type: "shell_backgrounded";
      toolUseId: string;
      shellId: string;
      intent?: string;
      command?: string;
      turnId?: string;
    }
  | { type: "shell_killed"; shellId: string; turnId?: string }
  // 工具使用摘要
  | { type: "tool_use_summary"; summary: string; precedingToolUseIds: string[] }
  // 控制流
  | { type: "complete"; stopReason?: string; usage?: AgentEventUsage }
  | { type: "error"; message: string }
  | { type: "typed_error"; error: TypedError }
  // 重试机制
  | {
      type: "retrying";
      attempt: number;
      maxAttempts: number;
      delaySeconds: number;
      reason: string;
    } // 保留向后兼容
  | { type: "retry_attempt"; attemptData: RetryAttempt } // 新增：记录详细尝试信息
  | { type: "retry_cleared" } // 新增：重试成功，清除状态
  | { type: "retry_failed"; finalAttempt: RetryAttempt } // 新增：重试失败
  // Usage 更新
  | { type: "usage_update"; usage: AgentEventUsage }
  // 上下文压缩
  | { type: "compacting" }
  | { type: "compact_complete" }
  // 权限请求
  | { type: "permission_request"; request: PermissionRequest }
  | {
      type: "permission_resolved";
      requestId: string;
      behavior: "allow" | "deny";
    }
  // AskUserQuestion 交互式问答
  | { type: "ask_user_request"; request: AskUserRequest }
  | { type: "ask_user_resolved"; requestId: string }
  // ExitPlanMode 计划审批
  | { type: "exit_plan_mode_request"; request: ExitPlanModeRequest }
  | { type: "exit_plan_mode_resolved"; requestId: string }
  // EnterPlanMode 进入计划模式
  | { type: "enter_plan_mode"; sessionId: string }
  // 当前是否处于计划阶段（与用户选择的权限模式分离）
  | {
      type: "plan_mode_changed";
      active: boolean;
      source: AgentPlanModeChangeSource;
    }
  // 提示建议
  | { type: "prompt_suggestion"; suggestion: string }
  // 模型确认（SDK 确认实际使用的模型）
  | { type: "model_resolved"; model: string }
  // 权限模式变更（Plan → bypassPermissions 等）
  | { type: "permission_mode_changed"; mode: TAgentPermissionMode };

// ===== TAgent 内部事件（SDK 不覆盖的场景） =====

/** TAgent 内部事件类型 */
export type TAgentEvent =
  | { type: "permission_request"; request: PermissionRequest }
  | {
      type: "permission_resolved";
      requestId: string;
      behavior: "allow" | "deny";
    }
  | { type: "ask_user_request"; request: AskUserRequest }
  | { type: "ask_user_resolved"; requestId: string }
  | { type: "exit_plan_mode_request"; request: ExitPlanModeRequest }
  | { type: "exit_plan_mode_resolved"; requestId: string }
  | { type: "enter_plan_mode"; sessionId: string }
  | {
      type: "plan_mode_changed";
      sessionId: string;
      active: boolean;
      source: AgentPlanModeChangeSource;
    }
  | {
      type: "retry";
      status: "starting" | "attempt" | "cleared" | "failed";
      attempt?: number;
      maxAttempts?: number;
      delaySeconds?: number;
      reason?: string;
      attemptData?: RetryAttempt;
      error?: TypedError;
    }
  | { type: "model_resolved"; model: string }
  | { type: "permission_mode_changed"; mode: TAgentPermissionMode }
  | { type: "title_updated"; title: string }
  | {
      type: "external_run_started";
      source: AgentExternalRunSource;
      sessionId: string;
      title?: string;
      workspaceId?: string;
      modelId?: string;
      startedAt: number;
    }
  | { type: "run_resumed"; sessionId: string }
  | {
      type: "design_preview_update";
      html?: string;
      css?: string;
      shapeOps?: unknown[];
      name?: string;
      device?: string;
    }
  | {
      type: "csv_dashboard_open";
      url: string;
      title?: string;
      /** CSV 缓存会话 id，刷新后用于重启 live server */
      sessionId?: string;
      /** dashboard.html 绝对路径（会话内可点重开） */
      filePath?: string;
      /** 打开后默认激活的 view id（#view-{id}） */
      activeView?: string;
    }
  // No-Progress Guard 阶段事件（§20.4）：warning / reflection / paused / cleared
  | NoProgressEvent;

/** 外部入口触发 Agent 运行的来源 */
export type AgentExternalRunSource =
  "feishu" | "dingtalk" | "wechat" | "bridge";

/** IPC 传输的统一 payload（替代 AgentEvent） */
export type AgentStreamPayload =
  | { kind: "sdk_message"; message: SDKMessage }
  | { kind: "tagent_event"; event: TAgentEvent }
  | { kind: "call_stats"; stats: AgentCallStats }
  | {
      kind: "stream_text_delta";
      /** 本次增量文本（已拆分为字符粒度由渲染层 useSmoothStream 入队） */
      text: string;
      /** SubAgent 父 tool_use_id（顶层 Agent 为 undefined） */
      parentToolUseId?: string;
      /** E：block 标识（assistant.uuid），校准/绑定用 */
      uuid?: string;
      /** E：true=整体替换（resync）；缺省=append(suffix) */
      replace?: boolean;
    }
  | {
      kind: "stream_thinking_delta";
      /** 本次 thinking 增量（extended thinking / adaptive thinking） */
      text: string;
      /** SubAgent 父 tool_use_id（顶层 Agent 为 undefined） */
      parentToolUseId?: string;
      /** E：block 标识（assistant.uuid），校准/绑定用 */
      uuid?: string;
      /** E：true=整体替换（resync）；缺省=append(suffix) */
      replace?: boolean;
    };

/** 本轮 Agent 调用统计（仅统计本轮运行期间已观测到的调用） */
export interface AgentCallStats {
  /** 顶层 Agent 模型响应次数 */
  modelCalls: number;
  /** SubAgent 模型响应次数 */
  subagentCalls: number;
  /** SDK query 尝试次数（包含重试） */
  queryAttempts: number;
  /** 自动获取 Context Usage 的控制请求次数 */
  contextUsageRequests: number;
  /** 标题生成请求次数 */
  titleRequests: number;
  /** 自动重试 / 恢复次数 */
  retryAttempts: number;
}

// ===== 子代理委派积极性 =====

/**
 * 子代理委派积极性（per-session 持久化）
 *
 * 控制 SubAgent 委派策略注入主 Agent system prompt 的积极性档位：
 * - 'never'：不主动委派，仅用户明确要求时使用
 * - 'conservative'：明确有益才委派
 * - 'balanced'：积极委派，保持主上下文干净（默认）
 * - 'aggressive'：尽可能委派，主会话只做编排与决策
 */
export type SubagentEagerness =
  "never" | "conservative" | "balanced" | "aggressive";

/** 子代理委派积极性默认值（meta 未持久化时使用） */
export const DEFAULT_SUBAGENT_EAGERNESS: SubagentEagerness = "balanced";

/** 规范化委派积极性：非法 / 缺省值统一回退默认 balanced */
export function migrateSubagentEagerness(
  value: string | undefined,
): SubagentEagerness {
  if (
    value === "never" ||
    value === "conservative" ||
    value === "balanced" ||
    value === "aggressive"
  ) {
    return value;
  }
  return DEFAULT_SUBAGENT_EAGERNESS;
}

/** 知识库来源类型（当前 Phase 0 只读本地目录，后续可扩展上传/远程来源） */
export interface KnowledgeBaseSource {
  id: string;
  type: "directory";
  path: string;
  label: string;
  createdAt: number;
}

/** 全局知识库实体，与项目/工作区解耦 */
export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  description?: string;
  sources: KnowledgeBaseSource[];
  createdAt: number;
  updatedAt: number;
}

/** 知识库中的正式 Markdown 文档 */
export interface KnowledgeBaseDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  content: string;
  sourceUrl?: string;
  sourceProvider?: "wps" | "feishu" | "google-drive" | "unknown";
  sourceExternalId?: string;
  sourceAccessMode?: "public" | "oauth" | "browser";
  sourceSyncedAt?: number;
  createdAt: number;
  updatedAt: number;
}

// ===== Agent 会话管理 =====

/**
 * Agent 会话轻量索引项
 *
 * 存储在 ~/.tagent/agent-sessions.json 中，
 * 类似 ConversationMeta，独立存储。
 */
/** 一轮运行的结束方式：正常完成 / 用户停止 / 出错 */
export type TurnEndKind = "complete" | "stopped" | "error";

/** 当前会话使用知识库的策略。 */
export type KnowledgeBaseMode = "off" | "preferred" | "strict";


/** 一轮运行的完成耗时（毫秒）+ 结束方式 */
export interface TurnDuration {
  ms: number;
  endedBy: TurnEndKind;
}

export interface AgentSessionMeta {
  /** 会话唯一标识 */
  id: string;
  /** 会话标题 */
  title: string;
  /**
   * 会话所属的顶层模式
   * - 'general'：通用模式（Chat / Agent / 草稿本）
   * - 'ta'：TA 模式（与通用模式数据隔离，但底层共用 agent-sessions 表）
   *
   * 旧记录默认 'general'。TA 模式下创建会话时显式置为 'ta'，
   * 列表展示、tab 路由、system prompt 注入均依此字段分流。
   */
  mode?: "general" | "ta";
  /** 使用的渠道 ID */
  channelId?: string;
  /** 使用的模型 ID（持久化，重启后恢复） */
  modelId?: string;
  /** SDK 内部会话 ID（用于 resume 衔接上下文） */
  sdkSessionId?: string;
  /** 所属工作区 ID */
  workspaceId?: string;
  /**
   * 本会话加入的 Bot 配置引用（BotProfile id）。
   * 未设置/空数组表示普通会话；1 个 Bot 走单 Bot 直连；2 个及以上进入融合会话路由。
   */
  botProfileIds?: string[];
  /**
   * 持久化的融合形态快照。由主进程根据 Bot 参与者变更派生，旧会话缺省按普通会话处理。
   */
  fusionMode?: FusionConversationMode;
  /**
   * 多 Bot 时的默认协调者引用；Bot 被移除后由主进程按稳定加入顺序重新派生。
   */
  fusionCoordinatorBotProfileId?: string;
  /**
   * 未来升级为真正 RoomSession 时使用；普通/单 Bot 融合不填写。
   */
  fusionRoomId?: string;
  /** 是否置顶 */
  pinned?: boolean;
  /** 是否已归档 */
  archived?: boolean;
  /**
   * 会话生命状态（侧栏状态色点用）。
   * - 'idle'    无活、无错（默认）
   * - 'running' 进行中：只来自主进程 runtimes 内存，**不落盘**（重启即失）
   * - 'error'   上次执行出错：持久化，重启保留；下一轮成功结束回 'idle'
   * 未设置时按 'idle' 处理。不复用 manualWorking/stoppedByUser（语义不同源）。
   */
  status?: "idle" | "running" | "error";
  /** 会话轮数（user 消息数，一轮 = user + assistant 回复）。发消息时增量更新，旧会话无则空 */
  turnCount?: number;
  /** 附加的外部目录路径列表（绝对路径，作为 SDK additionalDirectories 传递） */
  attachedDirectories?: string[];
  /** 附加的外部文件路径列表（绝对路径，发送时以父目录作为 SDK additionalDirectories） */
  attachedFiles?: string[];
  /** 分叉来源：源会话的 TAgent 工作目录（SDK session 文件在此目录的项目空间中，首次 resume 后清除） */
  forkSourceDir?: string;
  /** 分叉来源：源会话的 SDK session ID（用于 rewind 时读取源会话的 file-history-snapshot 和备份文件） */
  forkSourceSdkSessionId?: string;
  /** 回退后的 resume 截断点：下次发消息时传给 SDK resumeSessionAt（消费后清除） */
  resumeAtMessageUuid?: string;
  /**
   * 各轮完成耗时：key = 该轮最后一条主线 assistant 消息的 createdAt（稳定标识），
   * value = 发送→idle 全程耗时 + 结束方式（完成/停止/出错）。渲染层在 completeRun /
   * 用户停止 / 出错时写入，加载历史后回填到对应 turn，重开应用/会话后仍能显示。
   */
  turnDurations?: Record<string, TurnDuration>;
  /**
   * 软重置影子 B 的 SDK session id（压缩生成后填）。
   * Phase 4 消费；Phase 1.3 仅备位字段。
   */
  shadowSessionId?: string;
  /**
   * 影子状态机：idle → compacting → ready → switching → switched
   * Phase 4 消费；Phase 1.3 仅备位字段。
   */
  shadowState?: "idle" | "compacting" | "ready" | "switching" | "switched";
  /**
   * 拉起 B 时 A 的末尾消息 uuid（切换补尾游标基准）。
   * Phase 4 消费；Phase 1.3 仅备位字段。
   */
  shadowCursor?: string;
  /**
   * 单向链前驱（A→B→C），归档溯源用。
   * Phase 4 消费；Phase 1.3 仅备位字段。
   */
  shadowChainPrev?: string;
  /**
   * 阈值自学习回写的安全上限（token）。
   * Phase 5 消费；resolveModelSafeContextLimit 可读此字段。
   */
  learnedSafeContextLimit?: number;
  /**
   * 上次爆点 token 数（自学习用）。
   * Phase 5 消费。
   */
  lastBurstTokenCount?: number;
  /** 手动标记为工作中 */
  manualWorking?: boolean;
  /** Agent 执行完成但用户尚未确认（跨重启保留在工作中列表） */
  completedButUnconfirmed?: boolean;
  /** 最后一次流式执行是否被用户主动中断 */
  stoppedByUser?: boolean;
  /** 该会话当前的权限模式（持久化到磁盘，重启后恢复）。未设置时新会话默认 bypassPermissions */
  permissionMode?: TAgentPermissionMode;
  /**
   * 协作/执行形态（Chat 只读讨论 | Work 真干活）。
   * 与 permissionMode 分层：Plan/自动/完全自动仅在 work 下约束写操作。
   * 未设置时 migrate 回退 work（兼容旧会话）；新建会话默认 work（DEFAULT_EXECUTION_MODE）。
   * @see docs/decisions/ADR-0003-execution-mode-chat-work.md
   */
  executionMode?: ExecutionMode;
  /**
   * executionMode 切换审计（可选，最近 N 条由主进程裁剪）
   * @see docs/decisions/ADR-0005-user-owned-mode-switch.md
   */
  executionModeHistory?: ExecutionModeHistoryEntry[];
  /**
   * 待用户确认的形态切换建议（Chat↔Work 确认条）。
   * 确认后清空并写入 executionMode；取消仅清空。
   */
  pendingExecutionModeSuggestion?: ExecutionModeSuggestion | null;
  /**
   * 子代理委派积极性（持久化到磁盘，重启后恢复）。未设置时新会话默认 conservative。
   * 主进程构建 kscc query 时读取该值，注入 SubAgent 委派策略 systemPrompt append
   * （Pi 核 systemPrompt 为整体替换非 append，当前仅 kscc 核生效）。
   */
  subagentEagerness?: SubagentEagerness;
  /**
   * 会话偏好的 CLI 工人 id（持久化，重启恢复）。
   * 未设置 / 空 = 跟随全局（启用池优先级自动挑选）。
   * 发起 task 且未显式传 cli 时作为 preferredCliId 注入；显式 cli 仍最高优先。
   * 已禁用/已删除的 id 由 resolve 自动回落池内，不报错。
   */
  cliWorkerId?: string;
  /**
   * 思考强度（持久化到磁盘，重启后恢复）。未设置时新会话默认 medium。
   * 控制 Claude extended thinking / adaptive thinking 的深度档位，发送时注入到 SDK query。
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Composer 档位（per-session 持久化）
   * - 'ask'：输入区 Ask 档位，只对话，不能写文件/执行命令
   * - 'agent'：输入区 Agent 档位，可动手（默认）
   * 留空时新会话使用 DEFAULT_COMPOSER_MODE（'agent'）
   * @see docs/plans/2026-06-13-ask-mode-unification-design.md §4.1
   */
  lastComposerMode?: ComposerMode;
  /** 用户接管标记（true=定时任务不再注入消息，避免污染用户私人会话） */
  automationGraduated?: boolean;
  /** 创建来源的定时任务 ID（由 automation-scheduler 在创建子会话时写入） */
  sourceAutomationId?: string;
  /**
   * 看板：该会话拥有的看板 ID（由 kanban_create_board / attachBoardToSession 写入主会话 meta）。
   * 渲染进程据此决定是否显示「团队」二级 Tab。
   * 与 parentBoardId 区分：parentBoardId 表示子会话属于哪个看板，boardId 表示主会话拥有哪个看板。
   */
  boardId?: string;
  /**
   * 看板：子会话所属看板 ID（由 kanban-worker-service 创建工人子会话时写入）。
   * B4 起支持 general / TA 双模式，TA 会话也可作为看板工人。
   */
  parentBoardId?: string;
  /**
   * 看板：触发该子会话的看板任务 ID（t_xxxx）。
   * 与 parentBoardId 一起写入，用于侧栏关联展示和 dispatcher 状态回流。
   */
  sourceKanbanTaskId?: string;
  /**
   * 隐藏会话：不出现在侧栏列表（看板工人 headless 会话等）。
   * listSessions 默认过滤；调试可用 includeHidden。
   */
  hidden?: boolean;
  /**
   * Chat @ 提及：下一轮助手应以这些角色顺序发言（roleId 列表）。
   * 发消息时写入；turn_end 后清空。
   */
  pendingMentionRoleIds?: string[];
  /**
   * 知识库（Library）绑定的根目录绝对路径列表（0..N）。
   *
   * Phase 0：会话级只读检索配置。Agent 经 kb_list_roots / kb_search / kb_get 工具
   * 在这些根目录下扫描 .md/.txt 并按需引用，命中带来源路径。未配置（空/缺省）时
   * 工具明确返回空结果，不扫全盘。与 L0–L5 记忆 / BotMemory 物理隔离，KB 零写入。
   * 绑定变化会影响工具指纹（Pi 热重建）/ 长驻进程配置（kscc re-spawn）。
   * @see docs/dev/knowledge-base/KB-PRODUCT-SPEC-v1.md §5 Phase 0
   */
  kbRoots?: string[];
  /** 全局知识库 ID 列表；与 workspaceId 无关，可跨项目复用 */
  knowledgeBaseIds?: string[];
  /** 当前会话的知识库使用策略，缺省为 off 以兼容旧会话。 */
  knowledgeBaseMode?: KnowledgeBaseMode;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/**
 * Agent 持久化消息
 *
 * 存储在 ~/.tagent/agent-sessions/{id}.jsonl 中。
 */
export interface AgentMessage {
  /** 消息唯一标识 */
  id: string;
  /** 角色 */
  role: "user" | "assistant" | "tool" | "status";
  /** 消息内容 */
  content: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 使用的模型 ID（assistant 消息） */
  model?: string;
  /** 工具活动数据（agent 事件列表，用于回放工具调用） */
  events?: AgentEvent[];
  /** 错误代码（status 消息，role='status' 时使用） */
  errorCode?: ErrorCode;
  /** 错误标题（status 消息） */
  errorTitle?: string;
  /** 错误详细信息（status 消息） */
  errorDetails?: string[];
  /** 原始错误消息（status 消息） */
  errorOriginal?: string;
  /** 是否可以重试（status 消息） */
  errorCanRetry?: boolean;
  /** 错误恢复操作（status 消息） */
  errorActions?: RecoveryAction[];
  /** 耗时（毫秒），assistant 消息从流式开始到完成的时间 */
  durationMs?: number;
  /** Token 用量明细（assistant 消息完成时记录） */
  usage?: AgentEventUsage;
}

// ===== Agent 消息搜索 =====

/**
 * Agent 会话消息搜索结果
 */
export interface AgentMessageSearchResult {
  /** 会话 ID */
  sessionId: string;
  /** 会话标题 */
  sessionTitle: string;
  /** 消息 ID */
  messageId: string;
  /** 消息角色 */
  role: "user" | "assistant" | "tool" | "status";
  /** 匹配上下文片段（约 80 字符） */
  snippet: string;
  /** snippet 内匹配起始位置 */
  matchStart: number;
  /** 匹配长度 */
  matchLength: number;
  /** 是否已归档 */
  archived?: boolean;
}

/**
 * Agent 会话引用搜索输入
 */
export interface AgentSessionReferenceSearchInput {
  /** 目标工作区 ID，仅搜索该工作区下的会话 */
  workspaceId: string;
  /** 搜索关键词，匹配标题或消息内容 */
  query?: string;
  /** 排除当前会话，避免引用自己 */
  excludeSessionId?: string;
  /** 最大返回数量 */
  limit?: number;
}

/**
 * Agent 会话引用搜索结果
 */
export interface AgentSessionReferenceSearchResult {
  /** 会话 ID */
  sessionId: string;
  /** 会话标题 */
  title: string;
  /** 更新时间戳 */
  updatedAt: number;
  /** 命中消息片段；标题命中时可为空 */
  snippet?: string;
  /** 命中来源 */
  matchSource: "title" | "message" | "recent";
}

// ===== Agent 标题生成输入 =====

/** Agent 标题生成输入 */
export interface AgentGenerateTitleInput {
  /** 用户第一条消息内容 */
  userMessage: string;
  /** 渠道 ID（用于获取 API Key） */
  channelId: string;
  /** 模型 ID */
  modelId: string;
}

// ===== MCP 服务器配置 =====

/** MCP 传输类型 */
export type McpTransportType = "stdio" | "http" | "sse";

/** MCP 服务器条目 */
export interface McpServerEntry {
  type: McpTransportType;
  /** stdio: 可执行命令 */
  command?: string;
  /** stdio: 命令参数 */
  args?: string[];
  /** stdio: 环境变量 */
  env?: Record<string, string>;
  /** http/sse: 服务端 URL */
  url?: string;
  /** http/sse: 请求头 */
  headers?: Record<string, string>;
  /** 启动超时（秒），仅 stdio 类型有效，默认 30 */
  timeout?: number;
  /** 是否启用 */
  enabled: boolean;
  /** 是否为内置 MCP（不可删除，仅可配置 env） */
  isBuiltin?: boolean;
  /** 最后一次测试结果 */
  lastTestResult?: {
    success: boolean;
    message: string;
    timestamp: number;
  };
}

/** 工作区 MCP 配置文件 */
export interface WorkspaceMcpConfig {
  servers: Record<string, McpServerEntry>;
}

// ===== Skill 元数据 =====

/** 从其他工作区导入的 Skill 来源元数据 */
export interface SkillImportSource {
  sourceWorkspaceSlug: string;
  sourceWorkspaceName: string;
  importedAt: string; // ISO 8601
  sourceVersion: string; // 导入时源 Skill 的 version，无则 '0.0.0'
}

/** Skill 来源域（Curator 只自动治理 background / agent 创建的 skill） */
export type SkillProvenance = "foreground" | "background";

/** Skill 创建主体 */
export type SkillCreatedBy = "official" | "market" | "user" | "agent";

/** Skill 生命周期（方案 D 静态状态机） */
export type SkillLifecycleStatus = "draft" | "active" | "stale" | "archived";

/** Skill 作用域：全局共享 vs 工作区专属 */
export type SkillScope = "global" | "workspace";

/** 工作区 Skill 元数据 */
export interface SkillMeta {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  version?: string;
  enabled: boolean;
  /** 如果此 Skill 是从其他工作区导入的，则携带来源信息 */
  importSource?: SkillImportSource;
  /** 是否有可用更新（源 Skill 版本 > importSource.sourceVersion） */
  hasUpdate?: boolean;
  /** 允许该 Skill 调用的工具列表（Claude Code 标准 frontmatter 字段） */
  allowedTools?: string[];
  /** 许可证标识（如 MIT / Apache-2.0） */
  license?: string;
  /** 自定义元数据（键值对，如 author / homepage 等） */
  metadata?: Record<string, string>;
  /** 分类标签（如 planning / debugging / testing） */
  category?: string;
  /** 兼容性声明（如 requires-claude-code: ">=1.0"） */
  compatibility?: string;
  /**
   * 来源域：foreground=用户/官方/商店；background=agent 静默自创。
   * Curator 只自动升降 background。
   */
  provenance?: SkillProvenance;
  /** 创建主体（统计与 UI 徽章） */
  createdBy?: SkillCreatedBy;
  /** 生命周期状态 */
  status?: SkillLifecycleStatus;
  /** 钉住后跳过自动状态转换 */
  pinned?: boolean;
  /** 作用域 */
  scope?: SkillScope;
  /** 使用次数（来自 .usage.json 埋点） */
  useCount?: number;
  /** 上次使用时间（epoch ms） */
  lastUsedAt?: number;
}

/** Skill 目录下的文件/子目录节点（递归树） */
export interface SkillFileNode {
  /** 相对于 Skill 根目录的相对路径，使用 POSIX 分隔符 */
  relativePath: string;
  /** 末段名字（用于显示） */
  name: string;
  /** 类型：文件 / 目录 */
  type: "file" | "directory";
  /** 文件大小（字节）；目录为 undefined */
  size?: number;
  /** 是否为文本文件（可在内置编辑器中打开）；目录为 undefined */
  isText?: boolean;
  /** 子节点（仅 type=directory 有值，已按目录优先 + 名称排序） */
  children?: SkillFileNode[];
}

/** 读取 Skill 子文件的响应 */
export interface SkillFileContent {
  relativePath: string;
  /** 文本内容（仅 isText=true 时存在） */
  content?: string;
  /** 是否为文本文件 */
  isText: boolean;
  /** 文件大小（字节） */
  size: number;
}

/** 工作区能力摘要（MCP + Skill + 已安装整合包记录） */
export interface WorkspaceCapabilities {
  mcpServers: Array<{ name: string; enabled: boolean; type: McpTransportType }>;
  skills: SkillMeta[];
  /** 来自 plugins-installed.json 的整合包安装记录 */
  installedBundles: import("../plugin-store-bundles").WorkspacePluginBundleRecord[];
}

// ===== Agent 发送输入 =====

/**
 * Agent 发送消息的输入参数
 */
export interface AgentSendInput {
  /** 会话 ID */
  sessionId: string;
  /** 用户消息内容 */
  userMessage: string;
  /** 渠道 ID（用于获取 API Key） */
  channelId: string;
  /** 模型 ID */
  modelId?: string;
  /** 工作区 ID（用于确定 cwd） */
  workspaceId?: string;
  /** 附加的外部目录（绝对路径，传递给 SDK additionalDirectories） */
  additionalDirectories?: string[];
  /** 动态注入的 MCP 服务器（仅在本次会话中生效，如飞书群聊工具） */
  customMcpServers?: Record<string, Record<string, unknown>>;
  /** 强制覆盖权限模式（飞书等无 UI 交互场景下强制 'bypassPermissions'） */
  permissionModeOverride?: TAgentPermissionMode;
  /** 用户通过 /skill:xxx 引用的 Skill slug 列表 */
  mentionedSkills?: string[];
  /** 用户通过 #mcp:xxx 引用的 MCP 服务器名称列表 */
  mentionedMcpServers?: string[];
  /** 用户通过会话引用 mention 指定的 Agent 会话 ID 列表 */
  mentionedSessionIds?: string[];
  /** 渲染进程生成的流式开始时间戳，主进程原样回传到 STREAM_COMPLETE，确保竞态保护比较的是同一个值 */
  startedAt?: number;
  /** 定时任务自动化上下文（注入到 prompt 前，告诉 Agent 这是定时任务执行） */
  automationContext?: string;
  /** 定时任务触发来源标识（如 'automation'） */
  triggeredBy?: string;
}

// ===== Agent 队列消息 =====

/** 流式追加消息的输入参数（Agent 流式中发送新消息） */
export interface AgentQueueMessageInput {
  /** 会话 ID */
  sessionId: string;
  /** 用户消息内容 */
  userMessage: string;
  /** 前端预生成的 UUID（用于乐观更新去重） */
  uuid?: string;
  /**
   * 软中断当前 Agent turn 后再追加消息。
   * true：先调用 SDK query.interrupt() 立即打断正在输出的 turn，再注入消息。
   * false / undefined：排队追加（默认行为，turn 结束后才会被消费）。
   */
  interrupt?: boolean;
}

// ===== Fork / Rewind 输入 =====

/** Fork（分叉）会话输入 */
export interface ForkSessionInput {
  /** TAgent 会话 ID */
  sessionId: string;
  /** SDK 消息 uuid（截断点，inclusive）。省略时复制全部历史 */
  upToMessageUuid?: string;
}

/** 快照回退输入（同一会话内回退到指定点） */
export interface RewindSessionInput {
  /** TAgent 会话 ID */
  sessionId: string;
  /** 回退到哪条 assistant message（inclusive，截断该消息之后的一切） */
  assistantMessageUuid: string;
}

/** 快照回退结果 */
export interface RewindSessionResult {
  /** 截断后剩余的消息数 */
  remainingMessages: number;
  /** 文件恢复结果（enableFileCheckpointing 启用时可用） */
  fileRewind?: {
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  };
}

// ===== 后台任务管理 =====

/**
 * 获取任务输出请求
 */
export interface GetTaskOutputInput {
  /** 任务 ID */
  taskId: string;
  /** 是否阻塞等待完成（默认 false） */
  block?: boolean;
}

/**
 * 获取任务输出响应
 */
export interface GetTaskOutputResult {
  /** 任务输出内容 */
  output: string;
  /** 任务是否已完成 */
  isComplete: boolean;
}

/**
 * 停止任务请求
 */
export interface StopTaskInput {
  /** 会话 ID */
  sessionId: string;
  /** 任务 ID */
  taskId: string;
  /** 任务类型 */
  type: "agent" | "shell";
}

// ===== Agent 流式事件载荷 =====

/**
 * Agent 流式事件（主进程 → 渲染进程推送）
 */
export interface AgentStreamEvent {
  /** 会话 ID */
  sessionId: string;
  /** 事件数据（新格式） */
  payload: AgentStreamPayload;
  /** @deprecated 兼容旧格式，Phase 2 后移除 */
  event?: AgentEvent;
}

/**
 * Agent 流式完成事件载荷（主进程 → 渲染进程）
 * 包含已持久化的消息列表，避免异步重新加载的竞态窗口。
 */
export interface AgentStreamCompletePayload {
  sessionId: string;
  /** 已持久化的完整消息列表 */
  messages?: AgentMessage[];
  /** 是否由用户手动中止 */
  stoppedByUser?: boolean;
  /** 本轮流式开始时间戳（用于区分新旧流，防止旧流的 complete 事件重置新流状态） */
  startedAt?: number;
  /** SDK result 消息的 subtype（success / error_max_turns / error_max_budget_usd / error_during_execution 等） */
  resultSubtype?: string;
  /** 本轮主体结束但仍有后台任务在飞行：UI 进入空闲可输入态，等待 task_notification 自动续轮 */
  backgroundTasksPending?: boolean;
}

// ===== 文件浏览器 =====

/** 文件/目录条目（用于文件浏览器树形视图） */
export interface FileEntry {
  /** 文件/目录名称 */
  name: string;
  /** 完整路径 */
  path: string;
  /** 是否为目录 */
  isDirectory: boolean;
  /** 文件大小（字节）。目录为空 */
  size?: number;
  /** 子条目（懒加载，仅目录展开时填充） */
  children?: FileEntry[];
}

/** 文件索引条目（用于 @ 引用搜索） */
export interface FileIndexEntry {
  /** 文件/目录名称 */
  name: string;
  /** 相对于工作区的路径 */
  path: string;
  /** 条目类型 */
  type: "file" | "dir";
  /** 来源：会话文件或工作区文件 */
  source: "session" | "workspace";
}

/** 文件搜索结果 */
export interface FileSearchResult {
  entries: FileIndexEntry[];
  total: number;
  /** 会话文件条目（来自 session 工作目录） */
  sessionEntries: FileIndexEntry[];
  /** 工作区文件条目（来自 workspace files + 附加目录） */
  workspaceEntries: FileIndexEntry[];
}

// ===== Agent 附件 =====

/** Agent 待发送文件（UI 侧暂存） */
export interface AgentPendingFile {
  id: string;
  filename: string;
  size: number;
  mediaType: string;
  /** 图片预览 URL（blob/data URL） */
  previewUrl?: string;
  /** 文件原始路径（从侧面板添加时设置，发送时跳过复制直接引用） */
  sourcePath?: string;
  /**
   * 标记 sourcePath 指向的是剪贴板临时预览文件（os.tmpdir）。
   * 这类文件可能被系统清理，发送时需读取其最新内容拷贝进 session 目录，
   * 而非像侧面板真实文件那样原地引用。
   */
  isClipboardDraft?: boolean;
}

/** Agent 文件保存到 session 的输入 */
export interface AgentSaveFilesInput {
  workspaceSlug: string;
  sessionId: string;
  files: Array<{ filename: string; data: string }>;
}

/** Agent 已保存文件信息 */
export interface AgentSavedFile {
  filename: string;
  targetPath: string;
}

/** Agent 文件保存到工作区文件目录的输入 */
export interface AgentSaveWorkspaceFilesInput {
  workspaceSlug: string;
  files: Array<{ filename: string; data: string }>;
}

/** 附加/分离目录的输入参数 */
export interface AgentAttachDirectoryInput {
  /** 会话 ID */
  sessionId: string;
  /** 目录的绝对路径 */
  directoryPath: string;
}

/** 附加/分离文件的输入参数 */
export interface AgentAttachFileInput {
  /** 会话 ID */
  sessionId: string;
  /** 文件的绝对路径 */
  filePath: string;
}

/** 工作区级附加/分离目录的输入参数 */
export interface WorkspaceAttachDirectoryInput {
  /** 工作区 slug */
  workspaceSlug: string;
  /** 目录的绝对路径 */
  directoryPath: string;
}

/** 工作区级附加/分离文件的输入参数 */
export interface WorkspaceAttachFileInput {
  /** 工作区 slug */
  workspaceSlug: string;
  /** 文件的绝对路径 */
  filePath: string;
}

/** Worktree 仓库配置 */
export interface WorkspaceWorktreeRepo {
  /** 显示名称 */
  name: string;
  /** 主仓库绝对路径 */
  repoPath: string;
  /** Worktree 存放目录绝对路径 */
  worktreesPath: string;
  /** 优先级（数字越小越优先） */
  priority?: number;
}

/** 支持自动检查的语言标识 */
export type AutoCheckLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "lua"
  | "cpp"
  | "java";

/** 单个语言的精细配置 */
export interface LanguageHookConfig {
  /** 是否启用该语言的检查（默认：TS/JS/Python/Rust/Go/Lua 为 true，C++/Java 为 false） */
  enabled?: boolean;
  /** 检查命令超时（秒），不设用语言默认（多数 60s，Rust 120s） */
  timeoutSec?: number;
}

/** 全局 hook 开关配置（应用级，存 settings.json） */
export interface HooksConfig {
  /** auto-check 钩子是否启用（默认 true）：Edit/Write 代码后自动跑检查命令 */
  autoCheck?: boolean;
  /** 各语言的精细配置（覆盖默认值） */
  languages?: Partial<Record<AutoCheckLanguage, LanguageHookConfig>>;
  /** @deprecated 旧字段名，向后兼容；新逻辑读 autoCheck */
  autoTypecheck?: boolean;
}

// ===== AskUserQuestion 交互式问答类型 =====

/** AskUserQuestion 工具的选项定义 */
export interface AskUserQuestionOption {
  /** 选项显示文本 */
  label: string;
  /** 选项说明 */
  description?: string;
  /** 选项预览内容（聚焦时展示，支持 Markdown） */
  preview?: string;
}

/** AskUserQuestion 工具的问题定义 */
export interface AskUserQuestion {
  /** 问题内容 */
  question: string;
  /** 短标签（chip 显示） */
  header?: string;
  /** 可选项列表 */
  options: AskUserQuestionOption[];
  /** 是否支持多选 */
  multiSelect?: boolean;
}

/** AskUser 请求（主进程 → 渲染进程） */
export interface AskUserRequest {
  /** 请求唯一 ID */
  requestId: string;
  /** 会话 ID */
  sessionId: string;
  /** 问题列表 */
  questions: AskUserQuestion[];
  /** 工具原始输入（用于构建 updatedInput） */
  toolInput: Record<string, unknown>;
}

/** AskUser 响应（渲染进程 → 主进程） */
export interface AskUserResponse {
  /** 请求 ID */
  requestId: string;
  /** 用户答案（问题文本 → 答案文本，与 SDK 约定一致） */
  answers: Record<string, string>;
}

// ===== ExitPlanMode 计划审批类型 =====

/** ExitPlanMode SDK 工具输入中的 allowedPrompts 项 */
export interface ExitPlanAllowedPrompt {
  /** 工具名称（目前仅 "Bash"） */
  tool: "Bash";
  /** 语义化的操作描述（如 "run tests"、"install dependencies"） */
  prompt: string;
}

/** ExitPlanMode 请求（主进程 → 渲染进程） */
export interface ExitPlanModeRequest {
  /** 请求唯一 ID */
  requestId: string;
  /** 会话 ID */
  sessionId: string;
  /** SDK 工具原始输入 */
  toolInput: Record<string, unknown>;
  /**
   * 解析后的计划正文（Markdown）。
   * 优先 toolInput.plan；空则主进程读 toolInput.planFilePath（UTF-8，限 64KB）回填。
   * Banner 内 Markdown 渲染展示给用户审批。
   */
  plan?: string;
  /** 解析后的 allowedPrompts 列表 */
  allowedPrompts: ExitPlanAllowedPrompt[];
}

/** ExitPlanMode 用户选择行为 */
export type ExitPlanModeAction =
  "approve_auto" | "approve_edit" | "deny" | "feedback";

/** ExitPlanMode 响应（渲染进程 → 主进程） */
export interface ExitPlanModeResponse {
  /** 请求 ID */
  requestId: string;
  /** 用户选择的行为 */
  action: ExitPlanModeAction;
  /** 用户反馈内容（action 为 feedback 时有值） */
  feedback?: string;
}

// ===== 权限系统类型 =====

/** 当前 TAgent 支持的权限模式，值直接映射 SDK 原生 permissionMode */
export const TAGENT_PERMISSION_MODES = [
  "auto",
  "bypassPermissions",
  "plan",
] as const;

export type TAgentPermissionMode = (typeof TAGENT_PERMISSION_MODES)[number];

/** 新建会话默认：完全自动（对齐 Proma 开箱写文件，不打扰） */
export const TAGENT_DEFAULT_PERMISSION_MODE: TAgentPermissionMode =
  "bypassPermissions";

export interface TAgentPermissionModeConfig {
  /** 对应 Claude Agent SDK 的 permissionMode */
  sdkMode: TAgentPermissionMode;
  label: string;
  description: string;
}

/** TAgent 权限模式的单一配置来源 */
export const TAGENT_PERMISSION_MODE_CONFIG = {
  auto: {
    sdkMode: "auto",
    label: "自动审批",
    description: "只读操作自动放行，写操作需确认",
  },
  bypassPermissions: {
    sdkMode: "bypassPermissions",
    label: "完全自动",
    description: "所有工具调用自动允许",
  },
  plan: {
    sdkMode: "plan",
    label: "计划模式",
    description: "仅规划不执行，查看工具使用计划",
  },
} as const satisfies Record<TAgentPermissionMode, TAgentPermissionModeConfig>;

/** 权限模式定义顺序（用于循环切换） */
export const TAGENT_PERMISSION_MODE_ORDER: readonly TAgentPermissionMode[] =
  TAGENT_PERMISSION_MODES;

export function isTAgentPermissionMode(
  mode: string,
): mode is TAgentPermissionMode {
  return (TAGENT_PERMISSION_MODES as readonly string[]).includes(mode);
}

/** 规范化权限模式：不匹配当前三种模式时统一回到默认（bypassPermissions） */
export function migratePermissionMode(mode: string): TAgentPermissionMode {
  if (isTAgentPermissionMode(mode)) return mode;
  return TAGENT_DEFAULT_PERMISSION_MODE;
}

/** 危险等级 */
export type DangerLevel = "safe" | "normal" | "dangerous";

/** 权限请求（主进程 → 渲染进程） */
export interface PermissionRequest {
  /** 请求唯一 ID */
  requestId: string;
  /** 会话 ID */
  sessionId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具输入参数 */
  toolInput: Record<string, unknown>;
  /** 操作描述（人类可读，TAgent 生成） */
  description: string;
  /** 具体命令（Bash 工具时有值��� */
  command?: string;
  /** 危险等级 */
  dangerLevel: DangerLevel;
  /** SDK 提供的原因说明 */
  decisionReason?: string;
  /** SDK 提供的原因分类，如 classifier / safetyCheck / rule */
  decisionReasonType?: string;
  /** SDK auto safety check 是否允许交给 classifier 审批 */
  classifierApprovable?: boolean;
  /** SDK 提供的工具显示名称，如 "Write" */
  sdkDisplayName?: string;
  /** SDK 提供的操作标题，如 "Write to /path/to/file.ts" */
  sdkTitle?: string;
  /** SDK 提供的详细描述，如 "Claude wants to write 200 lines to /path/to/file.ts" */
  sdkDescription?: string;
  /** SDK 报告的越界路径（Agent 尝试访问项目范围外的目录） */
  blockedPath?: string;
  /** SDK 建议的权限更新（如 addDirectories） */
  suggestions?: PermissionUpdate[];
}

/** SDK PermissionUpdateDestination */
export type PermissionUpdateDestination =
  "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

/** SDK 权限规则值 */
export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

/** SDK PermissionUpdate（匹配 SDK 0.2.63） */
export type PermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: PermissionRuleValue[];
      behavior: "allow" | "deny";
      destination: PermissionUpdateDestination;
    }
  | {
      type: "setMode";
      mode: string;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "addDirectories" | "removeDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    };

/** 权限响应（渲染进程 → 主进程） */
export interface PermissionResponse {
  requestId: string;
  behavior: "allow" | "deny";
  /** 是否记住选择（加入会话白名单） */
  alwaysAllow: boolean;
  /** 用户批准扩展的目录（来自 blockedPath 场景） */
  addDirectories?: string[];
}

// ===== IPC 通道常量 =====

/**
 * Agent 相关 IPC 通道常量
 */
export const AGENT_IPC_CHANNELS = {
  // 会话管理
  /** 获取会话列表 */
  LIST_SESSIONS: "agent:list-sessions",
  /** 创建会话 */
  CREATE_SESSION: "agent:create-session",
  /** 获取会话 SDKMessage（Phase 4 新格式） */
  GET_SDK_MESSAGES: "agent:get-sdk-messages",
  /** 更新会话标题 */
  UPDATE_TITLE: "agent:update-title",
  /** 更新会话元数据（channelId, modelId 等） */
  UPDATE_SESSION_META: "agent:update-session-meta",
  /** 列出全局知识库 */
  LIST_KNOWLEDGE_BASES: "agent:list-knowledge-bases",
  /** 创建全局知识库 */
  CREATE_KNOWLEDGE_BASE: "agent:create-knowledge-base",
  /** 删除全局知识库 */
  DELETE_KNOWLEDGE_BASE: "agent:delete-knowledge-base",
  /** 添加知识库来源目录 */
  ADD_KNOWLEDGE_BASE_SOURCE: "agent:add-knowledge-base-source",
  /** 移除知识库来源 */
  REMOVE_KNOWLEDGE_BASE_SOURCE: "agent:remove-knowledge-base-source",
  /** 列出知识库文档，可按标题和正文搜索 */
  LIST_KNOWLEDGE_BASE_DOCUMENTS: "agent:list-knowledge-base-documents",
  /** 创建知识库文档 */
  CREATE_KNOWLEDGE_BASE_DOCUMENT: "agent:create-knowledge-base-document",
  /** 更新知识库文档 */
  UPDATE_KNOWLEDGE_BASE_DOCUMENT: "agent:update-knowledge-base-document",
  /** 删除知识库文档 */
  DELETE_KNOWLEDGE_BASE_DOCUMENT: "agent:delete-knowledge-base-document",
  /** 从本地文档导入知识库文档 */
  IMPORT_KNOWLEDGE_BASE_DOCUMENT: "agent:import-knowledge-base-document",
  IMPORT_KNOWLEDGE_BASE_DOCUMENT_URL:
    "agent:import-knowledge-base-document-url",
  /** 删除会话 */
  DELETE_SESSION: "agent:delete-session",
  /** 迁移 Chat 对话记录到 Agent 会话 */
  MIGRATE_CHAT_TO_AGENT: "agent:migrate-chat-to-agent",
  /** 切换会话置顶状态 */
  TOGGLE_PIN: "agent:toggle-pin",
  /** 切换会话手动工作中状态 */
  TOGGLE_MANUAL_WORKING: "agent:toggle-manual-working",
  /** 确认会话已完成（清除 completedButUnconfirmed 和 manualWorking） */
  CONFIRM_WORKING_DONE: "agent:confirm-working-done",
  /** 切换会话归档状态 */
  TOGGLE_ARCHIVE: "agent:toggle-archive",
  /** 查会话生命状态（组合 runtimes 内存 turnInFlight + meta.error + meta.archived） */
  GET_SESSION_STATUS: "agent:get-session-status",
  /** 清除 Chat @ 对话跟随（activeSpeaker；清空 pendingMentionRoleIds 回默认总助） */
  CLEAR_MENTION_FOLLOW: "agent:clear-mention-follow",
  /** 搜索会话消息内容 */
  SEARCH_MESSAGES: "agent:search-messages",
  /** 搜索指定工作区可引用的 Agent 会话 */
  SEARCH_SESSION_REFERENCES: "agent:search-session-references",
  /** 分叉会话（从指定消息处创建新会话） */
  FORK_SESSION: "agent:fork-session",
  /** 快照回退（同一会话内回退到指定点，恢复文件 + 截断对话） */
  REWIND_SESSION: "agent:rewind-session",

  // 工作区管理
  /** 获取工作区列表 */
  LIST_WORKSPACES: "agent:list-workspaces",
  /** 创建工作区 */
  CREATE_WORKSPACE: "agent:create-workspace",
  /** 创建项目工作区（用户选择本地代码目录） */
  CREATE_PROJECT_WORKSPACE: "agent:create-project-workspace",
  /** 更新工作区 */
  UPDATE_WORKSPACE: "agent:update-workspace",
  /** 删除工作区 */
  DELETE_WORKSPACE: "agent:delete-workspace",
  /** 重排工作区顺序 */
  REORDER_WORKSPACES: "agent:reorder-workspaces",

  // 标题生成
  /** 生成 Agent 会话标题 */
  GENERATE_TITLE: "agent:generate-title",

  // P1-3: Context 压缩
  /** 客户端主动压缩会话历史（SDK 压缩失败时的 fallback）*/
  COMPACT_SESSION: "agent:compact-session",
  // 消息发送
  /** 发送消息（触发 Agent 流式响应） */
  SEND_MESSAGE: "agent:send-message",
  /** 中止 Agent 执行 */
  STOP_AGENT: "agent:stop",
  /** 撤回尚未开始处理的最后一轮 user 输入（停止前未进入 Agent 处理） */
  RECALL_UNSENT_TURN: "agent:recall-unsent-turn",
  /** 引导 Agent（不中断当前轮，在下一轮边界注入用户消息） */
  STEER_AGENT: "agent:steer",
  /** 圆桌讨论用户插话（push 到活跃讨论 pending 队列，每轮开始前 drain 注入） */
  DISCUSSION_INTERJECT: "agent:discussion-interject",
  /** 圆桌讨论用户喊停（abort 活跃讨论 controller，走 cancelled 路径） */
  DISCUSSION_STOP: "agent:discussion-stop",
  /**
   * 圆桌讨论重放（重启/切会话后）：主进程读该会话 moa-discussion.jsonl，把每场已落盘讨论
   * 按原 moa_discussion 事件推回渲染层，渲染层按 discussionId upsert 成入口卡 + 讨论室回看。
   */
  REPLAY_MOA_DISCUSSIONS: "agent:replay-moa-discussions",

  // 后台任务管理
  /** 获取任务输出 */
  GET_TASK_OUTPUT: "agent:get-task-output",
  /** 停止任务 */
  STOP_TASK: "agent:stop-task",
  /** 列出本会话仍在跑的后台进程（Bash / CLI 工人） */
  LIST_SESSION_PROCESSES: "agent:list-session-processes",
  /** 杀掉本会话某个后台进程 */
  KILL_SESSION_PROCESS: "agent:kill-session-process",
  /** 主→渲染：本会话后台进程列表变化 */
  SESSION_PROCESSES_CHANGED: "agent:session-processes-changed",

  // 工作区能力（MCP + Skill）
  /** 触发自动归档 */
  RUN_AUTO_ARCHIVE: "agent:run-auto-archive",

  /** 获取工作区能力摘要 */
  GET_CAPABILITIES: "agent:get-capabilities",
  /** 获取工作区 MCP 配置 */
  GET_MCP_CONFIG: "agent:get-mcp-config",
  /** 保存工作区 MCP 配置 */
  SAVE_MCP_CONFIG: "agent:save-mcp-config",
  /** 测试 MCP 服务器连接 */
  TEST_MCP_SERVER: "agent:test-mcp-server",
  /** 获取工作区 Skill 列表 */
  GET_SKILLS: "agent:get-skills",
  /** 获取工作区 Skills 目录绝对路径 */
  GET_SKILLS_DIR: "agent:get-skills-dir",
  /** 删除工作区 Skill */
  DELETE_SKILL: "agent:delete-skill",
  /** 切换工作区 Skill 启用/禁用 */
  TOGGLE_SKILL: "agent:toggle-skill",
  /** 从插件商店安装内置 Skill */
  INSTALL_STORE_SKILL: "agent:install-store-skill",
  /** 从插件商店安装整合包 */
  INSTALL_STORE_BUNDLE: "agent:install-store-bundle",
  /** 获取插件商店目录 */
  GET_PLUGIN_STORE_CATALOG: "agent:get-plugin-store-catalog",
  /** 获取工作区已安装整合包记录（plugins-installed.json） */
  GET_INSTALLED_PLUGIN_BUNDLES: "agent:get-installed-plugin-bundles",
  /** 卸载整合包（移除 manifest 记录 + 仍匹配商店形态的 MCP + 记录的 Skill 目录） */
  UNINSTALL_STORE_BUNDLE: "agent:uninstall-store-bundle",
  /** 读取 SKILL.md 全文内容 */
  READ_SKILL_CONTENT: "agent:read-skill-content",
  /** 写入 SKILL.md 全文内容 */
  WRITE_SKILL_CONTENT: "agent:write-skill-content",
  /** 列出 Skill 目录下的子文件树（不含 SKILL.md） */
  LIST_SKILL_FILES: "agent:list-skill-files",
  /** 读取 Skill 目录下的子文件内容 */
  READ_SKILL_FILE: "agent:read-skill-file",
  /** 写入 Skill 目录下的子文件内容 */
  WRITE_SKILL_FILE: "agent:write-skill-file",
  /** 在 Skill 目录下创建文件或目录 */
  CREATE_SKILL_ENTRY: "agent:create-skill-entry",
  /** 删除 Skill 目录下的文件或目录 */
  DELETE_SKILL_ENTRY: "agent:delete-skill-entry",
  /** 重命名/移动 Skill 目录下的文件或目录 */
  RENAME_SKILL_ENTRY: "agent:rename-skill-entry",

  // 流式事件（主进程 → 渲染进程推送）
  /** Agent 流式事件 */
  STREAM_EVENT: "agent:stream:event",
  /** Agent 流式完成 */
  STREAM_COMPLETE: "agent:stream:complete",
  /** Agent 流式错误 */
  STREAM_ERROR: "agent:stream:error",

  // 附件
  /** 保存文件到 Agent session 工作目录 */
  SAVE_FILES_TO_SESSION: "agent:save-files-to-session",
  /** 保存文件到工作区文件目录 */
  SAVE_FILES_TO_WORKSPACE: "agent:save-files-to-workspace",
  /** 获取工作区文件目录路径 */
  GET_WORKSPACE_FILES_PATH: "agent:get-workspace-files-path",
  /** 打开文件夹选择对话框 */
  OPEN_FOLDER_DIALOG: "agent:open-folder-dialog",
  /** 附加外部目录到 Agent 会话 */
  ATTACH_DIRECTORY: "agent:attach-directory",
  /** 移除会话的附加目录 */
  DETACH_DIRECTORY: "agent:detach-directory",
  /** 附加外部文件到 Agent 会话 */
  ATTACH_FILE: "agent:attach-file",
  /** 移除会话的附加文件 */
  DETACH_FILE: "agent:detach-file",
  /** 附加外部目录到工作区（所有会话共享） */
  ATTACH_WORKSPACE_DIRECTORY: "agent:attach-workspace-directory",
  /** 移除工作区的附加目录 */
  DETACH_WORKSPACE_DIRECTORY: "agent:detach-workspace-directory",
  /** 附加外部文件到工作区（所有会话共享） */
  ATTACH_WORKSPACE_FILE: "agent:attach-workspace-file",
  /** 移除工作区的附加文件 */
  DETACH_WORKSPACE_FILE: "agent:detach-workspace-file",
  /** 获取工作区附加目录列表 */
  GET_WORKSPACE_DIRECTORIES: "agent:get-workspace-directories",
  /** 获取工作区附加文件列表 */
  GET_WORKSPACE_ATTACHED_FILES: "agent:get-workspace-attached-files",
  /** 获取工作区 worktree 仓库配置列表 */
  GET_WORKTREE_REPOS: "agent:get-worktree-repos",
  /** 添加 worktree 仓库到工作区配置 */
  ADD_WORKTREE_REPO: "agent:add-worktree-repo",
  /** 从工作区配置移除 worktree 仓库 */
  REMOVE_WORKTREE_REPO: "agent:remove-worktree-repo",

  // 文件系统操作
  /** 获取 session 工作路径 */
  GET_SESSION_PATH: "agent:get-session-path",
  /** 列出目录内容 */
  LIST_DIRECTORY: "agent:list-directory",
  /** 删除文件/空目录 */
  DELETE_FILE: "agent:delete-file",
  /** 用系统默认应用打开文件 */
  OPEN_FILE: "agent:open-file",
  /** 在系统文件管理器中显示文件 */
  SHOW_IN_FOLDER: "agent:show-in-folder",
  /** 重命名文件/目录 */
  RENAME_FILE: "agent:rename-file",
  /** 移动文件/目录到目标目录 */
  MOVE_FILE: "agent:move-file",
  /** 列出附加目录内容（无工作区路径限制） */
  LIST_ATTACHED_DIRECTORY: "agent:list-attached-directory",
  /** 在文件管理器中显示附加目录文件（无工作区路径限制） */
  SHOW_ATTACHED_IN_FOLDER: "agent:show-attached-in-folder",
  /** 重命名附加目录文件/目录（无工作区路径限制） */
  RENAME_ATTACHED_FILE: "agent:rename-attached-file",
  /** 移动附加目录文件/目录（无工作区路径限制） */
  MOVE_ATTACHED_FILE: "agent:move-attached-file",
  /** 检查路径类型（文件 or 目录），用于拖拽检测 */
  CHECK_PATHS_TYPE: "agent:check-paths-type",
  /** 读取附加目录文件内容为 base64（限制在已附加目录范围内，用于侧面板添加到聊天） */
  READ_ATTACHED_FILE: "agent:read-attached-file",
  /** 搜索工作区文件（用于 @ 引用） */
  SEARCH_WORKSPACE_FILES: "agent:search-workspace-files",
  /** 将文本内容写入临时预览文件并返回绝对路径 */
  WRITE_CLIPBOARD_PREVIEW: "agent:write-clipboard-preview",
  /** 读取工作区文件（富内容预览用；仅限已注册工作区目录内，防路径穿越） */
  READ_WORKSPACE_FILE: "agent:read-workspace-file",

  // 附件管理
  /** 保存附件到磁盘（base64 → 文件） */
  SAVE_ATTACHMENT: "agent:save-attachment",
  /** 读取附件为 base64 */
  READ_ATTACHMENT: "agent:read-attachment",
  /** 解析会话附件相对路径为绝对路径（~/.tagent/attachments/ 下） */
  RESOLVE_ATTACHMENT_PATH: "agent:resolve-attachment-path",
  /** 打开系统文件选择器 */
  OPEN_FILE_DIALOG: "agent:open-file-dialog",
  /** 用系统默认程序打开文件（消息内文件 chip 点击；相对路径按会话工作区解析） */
  OPEN_PATH: "agent:open-path",
  /** 解析相对/绝对路径是否存在（文件 chip 存在性检查；相对路径按候选 base 或会话工作区解析） */
  RESOLVE_FILE: "agent:resolve-file",
  /**
   * 读取文件在 git HEAD 的版本（Files Changed 审阅兜底：本轮补丁无法还原旧稿时，
   * 用 `git -C <root> show HEAD:<relposix>` 取旧稿做 unified diff）。
   * 无 git / 未跟踪 / 超时 → null。payload: { sessionId, path, bases? }。
   */
  READ_GIT_HEAD_FILE: "agent:read-git-head-file",

  // 标题自动生成通知（主进程 → 渲染进程推送）
  /** 标题已更新（首次对话完成后自动生成） */
  TITLE_UPDATED: "agent:title-updated",

  // 工作区配置变化通知（主进程 → 渲染进程推送）
  /** 工作区能力变化（MCP/Skills 文件监听触发） */
  CAPABILITIES_CHANGED: "agent:capabilities-changed",
  /** 工作区文件变化（session 目录文件监听触发，用于文件浏览器刷新） */
  WORKSPACE_FILES_CHANGED: "agent:workspace-files-changed",

  // 权限系统
  /** 权限请求（主进程 → 渲染进程，弹确认框） */
  PERMISSION_REQUEST: "agent:permission:request",
  /** 权限响应（渲染进程 → 主进程） */
  PERMISSION_RESPOND: "agent:permission:respond",
  /**
   * 权限已决（主进程 → 渲染进程）：超时自动 deny 与用户 respond 后都发，
   * 渲染层按 reqId 出队，避免 banner 卡死 / 按钮空操作。
   * payload: { reqId, sessionId, behavior, reason?: 'timeout'|'user', toolName? }
   */
  PERMISSION_RESOLVED: "agent:permission:resolved",
  /** 热切换指定会话的权限模式（运行中生效，不广播到其他会话） */
  UPDATE_SESSION_PERMISSION_MODE: "agent:update-session-permission-mode",
  /**
   * 热切换指定会话的 executionMode（Chat|Work）。
   * 仅接受 source=user | user-confirm-suggestion（ADR-0005）。
   */
  UPDATE_SESSION_EXECUTION_MODE: "agent:update-session-execution-mode",
  /**
   * 主进程 → 渲染：建议切换 Chat|Work（不改变 mode，等用户确认条）
   * @see docs/plans/multi-runtime/02-chat-work-and-permissions.md §3.4
   */
  EXECUTION_MODE_SUGGESTION: "agent:execution-mode-suggestion",
  /** 渲染 → 主进程：关闭建议条（不切换） */
  DISMISS_EXECUTION_MODE_SUGGESTION: "agent:dismiss-execution-mode-suggestion",

  // AskUserQuestion 交互式问答
  /** AskUser 请求（主进程 → 渲染进程，弹选项卡） */
  ASK_USER_REQUEST: "agent:ask-user:request",
  /** AskUser 响应（渲染进程 → 主进程） */
  ASK_USER_RESPOND: "agent:ask-user:respond",
  /** AskUser 用户关闭选项卡（渲染 → 主进程：软 deny「用户未选择」，不中断当前轮） */
  ASK_USER_DISMISS: "agent:ask-user:dismiss",
  /** AskUser 已决（主进程 → 渲染进程：用户 respond / dismiss / 会话清理，渲染层按 requestId 出队） */
  ASK_USER_RESOLVED: "agent:ask-user:resolved",

  // ExitPlanMode 计划审批
  /** ExitPlanMode 请求（主进程 → 渲染进程，弹审批横幅） */
  EXIT_PLAN_MODE_REQUEST: "agent:exit-plan-mode:request",
  /** ExitPlanMode 响应（渲染进程 → 主进程） */
  EXIT_PLAN_MODE_RESPOND: "agent:exit-plan-mode:respond",
  /** ExitPlanMode 已决（主进程 → 渲染进程：用户 respond / 会话清理，渲染层按 requestId 出队） */
  EXIT_PLAN_MODE_RESOLVED: "agent:exit-plan-mode:resolved",

  // 计划模式切换（主进程 → 渲染进程：EnterPlanMode 进入 / ExitPlanMode 审批后切换输入框 pill）
  /** 权限模式变更通知（主进程 → 渲染进程，更新输入框权限 pill；与 pill 手动切换同路径） */
  PLAN_MODE_CHANGED: "agent:plan-mode-changed",

  // 队列消息（Agent 运行中排队发送）
  /** 排队发送消息 */
  QUEUE_MESSAGE: "agent:queue-message",
  /** 取消队列消息 */
  CANCEL_QUEUED_MESSAGE: "agent:cancel-queued-message",
  /** 提升队列消息为立即发送 */
  PROMOTE_QUEUED_MESSAGE: "agent:promote-queued-message",
  /** 队列消息状态变更通知（主进程 → 渲染进程推送） */
  QUEUED_MESSAGE_STATUS: "agent:queued-message-status",

  // MoA 会诊预置
  /** 取全部 MoA 预置（seed 落盘后；缺失则就地 seed） */
  LIST_MOA_PRESETS: "agent:list-moa-presets",
  /**
   * 写整份 MoA 预置（覆盖式原子写）。
   * 入参 `MoAPreset[]`；主进程整单校验（`validateMoAPresetList`），
   * 非法则 reject 中文错、不写盘；合法则 `writeMoaPresets` 后再 `list` 回传。
   * 仅编辑 stored 预置；synthetic / channel-* 合成预置不进此通道。
   */
  SAVE_MOA_PRESETS: "agent:save-moa-presets",

  // CLI 工人配置（本机 coding CLI 子代理后端；第一期仅 kscc）
  /** 取 CLI 工人配置（无文件则就地 seed 默认：总开关 enabled=false，零行为变化） */
  LIST_CLI_WORKERS: "agent:list-cli-workers",
  /**
   * 保存整份 CLI 工人配置（覆盖式原子写）。
   * 入参 `CliWorkersConfig`（扁平 v1）；主进程整单校验（`validateCliWorkersConfig`），
   * 非法则 reject 中文错、不写盘；合法则 `writeCliWorkersConfig` 后再 `list` 回传。
   */
  SAVE_CLI_WORKERS: "agent:save-cli-workers",
  /**
   * 本机探测 CLI 工人是否在 PATH / 配置路径可用（每台机器环境不同）。
   * 入参可选 `CliWorkersConfig`（缺省则用当前落盘配置）；返回 `CliWorkersProbeResult`。
   */
  PROBE_CLI_WORKERS: "agent:probe-cli-workers",

  /** 读 No-Progress Guard 模式（env 覆盖后的有效值 + 落盘偏好） */
  GET_NO_PROGRESS_GUARD_MODE: "agent:get-no-progress-guard-mode",
  /** 写 No-Progress Guard 落盘偏好（env 仍可覆盖） */
  SET_NO_PROGRESS_GUARD_MODE: "agent:set-no-progress-guard-mode",

  // 圆桌（agent-discuss）偏好
  /** 读圆桌偏好（缺失/损坏 → 默认；见 agent-discuss-crew-prefs 契约） */
  GET_DISCUSS_PREFS: "agent:get-discuss-prefs",
  /**
   * 写圆桌偏好（整单校验，非法 reject 中文错、不写盘；合法则落盘后回读）。
   * 入参 `AgentDiscussPrefs`；本期部分字段运行时闸未接（见 FINDINGS）。
   */
  SET_DISCUSS_PREFS: "agent:set-discuss-prefs",

  // 班组（agent-crew）偏好
  /** 读班组偏好（缺失/损坏 → 默认；见 agent-discuss-crew-prefs 契约） */
  GET_CREW_PREFS: "agent:get-crew-prefs",
  /**
   * 写班组偏好（整单校验，非法 reject 中文错、不写盘；合法则落盘后回读）。
   * 入参 `AgentCrewPrefs`；本期部分字段运行时闸未接（见 FINDINGS）。
   */
  SET_CREW_PREFS: "agent:set-crew-prefs",

  // 待处理请求恢复（渲染进程重载后查询主进程状态）
  /** 获取所有待处理的交互请求快照 */
  GET_PENDING_REQUESTS: "agent:get-pending-requests",

  // TA MCP Server 管理
  /** 获取 TA MCP Server 状态 */
  GET_TA_MCP_STATUS: "agent:get-ta-mcp-status",
  /** 检查工作区是否配置了 TA MCP */
  IS_TA_MCP_CONFIGURED: "agent:is-ta-mcp-configured",
  /** 为工作区启用 TA MCP */
  ENABLE_TA_MCP: "agent:enable-ta-mcp",
  /** 为工作区禁用 TA MCP */
  DISABLE_TA_MCP: "agent:disable-ta-mcp",
  /** 一键安装 TA MCP Server（返回流式日志通过 TA_INSTALL_LOG 推送） */
  INSTALL_TA_MCP: "agent:install-ta-mcp",
  /** 取消正在进行的安装 */
  CANCEL_TA_MCP_INSTALL: "agent:cancel-ta-mcp-install",
  /** 获取当前安装状态 */
  GET_TA_INSTALL_PROGRESS: "agent:get-ta-install-progress",
  /** 安装日志推流通道（webContents.send） */
  TA_INSTALL_LOG: "agent:ta-install-log",

  // ModeManager 模式管理
  /** 获取模式状态摘要 */
  GET_MODE_STATUS: "agent:get-mode-status",
  /** 切换模式 */
  SWITCH_MODE: "agent:switch-mode",
  /** 注册后台任务 */
  REGISTER_BACKGROUND_TASK: "agent:register-background-task",
  /** 完成后台任务 */
  COMPLETE_BACKGROUND_TASK: "agent:complete-background-task",
  /** 模式变化通知（主进程 → 渲染进程推送） */
  MODE_CHANGED: "agent:mode-changed",
  /** 任务完成通知（主进程 → 渲染进程推送） */
  TASK_NOTIFICATION: "agent:task-notification",

  // kscc 内网渠道
  /** 检测 kscc 安装就绪状态 */
  CHECK_KSCC_READINESS: "agent:check-kscc-readiness",
  /** 获取 kscc 状态（已配置+内网+已安装+模型列表） */
  GET_KSCC_STATUS: "agent:get-kscc-status",
  /** 刷新 kscc 状态（清缓存重检） */
  REFRESH_KSCC_STATUS: "agent:refresh-kscc-status",

  // 资产库管理（TA 模式）
  /** 初始化资产库服务 */
  INIT_ASSET_STORE: "agent:init-asset-store",
  /** 创建资产库数据库（如果不存在） */
  CREATE_ASSET_STORE_DATABASE: "agent:create-asset-store-database",
  /** 获取资产库状态 */
  GET_ASSET_STORE_STATUS: "agent:get-asset-store-status",
  /** 列出资产 */
  LIST_ASSETS: "agent:list-assets",
  /** 搜索资产 */
  SEARCH_ASSETS: "agent:search-assets",
  /** 获取资产详情 */
  GET_ASSET_DETAIL: "agent:get-asset-detail",
  /** 获取资产库统计 */
  GET_ASSET_STORE_STATS: "agent:get-asset-store-stats",
  /** 获取项目列表 */
  LIST_PROJECTS: "agent:list-projects",

  // 审核队列（TA 模式）
  /** 获取审核队列 */
  GET_REVIEW_QUEUE: "agent:get-review-queue",
  /** 获取审核统计 */
  GET_REVIEW_STATS: "agent:get-review-stats",

  // 记忆层管理（通用 + TA 模式）
  /** 初始化记忆层服务 */
  INIT_MEMORY_LAYERS: "agent:init-memory-layers",
  /** 获取记忆层统计 */
  GET_MEMORY_STATS: "agent:get-memory-stats",
  /** 搜索 L4 会话 */
  SEARCH_MEMORY_SESSIONS: "agent:search-memory-sessions",
  /** 列出最近的 L4 会话 */
  LIST_RECENT_MEMORY_SESSIONS: "agent:list-recent-memory-sessions",
  /** 获取 Markdown 层内容 */
  GET_MEMORY_MD_CONTENT: "agent:get-memory-md-content",
  /** 获取 L3 纠错记录 */
  GET_MEMORY_CORRECTIONS: "agent:get-memory-corrections",
} as const;

/** CSV 看板相关 IPC */
export const CSV_IPC_CHANNELS = {
  /** 确保 session 的 live 查询服务在跑（刷新/重启后恢复预览） */
  ENSURE_LIVE_SERVER: "csv:ensure-live-server",
} as const;

/** csv:ensure-live-server 返回值 */
export interface EnsureCsvLiveServerResult {
  ok: boolean;
  url: string;
  port: number;
  /** 实际使用的 CSV cache sessionId（URL 反查时有用） */
  sessionId?: string;
  error?: string;
}

/**
 * P1-3: 客户端压缩会话的输入参数
 */
export interface CompactSessionInput {
  /** 压缩策略 */
  strategy: "drop_old_tool_results" | "keep_last_n" | "summarize";
  /** keep_last_n 策略专用：保留最近 N 条 */
  keepLastN?: number;
}

/**
 * P1-3: 客户端压缩会话的结果
 */
export interface CompactSessionResult {
  /** 是否成功 */
  success: boolean;
  /** 压缩前消息数 */
  beforeCount: number;
  /** 压缩后消息数 */
  afterCount: number;
  /** 删了多少条 */
  droppedCount: number;
  /** 简要说明 */
  message: string;
}

/**
 * 待处理交互请求快照（用于渲染进程重载后恢复状态）
 */
export interface PendingRequestsSnapshot {
  /** 待处理的权限请求 */
  permissions: PermissionRequest[];
  /** 待处理的 AskUser 请求 */
  askUsers: AskUserRequest[];
  /** 待处理的 ExitPlanMode 请求 */
  exitPlans: ExitPlanModeRequest[];
}

// ===== kscc 内网渠道安装引导 =====

/** kscc 安装步骤 */
export interface KsccInstallStep {
  id: string;
  label: string;
  /** 可复制到剪贴板的命令 */
  command?: string;
  /** 可打开的外部链接 */
  link?: string;
  /** 是否可选步骤 */
  optional?: boolean;
  /** 检测时已满足 */
  done?: boolean;
}

/** kscc 安装就绪检测结果 */
export interface KsccInstallReadiness {
  /** Node.js 环境检测 */
  nodeJs: { installed: boolean; version?: string; meetsMinimum: boolean };
  /** Git 环境检测 */
  git: { installed: boolean; version?: string };
  /** kscc CLI 检测 */
  kscc: { installed: boolean; path?: string; version?: string };
  /** 运行平台 */
  platform:
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";
  /** 动态安装步骤 */
  installSteps: KsccInstallStep[];
}
