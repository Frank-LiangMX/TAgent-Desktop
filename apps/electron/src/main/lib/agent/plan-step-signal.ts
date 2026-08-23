export type PlanStepSignalStatus = 'running' | 'completed' | 'failed' | 'paused'

export interface PlanStepSignal {
  step: number
  status: PlanStepSignalStatus
}

const PLAN_STEP_SIGNAL_RE =
  /<!--\s*tagent-plan-step:\s*(\d+)\s+(running|completed|failed|paused)\s*-->/gi

/** 从 assistant 文本中提取隐藏的结构化阶段信号。 */
export function parsePlanStepSignals(text: string): PlanStepSignal[] {
  const signals: PlanStepSignal[] = []
  PLAN_STEP_SIGNAL_RE.lastIndex = 0
  for (const match of text.matchAll(PLAN_STEP_SIGNAL_RE)) {
    const step = Number(match[1])
    const status = match[2]?.toLowerCase() as PlanStepSignalStatus | undefined
    if (Number.isInteger(step) && step > 0 && status) signals.push({ step, status })
  }
  return signals
}

/** 兼容 SDKMessage 和 TAgentMessage 两种 assistant 内容形态。 */
export function extractPlanStepSignals(message: unknown): PlanStepSignal[] {
  const value = message as {
    type?: string
    content?: unknown
    message?: { content?: unknown }
  }
  if (value?.type !== 'assistant') return []
  const content = value.content ?? value.message?.content
  if (!Array.isArray(content)) return []
  const text = content
    .map((block) => {
      const item = block as { type?: string; text?: unknown }
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('')
  return parsePlanStepSignals(text)
}
