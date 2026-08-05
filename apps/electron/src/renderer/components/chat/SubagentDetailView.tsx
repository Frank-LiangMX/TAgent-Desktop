/**
 * SubagentDetailView — 子代理独立会话页面
 *
 * 从主会话入口（SubagentEntryCard）进入后全屏切换到此页：
 * - 顶部栏：返回 + 标题 + 模型 + 状态（chrome 只一次）
 * - 任务指令区：默认折叠，只显示一行摘要
 * - 过程区：复用主会话 ProcessGroupView（默认收成一行摘要，不整页展开思考/工具）
 * - 回答区：末尾交付文本
 */
import { memo, useMemo, useState } from 'react'
import { ArrowLeft, CaretRight, Copy } from '@phosphor-icons/react'
import { Message, MessageContent, MessageResponse } from '@tagent/ui'
import { cn } from '../../lib/utils'
import {
  formatElapsedDuration,
  formatMessageTime,
  useLiveElapsedMs,
} from '../../lib/time-utils'
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

  // 时间对齐主会话 turn 头部：运行中显示耗时，完成态显示完成时间（顶部一次）
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
  const startedAt = firstCreatedAt ?? (isRunning ? Date.now() : undefined)
  const elapsedMs = useLiveElapsedMs(startedAt, isRunning)
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
      // 运行中过程一条路展开摘要行；结束后收成一行，不默认摊开思考/工具全文
      { isLiveTurn: isRunning },
    )
  }, [subagentItems, parentToolUseId, isRunning, modelId])

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

          {presentation.process.length > 0 && (
            <div className="agent-turn-process">
              {/* 子代理详情：过程默认收成一行，不自动摊开全部思考/工具 */}
              <ProcessGroupView
                process={presentation.process}
                isLive={isRunning}
                autoExpandWhenLive={false}
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
            'shrink-0 text-muted-foreground/45 transition-transform duration-150',
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
    <button
      type="button"
      className="subagent-detail__copy"
      title="复制子代理全部文本"
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
  )
}

export const MemoSubagentDetailView = memo(SubagentDetailView)
