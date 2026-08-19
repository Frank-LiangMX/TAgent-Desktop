/**
 * SubagentDetailView — 子代理独立会话页面
 *
 * 从主会话入口（SubagentEntryCard）进入后全屏切换到此页：
 * - 顶部栏：返回 + 标题 + 模型 + 状态（chrome 只一次）
 * - 任务指令区：默认折叠，只显示一行摘要
 * - 过程区：与主会话同一套过程展示偏好（chatProcessDisplayModeAtom）
 *   · full → ProcessGroupView
 *   · concise → ConciseTimelineView
 * - 回答区：full 模式末尾交付文本；concise 时正文已并入时间线
 */
import { memo, useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { ArrowLeft, CaretRight, Copy } from '@phosphor-icons/react'
import { AppTooltip, Message, MessageContent, MessageResponse } from '@tagent/ui'
import { cn } from '../../lib/utils'
import {
  formatElapsedDuration,
  formatMessageTime,
  useLiveElapsedMs,
} from '../../lib/time-utils'
import { chatProcessDisplayModeAtom } from '../../atoms/chat-display-prefs'
import type { TurnSourceItem } from './session-turn-model'
import {
  buildTurnPresentation,
  findSubagentTaskTool,
  filterSubagentItems,
} from './session-turn-model'
import { summarizeFirstText } from './subagent-ui-model'
import type { TaskCardState } from './subagent-ui-model'
import type { TAgentContentBlock, TAgentMessage } from '@tagent/shared'
import { ProcessGroupView } from './ProcessGroupView'
import { ConciseTimelineView } from './ConciseTimelineView'
import { buildConciseTimeline } from './concise-timeline-model'

interface SubagentDetailViewProps {
  /** Chat 全部显示项（实时，含流式） */
  items: TurnSourceItem[]
  /** 当前打开的子代理 id（主线 task tool_use id） */
  parentToolUseId: string
  /** 子代理任务卡片（task_started/progress/notification，无则 undefined） */
  card?: TaskCardState
  /** 返回主会话 */
  onBack: () => void
}

const STATUS_META: Record<
  TaskCardState['status'],
  { text: string; cls: string }
> = {
  running: { text: '运行中', cls: 'is-running' },
  completed: { text: '已完成', cls: 'is-completed' },
  failed: { text: '失败', cls: 'is-failed' },
  stopped: { text: '已停止', cls: 'is-stopped' },
}

export function SubagentDetailView({
  items,
  parentToolUseId,
  card,
  onBack,
}: SubagentDetailViewProps): JSX.Element | null {
  const subagentItems = useMemo(
    () => filterSubagentItems(items, parentToolUseId),
    [items, parentToolUseId],
  )
  const taskTool = useMemo(
    () => findSubagentTaskTool(items, parentToolUseId),
    [items, parentToolUseId],
  )

  // 标题：任务描述 → task 工具 input 里的 description/prompt → 首条消息摘要
  const title = useMemo(() => {
    if (card?.description) return card.description
    const d = taskTool?.input?.description
    if (typeof d === 'string' && d.trim()) return d
    const p = taskTool?.input?.prompt
    if (typeof p === 'string' && p.trim()) return p.trim().slice(0, 120)
    for (const it of subagentItems) {
      const m = it.message
      if (m?.type === 'assistant') {
        const s = summarizeFirstText(m, 120)
        if (s) return s
      }
    }
    return '子代理任务'
  }, [card?.description, taskTool, subagentItems])

  // 状态：优先 taskCard；否则按是否有最终文本 / 是否 live 推断
  const status: TaskCardState['status'] =
    card?.status ?? (subagentItems.length === 0 ? 'running' : 'completed')
  const statusMeta = STATUS_META[status]

  // 模型：子代理绑定单一模型，取第一条 assistant 消息的 modelId，顶部显示一次
  const modelId = useMemo(() => {
    for (const it of subagentItems) {
      const m = it.message
      if (m?.type === 'assistant' && m.modelId) return m.modelId
    }
    return undefined
  }, [subagentItems])

  // 时间：优先 taskCard.startedAt（task_started 写入），避免「全文一次性落盘」时
  // first/last createdAt 相同 → 运行了 0.0s
  const firstCreatedAt = useMemo(() => {
    for (const it of subagentItems) {
      const m = it.message
      if (m?.type === 'assistant' && m.createdAt) return m.createdAt
    }
    return undefined
  }, [subagentItems])
  const finishedAt = useMemo(() => {
    for (let i = subagentItems.length - 1; i >= 0; i--) {
      const m = subagentItems[i]?.message
      if (m?.type === 'assistant' && m.createdAt) return m.createdAt
    }
    return undefined
  }, [subagentItems])
  const isRunning = status === 'running'
  // 禁止 `isRunning ? Date.now() : undefined`——每帧新 timestamp 会打爆 useLiveElapsedMs
  const liveFallbackRef = useRef<number | null>(null)
  if (isRunning) {
    if (liveFallbackRef.current == null) liveFallbackRef.current = Date.now()
  } else {
    liveFallbackRef.current = null
  }
  const startedAt =
    (typeof card?.startedAt === 'number' ? card.startedAt : undefined) ??
    firstCreatedAt ??
    liveFallbackRef.current ??
    undefined
  const liveElapsedMs = useLiveElapsedMs(startedAt, isRunning)
  // 完成态：card.endedAt > 消息时间 > startedAt，避免一次落盘同戳 → 0.0s
  const endAt =
    (typeof card?.endedAt === 'number' ? card.endedAt : undefined) ?? finishedAt
  const completedElapsedMs =
    startedAt != null && endAt != null && endAt >= startedAt ? endAt - startedAt : 0
  const elapsedMs = isRunning ? liveElapsedMs : completedElapsedMs
  const statusText = isRunning
    ? `运行 ${formatElapsedDuration(elapsedMs)}`
    : finishedAt
      ? formatMessageTime(finishedAt)
      : statusMeta.text

  // 复制全文：优先交付回答，否则拼所有 assistant text
  const fullText = useMemo(() => {
    return subagentItems
      .map((it) => {
        const m = it.message
        if (m?.type !== 'assistant') return ''
        return m.content
          .filter((b): b is Extract<TAgentContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
      })
      .filter(Boolean)
      .join('\n\n')
  }, [subagentItems])

  /** 与主会话共用过程展示偏好（模型选择器里的完整/简洁） */
  const processDisplayMode = useAtomValue(chatProcessDisplayModeAtom)
  const isConcise = processDisplayMode === 'concise'

  /**
   * 与主会话同一套过程/回答拆分。
   * buildTurnPresentation 会跳过 parentToolUseId 消息，故展示前先剥掉 parent 标记。
   */
  const presentation = useMemo(() => {
    const normalized: TurnSourceItem[] = subagentItems.map((it) => {
      const m = it.message
      if (!m || (m.type !== 'assistant' && m.type !== 'user')) return it
      if (!m.parentToolUseId) return it
      return {
        ...it,
        message: { ...m, parentToolUseId: null } as TAgentMessage,
      }
    })
    return buildTurnPresentation(
      {
        kind: 'assistant-turn',
        key: `sub-${parentToolUseId}`,
        items: normalized,
        isStreaming: isRunning,
        modelId,
      },
      { isLiveTurn: isRunning, displayMode: processDisplayMode },
    )
  }, [subagentItems, parentToolUseId, isRunning, modelId, processDisplayMode])

  const conciseSegments = useMemo(
    () =>
      isConcise
        ? buildConciseTimeline(presentation.process, {
            answerTexts: presentation.answerTexts,
            streamingText: presentation.streamingText,
            isLive: isRunning,
          })
        : [],
    [
      isConcise,
      presentation.process,
      presentation.answerTexts,
      presentation.streamingText,
      isRunning,
    ],
  )

  const answerText = presentation.answerTexts.join('\n\n').trim()
  const copyText = (answerText || fullText).trim()

  return (
    <div className="subagent-detail">
      {/* 顶部栏 */}
      <div className="subagent-detail__header">
        <button type="button" className="subagent-detail__back" onClick={onBack}>
          <ArrowLeft size={14} weight="bold" />
          返回主会话
        </button>
        <div className="subagent-detail__title-wrap">
          <span className="subagent-detail__title-dot" aria-hidden />
          <span className="subagent-detail__title">{title}</span>
          {modelId && <span className="subagent-detail__model-badge">{modelId}</span>}
          <span className={cn('subagent-detail__status', statusMeta.cls)}>
            {statusText}
          </span>
        </div>
        <div className="subagent-detail__actions">
          {copyText && <CopyDetailButton text={copyText} />}
        </div>
      </div>

      <div className="subagent-detail__body">
        {taskTool && <TaskPromptBlock taskTool={taskTool} />}

        <div className="subagent-detail__stream">
          {subagentItems.length === 0 && (
            <div className="subagent-detail__empty">子代理尚未产生消息…</div>
          )}

          {isConcise ? (
            conciseSegments.length > 0 ? (
              <ConciseTimelineView
                segments={conciseSegments}
                isLive={isRunning}
                isLatestTurn
                workedMs={elapsedMs}
              />
            ) : null
          ) : (
            <>
              {presentation.process.length > 0 && (
                <div className="agent-turn-process">
                  <ProcessGroupView
                    process={presentation.process}
                    isLive={isRunning}
                    autoExpandWhenLive
                    displayMode="full"
                    hasFinalOutput={Boolean(answerText)}
                  />
                </div>
              )}
              {answerText ? (
                <div className="agent-answer-block subagent-detail__answer">
                  <Message from="assistant">
                    <MessageContent>
                      <MessageResponse>{answerText}</MessageResponse>
                    </MessageContent>
                  </Message>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 任务指令：默认折叠为一行，点开才看全文 / 其余 JSON */
function TaskPromptBlock({
  taskTool,
}: {
  taskTool: { name: string; input: Record<string, unknown> }
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const input = taskTool.input ?? {}
  const descFields = ['description', 'prompt', 'query', 'task']
  const descValues = descFields
    .map((f) => (typeof input[f] === 'string' ? (input[f] as string).trim() : ''))
    .filter(Boolean)
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (!descFields.includes(k)) rest[k] = v
  }
  const summary = (descValues[0] ?? '查看任务指令').replace(/\s+/g, ' ')
  const summaryLine = summary.length > 96 ? `${summary.slice(0, 96)}…` : summary

  return (
    <div className={cn('subagent-detail__prompt', open && 'is-open')}>
      <button
        type="button"
        className="subagent-detail__prompt-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRight
          size={12}
          weight="bold"
          className={cn(
            'shrink-0 text-muted-foreground/45 transition-transform duration-150 ease-linear',
            open && 'rotate-90',
          )}
        />
        <span className="subagent-detail__prompt-label">任务指令</span>
        {!open && (
          <span className="subagent-detail__prompt-summary">{summaryLine}</span>
        )}
      </button>
      {open && (
        <div className="subagent-detail__prompt-body">
          {descValues.length > 0 && (
            <div className="subagent-detail__prompt-text whitespace-pre-wrap break-words">
              {descValues.join('\n\n')}
            </div>
          )}
          {Object.keys(rest).length > 0 && (
            <pre className="subagent-detail__prompt-json">
              {JSON.stringify(rest, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/** 复制按钮（复制后短暂显示 ✓） */
function CopyDetailButton({ text }: { text: string }): JSX.Element {
  return (
    <AppTooltip label="复制子代理全部文本">
      <button
        type="button"
        className="subagent-detail__copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
          } catch {
            /* clipboard 不可用时静默失败 */
          }
        }}
      >
        <Copy size={13} />
      </button>
    </AppTooltip>
  )
}

export const MemoSubagentDetailView = memo(SubagentDetailView)
