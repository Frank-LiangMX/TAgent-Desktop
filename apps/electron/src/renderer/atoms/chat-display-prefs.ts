/**
 * 对话展示偏好（Jotai + localStorage）
 *
 * 过程区展示模式：完整思考链 vs Cursor 风格一行摘要。
 * 入口在模型选择器（与思考强度同区）；只影响 ProcessGroupView，不改流式管线。
 */
import { atomWithStorage, type RESET } from 'jotai/utils'

/** 过程区展示模式 */
export type ChatProcessDisplayMode = 'full' | 'concise'

/**
 * full — live 自动展开思考全文 + 工具行（默认，零回归）
 * concise — 默认收起一行摘要，点开再看完整过程（对齐 Cursor）
 */
export const chatProcessDisplayModeAtom = atomWithStorage<ChatProcessDisplayMode>(
  'tagent:chatProcessDisplayMode',
  'full',
)

export type { RESET }
