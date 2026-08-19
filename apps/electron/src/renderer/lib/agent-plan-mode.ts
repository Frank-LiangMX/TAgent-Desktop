import type { AgentPlanModeChangeSource } from '@tagent/shared'

export interface PlanModeChange {
  active: boolean
  source: AgentPlanModeChangeSource
}

/**
 * 从 SDK 工具名解析计划阶段变化。
 *
 * 注意：ExitPlanMode 只是发起退出计划的审批请求，不能在工具开始时视为已退出。
 * 真正退出由主进程在用户批准后发送 PLAN_MODE_CHANGED（mode=目标模式）。
 *
 * 移植自 TAgent_General renderer/lib/agent-plan-mode.ts。
 * Desktop 主进程驱动：EnterPlanMode 由 canUseTool 切 plan + 推 PLAN_MODE_CHANGED，
 * 故本函数当前供未来「从原始 tool 事件派生 plan 态」的场景使用。
 */
export function getPlanModeChangeFromToolName(toolName: string): PlanModeChange | null {
  if (toolName === 'EnterPlanMode') {
    return { active: true, source: 'tool' }
  }
  return null
}

/** 更新计划阶段会话集合；无变化时复用原 Set，减少 Jotai 下游刷新。 */
export function updatePlanModeSessionSet(
  prev: Set<string>,
  sessionId: string,
  active: boolean,
): Set<string> {
  if (active) {
    if (prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.add(sessionId)
    return next
  }

  if (!prev.has(sessionId)) return prev
  const next = new Set(prev)
  next.delete(sessionId)
  return next
}
