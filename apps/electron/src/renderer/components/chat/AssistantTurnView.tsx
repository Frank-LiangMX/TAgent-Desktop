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
import {
  buildTurnPresentation,
  type SessionRenderTurn,
} from './session-turn-model'
import { MessageView } from './MessageView'
import { MessageCopyButton } from './MessageCopyButton'
import {
  formatElapsedDuration,
  formatMessageTime,
  useLiveElapsedMs,
} from '../../lib/time-utils'

interface AssistantTurnViewProps {
  turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }>
  /** 当前会话仍在跑且本 turn 是最新一轮（含工具间隙） */
  isLiveTurn?: boolean
  /** Chat @ 本轮点名角色展示名（顺序） */
  mentionLabels?: string[]
  /** 完成耗时（毫秒，发送→idle 全程；仅完成后由 Chat 传入）。复制栏显示「完成 Xs」 */
  completedDurationMs?: number
}

export function AssistantTurnView({
  turn,
  isLiveTurn = false,
  mentionLabels,
  completedDurationMs,
}: AssistantTurnViewProps): JSX.Element {
  const subagentItems = turn.items.filter(
    (it) => it.message?.type === 'assistant' && it.message.parentToolUseId,
  )
  const mainItems = turn.items.filter(
    (it) => !(it.message?.type === 'assistant' && it.message.parentToolUseId),
  )
  const presentation = buildTurnPresentation({ ...turn, items: mainItems })

  const processLive = isLiveTurn

  // 回答正文：流式与落盘取「更长且互为前缀」的那份，避免 answerFull 抢先导致
  // useSmoothStream 回退/重入队 → 画面上出现重复字（完成后又正常）。
  const answerFull = presentation.answerTexts[0] ?? ''
  const streamText = presentation.streamingText ?? ''
  const content = resolveAnswerContent(answerFull, streamText)
  // 仅在「文本仍在增长或打字机未追上」时开流式；整轮 isLiveTurn（含纯工具间隙）不必强开
  const needsTypewriter =
    presentation.isStreaming ||
    Boolean(streamText) ||
    // 落盘后仍保留 streamText 时，让 rAF 把队列追完（session-turn-model 约定）
    (isLiveTurn && Boolean(content) && Boolean(streamText || presentation.isStreaming))
  const { displayedContent } = useSmoothStream({
    content,
    isStreaming: needsTypewriter,
  })

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

  // 完成耗时由 Chat 传入（发送→idle 全程，覆盖思考期 + 工具轮），不在此按 assistant
  // createdAt 自算（流式 assistant 可能无 createdAt → 有时不显示；且口径是 turn 内非全程）。
  const completionMs = !isLiveTurn && completedDurationMs ? completedDurationMs : 0

  // live 且尚无 createdAt：用首次进入 live 的时刻（结束后 ref 保留，不重置）
  const liveStartRef = useRef<number | null>(null)
  if (isLiveTurn && liveStartRef.current == null) {
    liveStartRef.current = turnCreatedAt ?? Date.now()
  }
  const startedAt = turnCreatedAt ?? liveStartRef.current ?? undefined
  const elapsedMs = useLiveElapsedMs(startedAt, isLiveTurn)

  const statusLabel = isLiveTurn
    ? `运行 ${formatElapsedDuration(elapsedMs)}`
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
            <div className="agent-turn-mention-chip" title="本轮 @ 点名顺序">
              @{mentionLabels.join(' → @')}
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

      {subagentItems.map((it) =>
        it.message ? (
          <div key={it.key}>
            <MessageView message={it.message} />
          </div>
        ) : null,
      )}

      {showAnswerShell && (
        <div className="agent-answer-block">
          <Message from="assistant">
            <MessageContent>
              {displayedContent.trim() ? (
                <MessageResponse>{displayedContent}</MessageResponse>
              ) : processLive ? (
                <MessageLoading />
              ) : null}
            </MessageContent>
          </Message>
          {copyText || completionMs > 0 ? (
            <div className="agent-answer-toolbar">
              {copyText ? <MessageCopyButton text={copyText} /> : null}
              {completionMs > 0 ? (
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
