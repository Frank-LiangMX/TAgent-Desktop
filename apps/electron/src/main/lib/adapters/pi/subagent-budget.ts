/** A bounded exploration phase followed by one tool-free synthesis request. */
export function delegatedBudget(complexity: 'simple' | 'standard' | 'complex' = 'standard') {
  const limits = {
    simple: { toolCalls: 20, timeoutMs: 120_000 },
    standard: { toolCalls: 40, timeoutMs: 300_000 },
    complex: { toolCalls: 80, timeoutMs: 600_000 },
  }
  return { ...limits[complexity], summaryMs: 30_000 }
}

export function budgetInstruction(toolCalls: number, timeoutMs: number): string {
  return `执行预算：最多 ${toolCalls} 次工具调用（批量调用逐项计数），总时限 ${Math.round(timeoutMs / 1000)} 秒。优先检查最有价值的文件，合并检索；保留时间整理结论。收到预算收尾通知后，停止调用工具，仅汇总已经确认的事实、证据路径和未完成范围，不得将未检查内容声称为已完成。`
}

export function budgetSummaryInstruction(reason: string): string {
  return `执行预算收尾：${reason}。本次请求不再提供工具。请立即输出阶段报告：已确认的发现及证据、尚未完成的范围、主代理下一步需要检查什么。不要继续计划调用工具，不要把阶段报告当作完整交付。`
}
