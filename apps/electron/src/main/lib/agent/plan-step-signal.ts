export type PlanStepSignalStatus = 'running' | 'completed' | 'failed' | 'paused'

export interface PlanStepSignal {
  step: number
  status: PlanStepSignalStatus
}

/** 隐藏 HTML 注释协议（首选） */
const PLAN_STEP_HTML_RE =
  /<!--\s*tagent-plan-step:\s*(\d+)\s+(running|completed|failed|paused)\s*-->/gi

/**
 * 明文兜底：模型常丢掉 HTML 注释，但仍会写
 * `[tagent-plan-step: 2 completed]` / `tagent-plan-step: 2 running`
 * 或「第 2 步：完成」「Step 3 done」。
 */
const PLAN_STEP_PLAIN_RE =
  /(?:\[?\s*tagent-plan-step\s*:\s*(\d+)\s+(running|completed|failed|paused)\s*\]?|(?:第\s*(\d+)\s*步|步骤\s*(\d+)|Step\s*(\d+))\s*[:：]?\s*(完成|已完成|做完|失败|暂停|开始|进行中|done|completed|failed|paused|running|started))/gi

function statusFromPlainWord(raw: string | undefined): PlanStepSignalStatus | null {
  if (!raw) return null
  const w = raw.toLowerCase()
  if (w === 'completed' || w === 'done' || w === '完成' || w === '已完成' || w === '做完') {
    return 'completed'
  }
  if (w === 'failed' || w === '失败') return 'failed'
  if (w === 'paused' || w === '暂停') return 'paused'
  if (
    w === 'running' ||
    w === 'started' ||
    w === '开始' ||
    w === '进行中'
  ) {
    return 'running'
  }
  return null
}

/** 从 assistant 文本中提取结构化阶段信号（HTML 注释 + 明文兜底）。 */
export function parsePlanStepSignals(text: string): PlanStepSignal[] {
  const signals: PlanStepSignal[] = []
  const seen = new Set<string>()

  const push = (step: number, status: PlanStepSignalStatus): void => {
    if (!Number.isInteger(step) || step < 1) return
    const key = `${step}:${status}`
    if (seen.has(key)) return
    seen.add(key)
    signals.push({ step, status })
  }

  PLAN_STEP_HTML_RE.lastIndex = 0
  for (const match of text.matchAll(PLAN_STEP_HTML_RE)) {
    const step = Number(match[1])
    const status = match[2]?.toLowerCase() as PlanStepSignalStatus | undefined
    if (status) push(step, status)
  }

  PLAN_STEP_PLAIN_RE.lastIndex = 0
  for (const match of text.matchAll(PLAN_STEP_PLAIN_RE)) {
    if (match[1] && match[2]) {
      const status = match[2].toLowerCase() as PlanStepSignalStatus
      push(Number(match[1]), status)
      continue
    }
    const step = Number(match[3] || match[4] || match[5])
    const status = statusFromPlainWord(match[6])
    if (status) push(step, status)
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

/** 抽出 assistant 纯文本，供渲染层做步骤标题匹配。 */
export function extractAssistantPlainText(message: unknown): string {
  const value = message as {
    type?: string
    content?: unknown
    message?: { content?: unknown }
  }
  if (value?.type !== 'assistant') return ''
  const content = value.content ?? value.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const item = block as { type?: string; text?: unknown }
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('\n')
}
