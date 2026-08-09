/**
 * AssistantTurnView — 一轮助手主线（对齐 General 的 turn 分层）
 *
 * - 模型铭牌 ×1 + 运行中计时 / 完成后时间
 * - full：过程区逐条 + 底部回答壳
 * - concise：Cursor 式时间线（外层「运行了」容器 + 过程链 + 最终正文）
 */
import { useMemo, useRef } from 'react'
import { useAtomValue } from 'jotai'
import {
  AppTooltip,
  Message,
  MessageContent,
  MessageLoading,
  MessageResponse,
  useSmoothStream,
} from '@tagent/ui'
import { ProcessGroupView } from './ProcessGroupView'
import { ConciseTimelineView, joinNarrativeTexts } from './ConciseTimelineView'
import {
  buildConciseTimeline,
  classifyToolFamily,
  collectTurnEditedFiles,
  type ConciseSegment,
} from './concise-timeline-model'
import { SubagentEntryCard } from './SubagentEntryCard'
import { TurnFilesChangedCard } from './TurnFilesChangedCard'
import {
  buildTurnPresentation,
  filterSubagentItems,
  findSubagentTaskTool,
  listSubagentEntryIds,
  type SessionRenderTurn,
  type TurnSourceItem,
  type TurnStreamState,
} from './session-turn-model'
import type { TaskCardState } from './subagent-ui-model'
import type { TurnDuration } from '@tagent/shared'
import { MessageCopyButton } from './MessageCopyButton'
import {
  formatElapsedDuration,
  formatMessageTime,
  useLiveElapsedMs,
} from '../../lib/time-utils'
import { cn } from '../../lib/utils'
import { SpeakerHeader, resolveSpeakerName } from './SpeakerHeader'
import { chatProcessDisplayModeAtom } from '../../atoms/chat-display-prefs'

