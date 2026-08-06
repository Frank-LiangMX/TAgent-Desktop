/**
 * 消息内富块 → 应用层分屏预览（Chat 注入；MermaidBlock / RichFrame 等消费）。
 * 与 MessageFilePathContext 同模式，避免 ui 包依赖 electron dock。
 */
import * as React from 'react'

/** 可进分屏的富块种类（与 electron rich-preview atom 对齐） */
export type RichPreviewKind =
  | 'mermaid'
  | 'datatable'
  | 'spreadsheet'
  | 'json'
  | 'diff'
  | 'math'
  | 'html-preview'
  | 'markdown-preview'
  | 'image-preview'
  | 'pdf-preview'

export interface OpenRichInSplitPayload {
  kind: RichPreviewKind
  code: string
  title?: string
}

export interface MessageRichPreviewContextValue {
  /** 通用：在分屏工作台打开富块独立标签 */
  openRichInSplit?: (payload: OpenRichInSplitPayload) => void
  /** @deprecated 用 openRichInSplit；保留兼容 Mermaid 旧调用 */
  openMermaidInSplit?: (code: string, title?: string) => void
}

export const MessageRichPreviewContext = React.createContext<MessageRichPreviewContextValue>({})
export const MessageRichPreviewProvider = MessageRichPreviewContext.Provider
