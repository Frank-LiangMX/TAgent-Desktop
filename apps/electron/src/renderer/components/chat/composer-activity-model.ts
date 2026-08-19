/**
 * 输入框旁「活动浮岛」数据：主会话时间线里没有的后台任务
 *（Bash / 单独拉起的 CLI 工人）。主线子代理走消息流 + 摘要，不进这里。
 */
import type { SessionBackgroundProcess } from '@tagent/shared'

export type ComposerActivityKind = 'process'

export type ComposerActivityItem = {
  id: string
  kind: ComposerActivityKind
  /** 列表主文案：命令行 */
  title: string
  startedAt: number
  /** 行左侧短标：终端 / CLI */
  badge: string
  processId: string
}

export type ComposerActivitySummary = {
  items: ComposerActivityItem[]
  processCount: number
  terminalCount: number
  cliCount: number
  /** 收起 pill：`1 终端` / `1 CLI` / `1 终端 · 1 CLI` */
  pillLabel: string
  /** 展开头：`1 终端运行中` / `2 CLI 运行中` / `3 项后台运行中` */
  headerLabel: string
}

function processBadge(source: SessionBackgroundProcess['source']): string {
  return source === 'cli-worker' ? 'CLI' : '终端'
}

function processTitle(command: string): string {
  const t = command.replace(/\s+/g, ' ').trim()
  return t || '后台命令'
}

export function collectComposerActivity(input: {
  processes?: readonly SessionBackgroundProcess[]
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
  items.sort((a, b) => a.startedAt - b.startedAt)
  return items
}

export function summarizeComposerActivity(
  items: readonly ComposerActivityItem[],
): ComposerActivitySummary {
  let terminalCount = 0
  let cliCount = 0
  for (const it of items) {
    if (it.badge === 'CLI') cliCount += 1
    else terminalCount += 1
  }
  const parts: string[] = []
  if (terminalCount > 0) parts.push(`${terminalCount} 终端`)
  if (cliCount > 0) parts.push(`${cliCount} CLI`)
  const pillLabel = parts.join(' · ')
  const processCount = terminalCount + cliCount
  let headerLabel = `${processCount} 项后台运行中`
  if (cliCount === 0 && terminalCount > 0) headerLabel = `${terminalCount} 终端运行中`
  else if (terminalCount === 0 && cliCount > 0) headerLabel = `${cliCount} CLI 运行中`
  return {
    items: [...items],
    processCount,
    terminalCount,
    cliCount,
    pillLabel,
    headerLabel,
  }
}
