/**
 * SubagentEntryCard — 子代理入口
 *
 * - card：完整模式独立卡片
 * - timeline：简洁模式 Cursor 式嵌套行（任务描述 + 右侧模型/状态 + 进度）
 */
import { memo, useMemo } from 'react'
import { ArrowRight } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
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
  /** card=独立卡；timeline=嵌进简洁运行链 */
  variant?: 'card' | 'timeline'
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

/** launcher.input 里的角色/类型字段（不是模型 id） */
function launcherRoleHint(
  launcher?: { name: string; input: Record<string, unknown> } | null,
): string | undefined {
  if (!launcher?.input) return undefined
  for (const key of ['subagent_type', 'agent', 'agent_type', 'role'] as const) {
    const v = launcher.input[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * 右侧「模型」标签：优先 assistant.modelId（真实跑的模型），
 * 其次 launcher.input.model（仅当不像角色别名时）。
 * 不再用 subagent_type 冒充模型（会显示成 analyst / code-reviewer）。
 */
function resolveModelLabel(
  items: TurnSourceItem[],
  launcher?: { name: string; input: Record<string, unknown> } | null,
): string | undefined {
  for (const it of items) {
    const m = it.message
    if (m?.type === 'assistant' && typeof m.modelId === 'string' && m.modelId.trim()) {
      return m.modelId.trim()
    }
  }
  const raw = launcher?.input?.model
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const model = raw.trim()
  // 若 model 字段实际填的是角色名，不当模型展示
  const role = launcherRoleHint(launcher)
  if (role && model === role) return undefined
  return model
}

/** 简洁行右侧：有模型显示模型；兼有角色时「角色 · 模型」 */
function resolveMetaLabel(
  items: TurnSourceItem[],
  launcher?: { name: string; input: Record<string, unknown> } | null,
): string {
  const model = resolveModelLabel(items, launcher)
  const role = launcherRoleHint(launcher)
  if (model && role && role !== model) return `${role} · ${model}`
  if (model) return model
  if (role) return role
  return '子代理'
}

export function SubagentEntryCard({
  items,
  card,
  launcher,
  isLive = false,
  variant = 'card',
  onOpen,
}: SubagentEntryCardProps): JSX.Element | null {
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

  const entryAnchorId =
    card?.toolUseId ||
    items.find((it) => it.message?.type === 'assistant' && it.message.parentToolUseId)?.message
      ?.parentToolUseId
  const messageCount = items.filter((it) => it.message?.type === 'assistant').length
  // terminal card.status 优先；缺卡时 live 才算 running，避免失败后仍显示运行中
  const status: TaskCardState['status'] =
    card?.status ??
    (messageCount === 0 && isLive
      ? 'running'
      : isLive && messageCount > 0 && !card
        ? 'running'
        : 'completed')
  const statusText = card ? STATUS_TEXT[card.status] : STATUS_TEXT[status]
  const isRunning = status === 'running'
  const metaLabel = useMemo(
    () => resolveMetaLabel(items, launcher),
    [items, launcher],
  )
  // Cursor：右侧挂模型（可带角色前缀）；完成态用第二行 Completed，不替换右侧
  const progressLine = isRunning
    ? card?.progressText || (card?.lastToolName ? `运行工具：${card.lastToolName}` : undefined)
    : status === 'completed'
      ? '已完成'
      : statusText

  if (variant === 'timeline') {
    return (
      <AppTooltip label="查看子代理完整过程">
        <button
          type="button"
          data-message-id={entryAnchorId ? `subagent-${entryAnchorId}` : undefined}
          className={cn(
            'agent-concise-subagent',
            isRunning && 'is-running',
            status === 'failed' && 'is-failed',
          )}
          onClick={onOpen}
        >
          <span className="agent-concise-subagent__bullet" aria-hidden>
            •
          </span>
          <span className="agent-concise-subagent__main">
            <span className="agent-concise-subagent__row">
              <span className="agent-concise-subagent__title">{summary}</span>
              <span
                className={cn(
                  'agent-concise-subagent__meta',
                  isRunning && 'agent-concise-shimmer',
                )}
              >
                {metaLabel}
              </span>
            </span>
            {progressLine && progressLine !== summary ? (
              <span
                className={cn(
                  'agent-concise-subagent__progress',
                  isRunning && 'agent-concise-shimmer',
                )}
              >
                {progressLine}
              </span>
            ) : null}
          </span>
        </button>
      </AppTooltip>
    )
  }

  return (
    <AppTooltip label="查看子代理完整过程">
      <button
        type="button"
        data-message-id={entryAnchorId ? `subagent-${entryAnchorId}` : undefined}
        className={cn(
          'subagent-entry-card',
          status === 'running' && 'is-running',
          status === 'failed' && 'is-failed',
          status === 'completed' && 'is-completed',
        )}
        onClick={onOpen}
      >
        <span className="subagent-entry-card__dot" aria-hidden />
        <span className="subagent-entry-card__body">
          <span className="subagent-entry-card__row">
            <span className="subagent-entry-card__title">子代理</span>
            <span
              className={cn(
                'subagent-entry-card__status',
                isRunning && 'agent-concise-shimmer',
              )}
            >
              {statusText}
            </span>
            {isRunning && card?.lastToolName ? (
              <span className="subagent-entry-card__tool">· {card.lastToolName}</span>
            ) : null}
            {messageCount > 1 && (
              <span className="subagent-entry-card__count">{messageCount} 步</span>
            )}
          </span>
          <span className="subagent-entry-card__summary">{summary}</span>
          {progressLine && progressLine !== summary ? (
            <span
              className={cn(
                'subagent-entry-card__progress',
                isRunning && 'agent-concise-shimmer',
              )}
            >
              {progressLine}
            </span>
          ) : null}
        </span>
        <span className="subagent-entry-card__open">
          查看
          <ArrowRight size={11} weight="bold" />
        </span>
      </button>
    </AppTooltip>
  )
}

export const MemoSubagentEntryCard = memo(SubagentEntryCard)
