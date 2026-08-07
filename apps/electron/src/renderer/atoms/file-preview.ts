/**
 * 文件预览请求：FileChip 点击 → dock 右侧分屏开预览 pane。
 * 全局单例（同时只有一个活跃请求），pane 按 sessionId 匹配自己的会话。
 */
import { atom } from 'jotai'

export interface FilePreviewRequest {
  sessionId: string
  /** 文件路径（相对或绝对；优先已 resolve 的绝对路径） */
  path: string
  /** 显示标题（未传则取文件名） */
  title?: string
  /** 解析相对路径时的候选根（工作区目录等） */
  bases?: string[]
}

export const filePreviewRequestAtom = atom<FilePreviewRequest | null>(null)
