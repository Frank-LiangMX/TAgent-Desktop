/**
 * 输入框旁「活动浮岛」数据：主会话外仍在跑的后台进程 + 子代理。
 * 纯函数，对齐 Cursor 输入框左上「1 Terminal」pill / 展开列表。
 */
import type { SessionBackgroundProcess } from '@tagent/shared'
import type { TaskCardState } from './subagent-ui-model'

export type ComposerActivityKind = 'process' | 'subagent'

export type ComposerActivityItem = {
  id: string
  kind: ComposerActivityKind
  /** 列表主文案：命令或子代理描述 */
  title: string
  startedAt: number
  /** 行左侧短标：终端 / CLI / 子代理 */
  badge: string
  processId?: string
  parentToolUseId?: string
}

export type ComposerActivitySummary = {
  items: ComposerActivityItem[]
  processCount: number
  subagentCount: number
  /** 收起 pill：`1 终端` / `1 子代理` / `1 终端 · 1 子代理` */
  pillLabel: string
  /** 展开头：`1 终端运行中` / `1 子代理运行中` / `2 项运行中` */
  headerLabel: string
}

function processBadge(source: SessionBackgroundProcess['source']): string {
  return source === 'cli-worker' ? 'CLI' : '终端'
}

function processTitle(command: string): string {
  const t = command.replace(/\s+/g, ' ').trim()
  return t || '后台命令'
}

function subagentTitle(card: TaskCardState): string {
  const d = card.description?.replace(/\s+/g, ' ').trim()
  if (d) return d
  if (card.progressText?.trim()) return card.progressText.trim()
  if (card.lastToolName?.trim()) return card.lastToolName.trim()
  return '子代理'
}

export function collectComposerActivity(input: {
  processes?: readonly SessionBackgroundProcess[]
  taskCards?: readonly TaskCardState[]
}): ComposerActivityItem[] {
  const items: ComposerActivityItem[] = []
  for (const p of input.processes ?? []) {
    items.push({
      id: `proc:${p.id}`,
      kind: 'process',
      title: processTitle(p.command),
      startedAt: p.startedAt,
      badge: processBadge(p.source),
      processId: p.id,
    })
  }
  for (const card of input.taskCards ?? []) {
    if (card.status !== 'running') continue
    items.push({
      id: `sub:${card.taskId}`,
      kind: 'subagent',
      title: subagentTitle(card),
      startedAt: card.startedAt ?? 0,
      badge: '子代理',
      parentToolUseId: card.toolUseId,
    })
  }
  items.sort((a, b) => a.startedAt - b.startedAt)
  return items
}

export function summarizeComposerActivity(
  items: readonly ComposerActivityItem[],
): ComposerActivitySummary {
  let processCount = 0
  let subagentCount = 0
  for (const it of items) {
    if (it.kind === 'process') processCount++
    else subagentCount++
  }
  const parts: string[] = []
  if (processCount > 0) parts.push(`${processCount} 终端`)
  if (subagentCount > 0) parts.push(`${subagentCount} 子代理`)
  const pillLabel = parts.join(' · ')
  const total = processCount + subagentCount
  let headerLabel = `${total} 项运行中`
  if (processCount > 0 && subagentCount === 0) headerLabel = `${processCount} 终端运行中`
  else if (subagentCount > 0 && processCount === 0) headerLabel = `${subagentCount} 子代理运行中`
  return { items: [...items], processCount, subagentCount, pillLabel, headerLabel }
}
