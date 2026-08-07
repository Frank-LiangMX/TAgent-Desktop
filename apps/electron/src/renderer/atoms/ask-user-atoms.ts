/**
 * AskUserQuestion 交互式问答队列（Jotai）—— per-session FIFO
 *
 * 对齐 permission-atoms：全局存活的 Map atom，切会话/切预览 Tab 不丢 pending 与 drafts。
 * AskUserQuestionBanner 读 allPendingAskUserRequestsAtom.get(sessionId) 取队首 + (+N)。
 *
 * 写入路径：
 * - useAskUserSync：ASK_USER_REQUEST 入队 / ASK_USER_RESOLVED 按 requestId 出队 + 清 drafts
 * - AskUserQuestionBanner：submit 乐观出队 + drafts 清理；dismiss 清整会话队列
 *
 * 移植自 TAgent_General agent-atoms.ts（ask-user 段），见 REGRESS-H-GENERAL-PORT-FINDINGS。
 */
import { atom } from 'jotai'
import type { AskUserRequest } from '@tagent/shared'

/** 待处理的 AskUser 请求 Map — 以 sessionId 为 key，切换会话时保留状态 */
export const allPendingAskUserRequestsAtom = atom<Map<string, readonly AskUserRequest[]>>(
  new Map()
)

/** AskUser 单题答案草稿 */
export interface AskUserQuestionDraft {
  selected: string[]
  customText: string
  showCustom: boolean
}

/** AskUser 请求级草稿 — 以 requestId 为 key，组件卸载后仍保留 */
export interface AskUserRequestDraft {
  activeTab: number
  focusedOptIdx: number
  answers: Map<number, AskUserQuestionDraft>
}

/** 待提交 AskUser 草稿 Map — 以 requestId 为 key，切换预览/会话时保留填写进度 */
export const askUserDraftsAtom = atom<Map<string, AskUserRequestDraft>>(new Map())
