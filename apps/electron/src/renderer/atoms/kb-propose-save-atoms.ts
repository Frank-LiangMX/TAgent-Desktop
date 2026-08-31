/**
 * 知识库受控写入（kb_propose_save）确认队列（Jotai）—— per-session FIFO
 *
 * 对齐 exit-plan-atoms / ask-user-atoms：全局存活的 Map atom，切会话/切预览 Tab 不丢 pending。
 * KbProposeSaveBanner 读 allPendingKbProposeSaveRequestsAtom.get(sessionId) 取队首 + (+N)。
 *
 * 写入路径：
 * - useKbProposeSaveSync：KB_PROPOSE_SAVE_REQUEST 入队 / KB_PROPOSE_SAVE_RESOLVED 按 requestId 出队
 * - KbProposeSaveBanner：submit 乐观出队；dismiss（X）清整会话队列 + stopAgent
 *
 * 见 docs/dev/knowledge-base/KB-P1-5-CONTROLLED-WRITE-brief.md §D。
 */
import { atom } from "jotai";
import type { KbProposeSaveRequest } from "@tagent/shared";

/** 待处理的 kb_propose_save 请求 Map — 以 sessionId 为 key，切换会话时保留状态 */
export const allPendingKbProposeSaveRequestsAtom = atom<
  Map<string, readonly KbProposeSaveRequest[]>
>(new Map());
