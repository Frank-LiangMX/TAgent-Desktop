/**
 * ExitPlanMode 计划审批队列（Jotai）—— per-session FIFO
 *
 * 对齐 ask-user-atoms / permission-atoms：全局存活的 Map atom，切会话/切预览 Tab 不丢 pending。
 * ExitPlanModeBanner 读 allPendingExitPlanRequestsAtom.get(sessionId) 取队首 + (+N)。
 *
 * 写入路径：
 * - useExitPlanSync：EXIT_PLAN_MODE_REQUEST 入队 / EXIT_PLAN_MODE_RESOLVED 按 requestId 出队
 * - ExitPlanModeBanner：submit 乐观出队；dismiss（X）清整会话队列 + stopAgent
 *
 * 移植自 TAgent_General agent-atoms.ts（exit-plan 段）。
 */
import { atom } from 'jotai'
import type { ExitPlanModeRequest } from '@tagent/shared'

/** 待处理的 ExitPlanMode 请求 Map — 以 sessionId 为 key，切换会话时保留状态 */
export const allPendingExitPlanRequestsAtom = atom<Map<string, readonly ExitPlanModeRequest[]>>(
  new Map(),
)

/**
 * 当前处于 Plan 模式的会话 ID 集合。
 * 与用户选择的权限模式分离：标记「Agent 正在规划」态（spec §2.1.4 可选文案用）。
 * 由 Chat.tsx 在 PLAN_MODE_CHANGED 时经 updatePlanModeSessionSet 维护。
 */
export const agentPlanModeSessionsAtom = atom<Set<string>>(new Set<string>())
