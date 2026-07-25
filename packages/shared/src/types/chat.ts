/**
 * Chat 相关类型定义
 *
 * 包含消息、对话等核心类型，
 * 以及 Chat 模块的 IPC 通道常量。
 */

import type { ProviderType } from './channel'

// ===== 附件相关 =====

/** 附件文件大小上限：100MB */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

/** 文件附件 */
export interface FileAttachment {
  /** 附件唯一标识 */
  id: string
  /** 原始文件名 */
  filename: string
  /** MIME 类型 */
  mediaType: string
  /** 相对路径: {conversationId}/{uuid}.ext */
  localPath: string
  /** 文件大小（字节） */
  size: number
}

/** 保存附件输入 */
export interface AttachmentSaveInput {
  /** 对话 ID */
  conversationId: string
  /** 原始文件名 */
  filename: string
  /** MIME 类型 */
  mediaType: string
  /** base64 编码的文件数据 */
  data: string
}

/** 保存附件结果 */
export interface AttachmentSaveResult {
  /** 保存后的附件信息 */
  attachment: FileAttachment
}

/** 文件选择对话框结果 */
export interface FileDialogResult {
  /** 已读取为 base64 的小文件列表 */
  files: FileDialogFile[]
  /** 超过内存导入上限的大文件，仅返回路径，供 Agent 作为附加文件引用 */
  largeFiles?: FileDialogLargeFile[]
  /** 无法读取或无法识别的文件 */
  skippedFiles?: FileDialogSkippedFile[]
}

export interface FileDialogFile {
  filename: string
  mediaType: string
  data: string
  size: number
}

export interface FileDialogLargeFile {
  filename: string
  mediaType: string
  size: number
  path: string
}

export interface FileDialogSkippedFile {
  filename: string
  mediaType?: string
  size?: number
  path?: string
  reason: 'unreadable'
  message?: string
}

// ===== 消息相关 =====

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * 聊天消息
 */
export interface ChatMessage {
  /** 消息唯一标识 */
  id: string
  /** 发送者角色 */
  role: MessageRole
  /** 消息内容 */
  content: string
  /** 创建时间戳 */
  createdAt: number
  /** 使用的模型 ID（assistant 消息） */
  model?: string
  /** 推理内容（如果模型支持） */
  reasoning?: string
  /** 是否被用户中止 */
  stopped?: boolean
  /** 流式生成时遇到的错误信息 */
  error?: string
  /** 文件附件列表 */
  attachments?: FileAttachment[]
  /** 工具活动记录（assistant 消息，工具调用历史） */
  toolActivities?: ChatToolActivity[]
}

// ===== Chat 工具活动 =====

/**
 * Chat 工具活动（记忆工具调用状态）
 */
export interface ChatToolActivity {
  /** 工具调用 ID */
  toolCallId: string
  /** 工具名称 */
  toolName: string
  /** 活动类型：开始 / 结果 */
  type: 'start' | 'result'
  /** 执行结果（仅 result 时存在） */
  result?: string
  /** 是否遇到错误 */
  isError?: boolean
  /** 工具调用参数（result 事件中携带，用于语义化短语和结构化结果渲染） */
  input?: Record<string, unknown>
}

// ===== 对话相关 =====

/**
 * 对话（包含消息列表，仅用于运行时）
 */
export interface Conversation {
  /** 对话唯一标识 */
  id: string
  /** 对话标题 */
  title: string
  /** 消息列表 */
  messages: ChatMessage[]
  /** 默认使用的模型 ID */
  modelId?: string
  /** 系统提示词 */
  systemMessage?: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/**
 * 对话轻量索引项
 *
 * 存储在 ~/.tagent/conversations.json 中，
 * 不包含消息列表，用于快速加载对话列表。
 */
export interface ConversationMeta {
  /** 对话唯一标识 */
  id: string
  /** 对话标题 */
  title: string
  /** 默认使用的模型 ID */
  modelId?: string
  /** 使用的渠道 ID */
  channelId?: string
  /** 上下文分隔线对应的消息 ID 列表 */
  contextDividers?: string[]
  /** 上下文长度（轮数），'infinite' 表示全部包含 */
  contextLength?: number | 'infinite'
  /** 是否置顶 */
  pinned?: boolean
  /** 是否已归档 */
  archived?: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

// ===== 消息搜索 =====

/**
 * 消息搜索结果
 */
export interface MessageSearchResult {
  /** 对话 ID */
  conversationId: string
  /** 对话标题 */
  conversationTitle: string
  /** 消息 ID */
  messageId: string
  /** 消息角色 */
  role: MessageRole
  /** 匹配上下文片段（约 80 字符） */
  snippet: string
  /** snippet 内匹配起始位置 */
  matchStart: number
  /** 匹配长度 */
  matchLength: number
  /** 是否已归档 */
  archived?: boolean
}

// ===== 模型选项 =====

/**
 * 模型选项（扁平化的渠道+模型组合）
 *
 * 用于渲染进程的模型选择器下拉列表
 */
export interface ModelOption {
  /** 渠道 ID */
  channelId: string
  /** 渠道名称 */
  channelName: string
  /** 模型 ID */
  modelId: string
  /** 模型显示名称 */
  modelName: string
  /** AI 供应商类型 */
  provider: ProviderType
  /** 该模型选项是否被禁用（灰显） */
  disabled?: boolean
  /** 禁用原因（显示为 tooltip） */
  disabledReason?: string
  /** 标签（如"公司免费"） */
  badge?: string
}

// ===== 分页加载相关 =====

/**
 * 最近消息加载结果
 *
 * 用于分页加载：首次仅加载尾部 N 条消息，
 * 向上滚动时再加载全部。
 */
export interface RecentMessagesResult {
  /** 本次返回的消息列表（按时间正序） */
  messages: ChatMessage[]
  /** 对话中的总消息数 */
  total: number
  /** 是否还有更多历史消息 */
  hasMore: boolean
}

// ===== IPC 通道常量 =====

/**
 * Chat 相关 IPC 通道常量
 */
export const CHAT_IPC_CHANNELS = {
  /** 获取对话列表 */
  LIST_CONVERSATIONS: 'chat:list-conversations',
  /** 删除对话 */
  DELETE_CONVERSATION: 'chat:delete-conversation',
  /** 读取附件（返回 base64） */
  READ_ATTACHMENT: 'chat:read-attachment',
  /** 另存图片到用户选择的位置（原生 Save As 对话框） */
  SAVE_IMAGE_AS: 'chat:save-image-as',
  /** 打开文件选择对话框 */
  OPEN_FILE_DIALOG: 'chat:open-file-dialog',
} as const
