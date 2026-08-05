/**
 * AssistantTurnView — 一轮助手主线（对齐 General 的 turn 分层）
 *
 * - 模型铭牌 ×1 + 运行中计时 / 完成后时间
 * - 过程区：运行中始终展开
 * - 回答区 + 底部复制
 */
import { useMemo, useRef } from 'react'
import {
  Message,
  MessageContent,
  MessageLoading,
  MessageResponse,
  useSmoothStream,
} from '@tagent/ui'
import { ProcessGroupView } from './ProcessGroupView'
import { SubagentEntryCard } from './SubagentEntryCard'
import {
  buildTurnPresentation,
  filterSubagentItems,
  findSubagentTaskTool,
  listSubagentEntryIds,
  type SessionRenderTurn,
} from './session-turn-model'
import type { TaskCardState } from './subagent-ui-model'
import type { TurnDuration } from '@tagent/shared'
import { MessageCopyButton } from './MessageCopyButton'
import {
  formatElapsedDuration,
  formatMessageTime,
  useLiveElapsedMs,
} from '../../lib/time-utils'
import { MentionChip } from './MentionText'

interface AssistantTurnViewProps {
  turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }>
  /** 当前会话仍在跑且本 turn 是最新一轮（含工具间隙） */
  isLiveTurn?: boolean
  /** Chat @ 本轮点名角色展示名（顺序） */
  mentionLabels?: string[]
  /** 完成耗时（发送→idle 全程 + 结束方式；仅结束后由 Chat 传入）。复制栏/标题行显示耗时 */
  completedDuration?: TurnDuration
  /** 子代理任务卡片 lookup：parentToolUseId → taskCard（由 Chat 从 items 构造，供入口卡片状态） */
  subagentCards?: Map<string, TaskCardState>
  /** 打开子代理独立会话页面（Chat 层切换） */
  onOpenSubagent: (parentToolUseId: string) => void
}

