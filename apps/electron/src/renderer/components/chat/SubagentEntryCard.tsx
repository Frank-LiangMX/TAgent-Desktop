/**
 * SubagentEntryCard — 子代理入口卡片（主会话只留入口，不显示过程）
 *
 * 对齐 Cursor Codex：子代理的完整过程**不渲染在主会话页面**，只显示一个紧凑
 * 入口卡片（任务摘要 + 状态 + 步骤数 + 「查看 →」）。点击后由 Chat 切换到
 * 子代理独立会话页面（SubagentDetailView）查看完整过程。
 *
 * 取代旧 SubagentTurnBlock（折叠展开过程）：折叠仍然会淹没聊天区，且用户
 * 明确要求子代理过程不进主会话。
 */
import { memo, useMemo } from 'react'
import { ArrowRight } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { summarizeFirstText } from './subagent-ui-model'
import type { TurnSourceItem } from './session-turn-model'
import type { TaskCardState } from './subagent-ui-model'

interface SubagentEntryCardProps {
  /** 同一子代理的多条消息（已按 parentToolUseId 分组，保持到达顺序） */
  items: TurnSourceItem[]
  /** 子代理任务卡片状态（task_started/progress/notification，无则 undefined） */
  card?: TaskCardState
  /** 主线 launcher tool_use（Agent/task）input，用于任务描述 */
  launcher?: { name: string; input: Record<string, unknown> } | null
  /** 当前会话仍在跑且本块属于最新一轮 */
  isLive?: boolean
  /** 点击入口：打开子代理独立会话页面 */
  onOpen: () => void
}

const STATUS_TEXT: Record<TaskCardState['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
}

function launcherSummary(launcher?: { name: string; input: Record<string, unknown> } | null): string {
  if (!launcher?.input) return ''
  const desc = launcher.input.description ?? launcher.input.prompt
  if (typeof desc === 'string' && desc.trim()) {
    const t = desc.trim().replace(/\s+/g, ' ')
    return t.length > 140 ? `${t.slice(0, 140)}…` : t
  }
  return ''
}

export function SubagentEntryCard({
  items,
  card,
  launcher,
  isLive = false,
  onOpen,
}: SubagentEntryCardProps): JSX.Element | null {
  // 摘要：任务卡描述 > launcher input > 子代理首条文本
  const summary = useMemo(() => {
    if (card?.description) return card.description
    const fromLauncher = launcherSummary(launcher)
    if (fromLauncher) return fromLauncher
    for (const it of items) {
      const m = it.message
      if (m?.type === 'assistant') {
        const s = summarizeFirstText(m, 140)
        if (s) return s
      }
    }
    return '子代理任务'
  }, [card?.description, launcher, items])

  const messageCount = items.filter((it) => it.message?.type === 'assistant').length
  // 尚无子代理消息、无收口卡、会话 live → 运行中；仅有 launcher 且会话已结束 → 已完成
  const status: TaskCardState['status'] =
    card?.status ??
    (messageCount === 0 && isLive
      ? 'running'
      : isLive && messageCount > 0 && !card
        ? 'running'
        : 'completed')
  const statusText = card ? STATUS_TEXT[card.status] : STATUS_TEXT[status]

  return (
    <button
      type="button"
      className={cn(
        'subagent-entry-card',
        status === 'running' && 'is-running',
        status === 'failed' && 'is-failed',
        status === 'completed' && 'is-completed',
      )}
      onClick={onOpen}
      title="查看子代理完整过程"
    >
      <span className="subagent-entry-card__dot" aria-hidden />
      <span className="subagent-entry-card__title">子代理</span>
      <span className="subagent-entry-card__status">{statusText}</span>
      {messageCount > 1 && (
        <span className="subagent-entry-card__count">{messageCount} 步</span>
      )}
      <span className="subagent-entry-card__summary">{summary}</span>
      <span className="subagent-entry-card__open">
        查看
        <ArrowRight size={11} weight="bold" />
      </span>
    </button>
  )
}

export const MemoSubagentEntryCard = memo(SubagentEntryCard)
