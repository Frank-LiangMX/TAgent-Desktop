/**
 * 文件预览请求：FileChip 点击 → dock 右侧分屏开预览 pane。
 * 全局单例（同时只有一个活跃请求），pane 按 sessionId 匹配自己的会话。
 */
import { atom } from 'jotai'
import type { FileReviewContext } from '@tagent/shared'

export interface FilePreviewRequest {
  sessionId: string
  /** 文件路径（相对或绝对；优先已 resolve 的绝对路径） */
  path: string
  /** 显示标题（未传则取文件名） */
  title?: string
  /** 解析相对路径时的候选根（工作区目录等） */
  bases?: string[]
  /** 会话附件相对路径（~/.tagent/attachments/ 下）；设置后走 readAttachment 而非工作区读文件 */
  attachmentLocalPath?: string
  /** 附件 MIME（attachment 模式渲染分发用） */
  attachmentMediaType?: string
  /** 输入框待发附件（尚未落盘）：直接用内存 base64 预览 */
  pendingAttachment?: {
    filename: string
    mediaType: string
    data: string
  }
  /**
   * 「本轮 Files Changed」审阅上下文（仅句尾卡片打开时分屏走 diff 审阅）。
   * 正文文件 chip 不传 → 仍只预览当前文件。FilePreviewPane 据 patches 还原旧稿 + 算 unified diff。
   */
  review?: FileReviewContext
}

export const filePreviewRequestAtom = atom<FilePreviewRequest | null>(null)
