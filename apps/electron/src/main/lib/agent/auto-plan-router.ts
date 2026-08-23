import type { ExecutionMode } from '@tagent/shared'

export interface AutoPlanDecision {
  shouldPlan: boolean
  reason: 'explicit_plan' | 'multi_phase' | 'multiple_stages' | 'direct'
  signals: number
}

const INVESTIGATE_RE = /调查|分析|梳理|查找|搜索|阅读|确认|理解|定位|审计|排查|调研/i
const CHANGE_RE = /实现|修改|新增|重构|修复|改造|编写|接入|迁移|配置|替换|优化/i
const VERIFY_RE = /测试|验证|编译|构建|打包|检查|回归|运行用例|确认结果/i
const DELIVERY_RE = /部署|发布|文档|提交|交付|上线/i
const EXPLICIT_PLAN_RE = /计划|步骤|分阶段|阶段性|里程碑|拆解|工作流|先.+(?:然后|再|接着).+(?:最后|之后)/is

function countDistinctSignals(prompt: string): number {
  return [INVESTIGATE_RE, CHANGE_RE, VERIFY_RE, DELIVERY_RE].filter((re) => re.test(prompt)).length
}

function countListItems(prompt: string): number {
  return (prompt.match(/^\s*(?:\d+[.)]|[-*])\s+/gm) ?? []).length
}

/**
 * 只做保守的本地路由提示，不代替模型拆计划，也不改变权限模式。
 * 目的：让明显的多阶段任务稳定触发 EnterPlanMode，避免完全依赖模型临场记忆。
 */
export function assessAutoPlan(prompt: string, mode: ExecutionMode, isSteer = false): AutoPlanDecision {
  if (mode !== 'work' || isSteer) return { shouldPlan: false, reason: 'direct', signals: 0 }

  const text = prompt.trim().slice(0, 12_000)
  if (!text) return { shouldPlan: false, reason: 'direct', signals: 0 }

  const signals = countDistinctSignals(text)
  const listItems = countListItems(text)
  if (EXPLICIT_PLAN_RE.test(text) && (signals >= 2 || listItems >= 2)) {
    return { shouldPlan: true, reason: 'explicit_plan', signals }
  }
  if (listItems >= 3 || signals >= 3) {
    return { shouldPlan: true, reason: 'multiple_stages', signals }
  }
  if (signals >= 2 && text.length >= 48) {
    return { shouldPlan: true, reason: 'multi_phase', signals }
  }
  return { shouldPlan: false, reason: 'direct', signals }
}

export function buildAutoPlanPrompt(prompt: string, mode: ExecutionMode, isSteer = false): string {
  const decision = assessAutoPlan(prompt, mode, isSteer)
  if (!decision.shouldPlan) return ''

  return `## 本轮自动阶段编排

调度器根据用户本轮请求检测到这是一个多阶段任务（${decision.reason}，${decision.signals} 类工作信号）。
请先调用 \`EnterPlanMode\`，把本轮工作整理成 3–8 个可验收步骤；然后调用 \`ExitPlanMode\` 交给 TAgent 的计划审批 UI。审批通过后按步骤执行，并在每个阶段完成时用一句短进度说明同步当前阶段。
阶段状态必须同时用隐藏标记同步：开始第 N 步输出 \`<!-- tagent-plan-step: N running -->\`，完成输出 \`<!-- tagent-plan-step: N completed -->\`，失败输出 \`<!-- tagent-plan-step: N failed -->\`，等待用户或外部回调输出 \`<!-- tagent-plan-step: N paused -->\`。每个标记单独成行；这是 TAgent 内部状态协议，HTML 注释不会展示给用户。
不要为了凑步骤拆分简单动作，也不要在计划审批前进行不可逆的写入。若当前上下文已经存在用户批准的计划，直接沿用并推进，不要重复进入计划模式。`
}
