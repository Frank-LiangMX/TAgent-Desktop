/**
 * 富内容分屏预览请求：块上「分屏」→ dock 右侧独立标签。
 * 与 filePreviewRequestAtom 同模式：全局单例，pane 按 sessionId 匹配。
 */
import { atom } from 'jotai'
import type { RichPreviewKind } from '@tagent/ui'

export type { RichPreviewKind }

export interface RichPreviewRequest {
  sessionId: string
  kind: RichPreviewKind
  /** 围栏源码 / JSON spec */
  code: string
  title?: string
}

export const richPreviewRequestAtom = atom<RichPreviewRequest | null>(null)
