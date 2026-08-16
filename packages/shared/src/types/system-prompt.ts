/**
 * 系统提示词类型定义
 *
 * 管理 Chat 模式的系统提示词（system prompt），
 * 包括内置默认提示词和用户自定义提示词。
 */

/** 系统提示词 */
export interface SystemPrompt {
  /** 唯一标识 */
  id: string
  /** 提示词名称 */
  name: string
  /** 提示词内容 */
  content: string
  /** 是否为内置提示词（不可编辑/删除） */
  isBuiltin: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 系统提示词配置（存储在 ~/.tagent/system-prompts.json） */
export interface SystemPromptConfig {
  /** 提示词列表 */
  prompts: SystemPrompt[]
  /** 默认提示词 ID（新建对话时自动选中） */
  defaultPromptId?: string
  /** 是否追加日期时间和用户名到提示词末尾 */
  appendDateTimeAndUserName: boolean
}

/** 创建提示词输入 */
export interface SystemPromptCreateInput {
  name: string
  content: string
}

/** 更新提示词输入 */
export interface SystemPromptUpdateInput {
  name?: string
  content?: string
}

/** 内置默认提示词 ID */
export const BUILTIN_DEFAULT_ID = 'builtin-default'

/** TAgent 内置默认提示词内容 */
export const BUILTIN_DEFAULT_PROMPT_STRING = `你是 TAgent 的 AI 助手，帮我解决实际问题。

- 简洁直接：先给结论/建议，细节点到为止，别长篇铺垫
- 看人下菜碟：新手多解释，熟手直接上
- 需求或方案不清时，先用提问让我在选项里选，别替我拍板
- 我的方案可能踩坑、或有明显更好的做法时，简短提醒一句，不多啰嗦
- 主动引导我使用合适的协作方式与工具（具体可用的能力见模式说明，以你当前实际信息为准）

默认中文，保留必要英文术语；用户切英文可英文回复。
`

/** TAgent 内置默认提示词 */
export const BUILTIN_DEFAULT_PROMPT: SystemPrompt = {
  id: BUILTIN_DEFAULT_ID,
  name: 'TAgent 内置提示词',
  content: BUILTIN_DEFAULT_PROMPT_STRING,
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0,
}

/** 系统提示词 IPC 通道常量 */
export const SYSTEM_PROMPT_IPC_CHANNELS = {
  /** 获取完整配置 */
  GET_CONFIG: 'system-prompt:get-config',
  /** 创建提示词 */
  CREATE: 'system-prompt:create',
  /** 更新提示词 */
  UPDATE: 'system-prompt:update',
  /** 删除提示词 */
  DELETE: 'system-prompt:delete',
  /** 更新追加日期时间和用户名开关 */
  UPDATE_APPEND_SETTING: 'system-prompt:update-append-setting',
  /** 设置默认提示词 */
  SET_DEFAULT: 'system-prompt:set-default',
} as const

/** SOUL.md 人格定义 IPC 通道常量 */
export const SOUL_IPC_CHANNELS = {
  /** 获取 SOUL.md 内容 */
  GET_CONTENT: 'soul:get-content',
  /** 保存 SOUL.md 内容 */
  SAVE_CONTENT: 'soul:save-content',
  /** 重置为默认内容 */
  RESET_DEFAULT: 'soul:reset-default',
} as const
