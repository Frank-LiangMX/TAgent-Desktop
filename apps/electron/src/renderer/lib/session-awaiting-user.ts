/**
 * 会话是否在等用户点选（AskUser / 权限 / 退出计划 / 知识库写入确认）。
 * 这些弹窗不是一轮结束：不得 completeRun / 看门狗硬清，提交后计时从原 startedAt 续。
 */
import { getDefaultStore } from 'jotai'
import { allPendingAskUserRequestsAtom } from '../atoms/ask-user-atoms'
import { pendingPermissionMapAtom } from '../atoms/permission-atoms'
import { allPendingExitPlanRequestsAtom } from '../atoms/exit-plan-atoms'
import { allPendingKbProposeSaveRequestsAtom } from '../atoms/kb-propose-save-atoms'

export function isSessionAwaitingUser(sessionId: string): boolean {
  const store = getDefaultStore()
  if ((store.get(allPendingAskUserRequestsAtom).get(sessionId)?.length ?? 0) > 0) return true
  if ((store.get(pendingPermissionMapAtom)[sessionId]?.length ?? 0) > 0) return true
  if ((store.get(allPendingExitPlanRequestsAtom).get(sessionId)?.length ?? 0) > 0) return true
  if ((store.get(allPendingKbProposeSaveRequestsAtom).get(sessionId)?.length ?? 0) > 0) return true
  return false
}