interface AssistantTurnViewProps {
  turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }>
  /** 当前会话仍在跑且本 turn 是最新一轮（含工具间隙） */
  isLiveTurn?: boolean
  /**
   * 是否为会话末尾的 assistant-turn。
   * 简洁模式：live 结束后若仍为 true 保持执行块展开；发新一轮 / 切会话后折叠。
   */
  isLatestAssistantTurn?: boolean
  /** 会话级流式缓冲（live 轮 delta 累积，不绑 DisplayItem） */
  streamState?: TurnStreamState
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
  isLatestAssistantTurn = false,
  streamState,
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
  // 过程展示模式：concise → 时间线投影；full → 过程区 + 回答壳
  const processDisplayMode = useAtomValue(chatProcessDisplayModeAtom)
  const isConcise = processDisplayMode === 'concise'
  const presentation = buildTurnPresentation(
    { ...turn, items: mainItems },
    {
      isLiveTurn,
      streamState: isLiveTurn ? streamState : undefined,
      displayMode: processDisplayMode,
    },
  )

  const processLive = isLiveTurn

  // concise：Cursor 式时间线（text 已留在 process）
  const conciseSegments = useMemo(
    () =>
      isConcise
        ? buildConciseTimeline(presentation.process, {
            answerTexts: presentation.answerTexts,
            streamingText: presentation.streamingText,
            isLive: processLive,
          })
        : [],
    [
      isConcise,
      presentation.process,
      presentation.answerTexts,
      presentation.streamingText,
      processLive,
    ],
  )

  // W1.4：本轮曾经 live 即记 true（用于打字机尾段防闪）。历史轮挂载时 isLiveTurn 恒 false，
  // 不会置位——避免历史答案被误当流式重新逐字。
  const wasLiveRef = useRef(false)
  if (isLiveTurn) wasLiveRef.current = true

  // full 回答正文：流式与落盘取「更长且互为前缀」的那份。
  const answerFull = presentation.answerTexts[0] ?? ''
  const streamText = presentation.streamingText ?? ''
  const content = resolveAnswerContent(answerFull, streamText)
  const displayedLenRef = useRef(0)
  const needsTypewriter =
    !isConcise &&
    (presentation.isStreaming ||
      Boolean(streamText) ||
      (isLiveTurn && Boolean(content) && Boolean(streamText || presentation.isStreaming)) ||
      (wasLiveRef.current && content.length > displayedLenRef.current))
  const { displayedContent } = useSmoothStream({
    content: isConcise ? '' : content,
    isStreaming: needsTypewriter,
  })
  if (!isConcise) displayedLenRef.current = displayedContent.length

  // full：有过程块且尚无交付 text 时不展示空回答壳
  const showAnswerShell =
    !isConcise &&
    (Boolean(content.trim()) ||
      (processLive && presentation.process.length === 0 && !content))

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

  // 完成/中断/出错：句尾统一「已中断|出错|完成 · 耗时 · 墙钟」；标题行仅 live 计时
  const completionMs = !isLiveTurn && completedDuration ? completedDuration.ms : 0
  const endedBy = completedDuration?.endedBy
  const completionLabel =
    endedBy === 'stopped' ? '已中断' : endedBy === 'error' ? '出错' : '完成'

  // live 且尚无 createdAt：用首次进入 live 的时刻（结束后 ref 保留，不重置）
  const liveStartRef = useRef<number | null>(null)
  if (isLiveTurn && liveStartRef.current == null) {
    liveStartRef.current = turnCreatedAt ?? Date.now()
  }
  const startedAt = turnCreatedAt ?? liveStartRef.current ?? undefined
  const elapsedMs = useLiveElapsedMs(startedAt, isLiveTurn)

  // concise 标题用：live 取当前已过秒；完成后优先 completedDuration
  const thinkingDurationSec = isLiveTurn
    ? Math.floor(elapsedMs / 1000)
    : completedDuration
      ? Math.max(1, Math.round(completedDuration.ms / 1000))
      : undefined

  const statusLabel = isConcise
    ? '' // concise：时长进「运行了」外层容器，标题行不再重复
    : isLiveTurn
      ? `运行 ${formatElapsedDuration(elapsedMs)}`
      : ''

  const workedMs = isLiveTurn
    ? elapsedMs
    : completedDuration
      ? completedDuration.ms
      : turnCreatedAt && turnFinishedAt && turnFinishedAt >= turnCreatedAt
        ? turnFinishedAt - turnCreatedAt
        : 0

  // 墙钟：优先 起点+耗时（中断/出错时末条 assistant.createdAt 可能仍是中段）
  const endClockAt =
    !isLiveTurn && startedAt != null && completionMs > 0
      ? startedAt + completionMs
      : turnFinishedAt

  // 复制：concise 拼 narrative；full 用回答壳全文
  const copyText = isConcise
    ? joinNarrativeTexts(conciseSegments).trim()
    : (answerFull || displayedContent || content).trim()

  // 句尾状态：完成 / 已中断 / 出错 + 耗时 + 墙钟（concise / full 共用）
  const endFooter =
    !processLive && (completionMs > 0 || endClockAt)
      ? {
          label: completionLabel,
          duration:
            completionMs > 0 ? formatElapsedDuration(completionMs) : undefined,
          clock: endClockAt ? formatMessageTime(endClockAt) : undefined,
          kind: endedBy ?? 'complete',
        }
      : null

  // Cursor 式 Files Changed：回合结束后从编辑工具聚合
  const editedFiles = useMemo(
    () => (!processLive ? collectTurnEditedFiles(presentation.process) : []),
    [processLive, presentation.process],
  )
  const filesCard =
    editedFiles.length > 0 ? <TurnFilesChangedCard files={editedFiles} /> : null

  const speakerName = resolveSpeakerName(mentionLabels, presentation.modelId)
  const showSpeakerRow =
    Boolean(presentation.modelId) ||
    Boolean(statusLabel) ||
    Boolean(mentionLabels && mentionLabels.length > 0) ||
    presentation.process.length > 0 ||
    Boolean(content.trim())

  return (
    <div className="agent-turn flex flex-col" data-speaker={speakerName}>
      {showSpeakerRow ? (
        <SpeakerHeader
          name={speakerName}
          modelId={presentation.modelId}
          statusLabel={statusLabel || undefined}
          isLive={isLiveTurn}
          handoffLabels={mentionLabels}
          className="mb-2"
        />
      ) : null}

      {isConcise ? (
        <>
          <ConciseTimelineView
            segments={conciseSegments}
            isLive={processLive}
            isLatestTurn={isLatestAssistantTurn}
            workedMs={workedMs}
            getStageExtras={
              subagentEntryIds.length > 0
                ? (seg) => {
                    const hostKey = pickSubagentHostStageKey(conciseSegments)
                    if (hostKey !== seg.key) return null
                    return renderConciseSubagents(
                      subagentEntryIds,
                      turn.items,
                      subagentCards,
                      processLive,
                      onOpenSubagent,
                    )
                  }
                : undefined
            }
            processExtras={
              // 尚无阶段时仍展示子代理行（挂在运行队列末尾）
              subagentEntryIds.length > 0 &&
              !conciseSegments.some((s) => s.kind === 'work_stage')
                ? renderConciseSubagents(
                    subagentEntryIds,
                    turn.items,
                    subagentCards,
                    processLive,
                    onOpenSubagent,
                  )
                : undefined
            }
          />
          {filesCard}
          {!processLive && (copyText || endFooter) ? (
            <div className="agent-answer-toolbar">
              {copyText ? <MessageCopyButton text={copyText} /> : null}
              {endFooter ? <TurnEndFooter {...endFooter} /> : null}
            </div>
          ) : null}
        </>
      ) : (
        presentation.process.length > 0 && (
          <div className="agent-turn-process">
            <ProcessGroupView
              process={presentation.process}
              isLive={processLive}
              autoExpandWhenLive
              displayMode="full"
              thinkingDurationSec={thinkingDurationSec}
              hasFinalOutput={Boolean(content.trim())}
            />
          </div>
        )
      )}

      {!isConcise &&
        subagentEntryIds.map((parentToolUseId) => {
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

      {/* full：无回答壳时仍展示 Files Changed */}
      {!isConcise && !showAnswerShell ? filesCard : null}

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
          {filesCard}
          {!processLive && (copyText || endFooter) ? (
            <div className="agent-answer-toolbar">
              {copyText ? <MessageCopyButton text={copyText} /> : null}
              {endFooter ? <TurnEndFooter {...endFooter} /> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** 消息句尾：完成 / 已中断 / 出错 + 耗时 + 墙钟时间 */
function TurnEndFooter({
  label,
  duration,
  clock,
  kind,
}: {
  label: string
  duration?: string
  clock?: string
  kind: 'complete' | 'stopped' | 'error'
}): JSX.Element {
  const parts = [label, duration, clock].filter(Boolean)
  return (
    <AppTooltip label={parts.join(' · ')}>
      <span
        className={cn(
          'agent-answer-time',
          kind === 'stopped' && 'agent-answer-time--stopped',
          kind === 'error' && 'agent-answer-time--error',
        )}
      >
        {parts.join(' · ')}
      </span>
    </AppTooltip>
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

/** 子代理优先挂探索/搜索阶段（对齐 Cursor）；否则挂最后一个阶段 */
function pickSubagentHostStageKey(segments: ConciseSegment[]): string | null {
  const stages = segments.filter(
    (s): s is Extract<ConciseSegment, { kind: 'work_stage' }> => s.kind === 'work_stage',
  )
  if (stages.length === 0) return null
  for (let i = stages.length - 1; i >= 0; i--) {
    const stage = stages[i]!
    const hasExplore = stage.tools.some((t) => {
      const f = classifyToolFamily(t.tool.name)
      return f === 'explore' || f === 'search'
    })
    if (hasExplore) return stage.key
  }
  return stages[stages.length - 1]!.key
}

function renderConciseSubagents(
  ids: string[],
  items: TurnSourceItem[],
  cards: Map<string, TaskCardState> | undefined,
  isLive: boolean,
  onOpen: (parentToolUseId: string) => void,
): JSX.Element {
  return (
    <>
      {ids.map((parentToolUseId) => {
        const group = filterSubagentItems(items, parentToolUseId).filter(
          (it) => it.message?.type === 'assistant',
        )
        return (
          <SubagentEntryCard
            key={parentToolUseId}
            variant="timeline"
            items={group}
            card={cards?.get(parentToolUseId)}
            launcher={findSubagentTaskTool(items, parentToolUseId)}
            isLive={isLive}
            onOpen={() => onOpen(parentToolUseId)}
          />
        )
      })}
    </>
  )
}