export function AssistantTurnView({
  turn,
  isLiveTurn = false,
  mentionLabels,
  completedDuration,
  subagentCards,
  onOpenSubagent,
}: AssistantTurnViewProps): JSX.Element {
  // 主会话只留入口卡：按 launcher tool_use id / parentToolUseId 列入口，过程细节不进主时间线
  const subagentEntryIds = listSubagentEntryIds(turn.items)
  // 主线源：剔除子代理消息、委派合成 user、纯 taskCard（状态机只服务入口卡）
  const mainItems = turn.items.filter((it) => {
    if (it.taskCard && !it.message && !it.streaming) return false
    const m = it.message
    if (!m) return true
    if (m.parentToolUseId) return false
    return true
  })
  // 拆分由 buildTurnPresentation 按 Proma 契约决定：live 未可拆时不喂回答壳
  const presentation = buildTurnPresentation(
    { ...turn, items: mainItems },
    { isLiveTurn },
  )

  const processLive = isLiveTurn

  // 回答正文：流式与落盘取「更长且互为前缀」的那份，避免 answerFull 抢先导致
  // useSmoothStream 回退/重入队 → 画面上出现重复字（完成后又正常）。
  // presentation.streamingText 在「未可拆」时已为 undefined（正文留过程区）。
  const answerFull = presentation.answerTexts[0] ?? ''
  const streamText = presentation.streamingText ?? ''
  const content = resolveAnswerContent(answerFull, streamText)
  // 仅在「文本仍在增长或打字机未追上」时开流式；整轮 isLiveTurn（含纯工具间隙）不必强开
  const needsTypewriter =
    presentation.isStreaming ||
    Boolean(streamText) ||
    (isLiveTurn && Boolean(content) && Boolean(streamText || presentation.isStreaming))
  const { displayedContent } = useSmoothStream({
    content,
    isStreaming: needsTypewriter,
  })

  // 有过程块且尚无交付 text 时不展示空回答壳（避免 MessageLoading 与过程区抢镜闪一下）
  const showAnswerShell =
    Boolean(content.trim()) ||
    (processLive && presentation.process.length === 0 && !content)

  // 首条 assistant createdAt 作为运行起点；完成时间取最后一条有时间的 assistant
  const turnCreatedAt = mainItems.find(
    (it) => it.message?.type === 'assistant',
  )?.message?.createdAt

  const turnFinishedAt = useMemo(() => {
    for (let i = mainItems.length - 1; i >= 0; i--) {
      const m = mainItems[i]?.message
      if (m?.type === 'assistant' && m.createdAt) return m.createdAt
    }
    return turnCreatedAt
  }, [mainItems, turnCreatedAt])

  // 完成/中断耗时：正常完成显示「完成 Xs」（复制栏）；用户停止/出错在标题行显示「停止/出错 Xs」
  const completionMs = !isLiveTurn && completedDuration ? completedDuration.ms : 0
  const endedBy = completedDuration?.endedBy
  const completionLabel =
    endedBy === 'stopped' ? '停止' : endedBy === 'error' ? '出错' : '完成'

  // live 且尚无 createdAt：用首次进入 live 的时刻（结束后 ref 保留，不重置）
  const liveStartRef = useRef<number | null>(null)
  if (isLiveTurn && liveStartRef.current == null) {
    liveStartRef.current = turnCreatedAt ?? Date.now()
  }
  const startedAt = turnCreatedAt ?? liveStartRef.current ?? undefined
  const elapsedMs = useLiveElapsedMs(startedAt, isLiveTurn)

  const statusLabel = isLiveTurn
    ? `运行 ${formatElapsedDuration(elapsedMs)}`
    : completionMs > 0 && endedBy !== 'complete'
      ? `${completionLabel} ${formatElapsedDuration(completionMs)}`
      : turnFinishedAt
        ? formatMessageTime(turnFinishedAt)
        : ''

  // 复制用最终全文（优先落盘 answer；流式中用已显示内容）
  const copyText = (answerFull || displayedContent || content).trim()

  return (
    <div className="agent-turn flex flex-col gap-3">
      {(presentation.modelId || statusLabel || (mentionLabels && mentionLabels.length > 0)) && (
        <div className="agent-turn-title-row flex-wrap">
          {/* 有 @ 角色铭牌时不重复显示 modelId（避免两个铭牌并列）；否则正常显示模型名 */}
          {presentation.modelId && !(mentionLabels && mentionLabels.length > 0) ? (
            <div className="agent-turn-title">{presentation.modelId}</div>
          ) : null}
          {mentionLabels && mentionLabels.length > 0 ? (
            <div className="agent-turn-mention-list" title="本轮 @ 点名顺序">
              {mentionLabels.map((label, i) => (
                <span key={`${label}-${i}`} className="agent-turn-mention-list__item">
                  {i > 0 ? (
                    <span className="agent-turn-mention-list__arrow" aria-hidden>
                      →
                    </span>
                  ) : null}
                  <MentionChip label={label} />
                </span>
              ))}
            </div>
          ) : null}
          {statusLabel ? (
            <span
              className={
                isLiveTurn
                  ? 'agent-turn-title-row__time agent-turn-title-row__time--live'
                  : 'agent-turn-title-row__time'
              }
            >
              {statusLabel}
            </span>
          ) : null}
        </div>
      )}

      {presentation.process.length > 0 && (
        <div className="agent-turn-process">
          <ProcessGroupView process={presentation.process} isLive={processLive} />
        </div>
      )}

      {subagentEntryIds.map((parentToolUseId) => {
        const group = filterSubagentItems(turn.items, parentToolUseId).filter(
          (it) => it.message?.type === 'assistant',
        )
        return (
          <SubagentEntryCard
            key={parentToolUseId}
            items={group}
            card={subagentCards?.get(parentToolUseId)}
            launcher={findSubagentTaskTool(turn.items, parentToolUseId)}
            isLive={processLive}
            onOpen={() => onOpenSubagent(parentToolUseId)}
          />
        )
      })}

      {showAnswerShell && (
        <div className="agent-answer-block">
          <Message from="assistant">
            <MessageContent>
              {displayedContent.trim() ? (
                // 流式中直接渲染 markdown（逐字累积的文本喂给 MessageResponse）：
                // 纯文本过渡会让用户看到满屏原始 markdown 源码、完成后才突然切换，跳变明显。
                // streaming 标记让未闭合的富内容围栏（datatable/mermaid）显示占位而非原始 ```。
                <MessageResponse streaming={needsTypewriter}>{displayedContent}</MessageResponse>
              ) : processLive ? (
                <MessageLoading />
              ) : null}
            </MessageContent>
          </Message>
          {copyText || completionMs > 0 ? (
            <div className="agent-answer-toolbar">
              {copyText ? <MessageCopyButton text={copyText} /> : null}
              {completionMs > 0 && endedBy === 'complete' ? (
                <span className="agent-answer-time">
                  完成 {formatElapsedDuration(completionMs)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * 合并流式/落盘正文：同源前缀取更长；不相交时优先当前 stream（正在写）。
 */
function resolveAnswerContent(answer: string, stream: string): string {
  const a = answer.trimEnd()
  const s = stream.trimEnd()
  if (!a) return s
  if (!s) return a
  if (s.startsWith(a) || a.startsWith(s)) {
    return s.length >= a.length ? s : a
  }
  // 多轮工具后新开一段 stream，与旧 answer 不相交 → 用 stream（过程区另有旧文）
  return s
}
