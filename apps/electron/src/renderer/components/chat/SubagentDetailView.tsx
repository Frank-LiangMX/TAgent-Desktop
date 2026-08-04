/**
 * SubagentDetailView — 子代理独立会话页面（完整会话模式渲染）
 *
 * 从主会话入口（SubagentEntryCard）进入后全屏切换到此页。像 Cursor Codex 一样，
 * 子代理的完整过程**不占用主会话聊天区**，而是作为独立页面查看：
 *
 * - 顶部栏：返回主会话 + 子代理标题 + 模型 + 状态（对齐主会话 turn 头部：chrome 只出现一次）
 * - 任务指令区：主线程发起该子代理的 task tool_use.input
 * - 正文：按到达顺序渲染子代理的思考 / 工具调用（含入参与输出）/ 文本 / 错误，
 *   复用与主会话相同的 ContentBlockView + ToolResultView，无逐条消息 chrome，
 *   实时跟随 items 更新（含流式）
 */
import { memo, useMemo } from 'react'
import { ArrowLeft, Copy } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  formatElapsedDuration,
  formatMessageTime,
  useLiveElapsedMs,
} from '../../lib/time-utils'
import type { TurnSourceItem } from './session-turn-model'
import {
  findSubagentTaskTool,
  filterSubagentItems,
} from './session-turn-model'
import { summarizeFirstText } from './subagent-ui-model'
import type { TaskCardState } from './subagent-ui-model'
import type {
  TAgentContentBlock,
  TAgentMessage,
  TAgentToolResultBlock,
} from '@tagent/shared'
import { ContentBlockView } from './ContentBlockView'
import { ToolResultView } from './ToolResultView'

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

  // 复制全文：所有 assistant 消息的 text 拼起来
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

  return (
    <div className="subagent-detail">
      {/* 顶部栏 */}
      <div className="subagent-detail__header">
        <button type="button" className="subagent-detail__back" onClick={onBack}>
          <ArrowLeft size={14} />
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
          {fullText.trim() && (
            <CopyDetailButton text={fullText} />
          )}
        </div>
      </div>

      <div className="subagent-detail__body">
        {/* 任务指令区 */}
        {taskTool && <TaskPromptBlock taskTool={taskTool} />}

        {/* 完整会话流 */}
        <div className="subagent-detail__stream">
          {subagentItems.length === 0 && (
            <div className="subagent-detail__empty">子代理尚未产生消息…</div>
          )}
          {renderSubagentStream(subagentItems)}
        </div>
      </div>
    </div>
  )
}

/** 渲染子代理完整消息流：assistant 块直接渲染，tool_result 配对到工具下。
 *  对齐主会话 turn：无逐条消息 chrome（模型/时间已在顶部一次）。 */
function renderSubagentStream(items: TurnSourceItem[]): JSX.Element[] {
  const resultById = new Map<string, { content: unknown; isError: boolean }>()
  const out: JSX.Element[] = []

  items.forEach((it) => {
    const m = it.message
    if (!m) return

    if (m.type === 'user') {
      // tool_result 合成回传：收集配对，实际渲染挂在对应 assistant tool_use 下
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const rb = b as { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }
          resultById.set(rb.toolUseId, {
            content: rb.content,
            isError: Boolean(rb.isError),
          })
        }
      }
      return
    }

    if (m.type === 'assistant') {
      const body = m.content.map((block, i) => {
        if (block.type === 'tool_use') {
          const tu = block as {
            type: 'tool_use'
            id: string
            name: string
            input: Record<string, unknown>
          }
          const result = resultById.get(tu.id)
          return (
            <div key={`${it.key}-b${i}`} className="subagent-detail__tool">
              <ContentBlockView block={block as TAgentContentBlock} />
              {result && (
                <div className="subagent-detail__tool-result">
                  <ToolResultView
                    block={{
                      type: 'tool_result',
                      toolUseId: tu.id,
                      content: result.content,
                      isError: result.isError,
                    } as TAgentToolResultBlock}
                  />
                </div>
              )}
            </div>
          )
        }
        return <ContentBlockView key={`${it.key}-b${i}`} block={block as TAgentContentBlock} />
      })

      out.push(
        <div key={it.key} className="subagent-detail__msg">
          <div className="subagent-detail__msg-content">
            {m.error && (
              <div className="mb-1 text-xs text-destructive">{m.error.message}</div>
            )}
            {body}
          </div>
        </div>,
      )
    }
  })

  return out
}

/** 任务指令块：渲染发起子代理的 task 工具入参 */
function TaskPromptBlock({
  taskTool,
}: {
  taskTool: { name: string; input: Record<string, unknown> }
}): JSX.Element {
  const input = taskTool.input ?? {}
  // 优先把描述性字段做成人话，其余字段 JSON 展示
  const descFields = ['description', 'prompt', 'query', 'task']
  const descValues = descFields
    .map((f) => (typeof input[f] === 'string' ? (input[f] as string).trim() : ''))
    .filter(Boolean)
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (!descFields.includes(k)) rest[k] = v
  }

  return (
    <div className="subagent-detail__prompt">
      <div className="subagent-detail__prompt-label">任务指令</div>
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
