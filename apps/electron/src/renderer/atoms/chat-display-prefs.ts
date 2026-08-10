/**
 * 对话展示偏好（Jotai + localStorage）
 *
 * 过程区展示模式：完整思考链 vs Cursor 风格一行摘要。
 * 入口在模型选择器（与思考强度同区）；只影响 ProcessGroupView，不改流式管线。
 */
import { atomWithStorage, type RESET } from 'jotai/utils'

/** 过程区展示模式 */
export type ChatProcessDisplayMode = 'full' | 'concise'

/** 全部可选模式；完整仍可手动选择，不隐藏/删除 */
export const CHAT_PROCESS_DISPLAY_MODES = ['concise', 'full'] as const

/**
 * 无显式选择 / 旧配置缺失时的默认展示模式。
 * 设为「简洁」：默认收起一行摘要、点开再看完整过程（对齐 Cursor）。
 * 已显式保存为「完整」的偏好由 localStorage 持久化值保留，不被此默认覆盖。
 */
export const DEFAULT_CHAT_PROCESS_DISPLAY_MODE: ChatProcessDisplayMode = 'concise'

/**
 * localStorage 持久化 key。勿改：改名会让已保存偏好的老用户读不到旧值、
 * 回退到默认，等于静默丢弃其显式选择。
 */
export const CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY = 'tagent:chatProcessDisplayMode'

/**
 * full — live 自动展开思考全文 + 工具行
 * concise — 默认收起一行摘要，点开再看完整过程（对齐 Cursor）
 * 默认 concise；atomWithStorage 读取时存储值优先于默认，故显式选过完整的用户保持完整。
 */
export const chatProcessDisplayModeAtom = atomWithStorage<ChatProcessDisplayMode>(
  CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY,
  DEFAULT_CHAT_PROCESS_DISPLAY_MODE,
)

export type { RESET }
