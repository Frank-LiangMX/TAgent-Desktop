/**
 * MoaDiscussionRoom — 圆桌研讨全屏讨论室
 *
 * 从主时间线 MoaDiscussionCard 进入，全屏覆盖 Chat 区域。
 * 复用 SubagentDetailView 的页面骨架（顶部「返回主会话」+ 标题 + 状态；
 * 见 chat.css .subagent-detail-*），主体按 entries 顺序平铺发言时间线。
 *
 * 主会话质感（T6）：
 * - 每个 speaker 带头像（自绘圆形首字母，颜色按 speakerId 稳定哈希；
 *   user 席「你」、moderator「总」）+ 模型名/角色徽章 + markdown 正文。
 * - 发言正文用与主会话一致的 MessageResponse（react-markdown + remarkPreserveBreaks），
 *   保留换行（whitespace-pre-wrap 语义）。
 * - 自动跟随最新发言滚动（用户手动上翻时不强制打断）。
 * - user 席右对齐高亮；phase=done 时底部展示总结人收口的「共识方案」。
 *
 * 用户席（§5.3）：底部输入框可插话（onInterject）与喊停（onStop）。
 * 本轮仅挂 UI 与回调占位 —— 接线（注入主进程 runMoADiscussion）留给后续任务；
 * 不传回调时输入框仍可输入，但发送/结束按钮置灰提示「接线中」。
 *
 * 设计依据：docs/plans/multi-runtime/10-session-agent-behavior-orchestration.md
 * §5.2 / §5.3 / §7.1 —— 「主时间线只放入口卡 → 点击进全屏讨论室」。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CaretDown } from '@phosphor-icons/react'
import { Button, MessageResponse, remarkPreserveBreaks } from '@tagent/ui'
import type {
  MoADiscussionPanel,
  MoADiscussionEntry,
  MoADiscussionPhase,
  MoADiscussionSpeaker,
} from '@tagent/shared'
import { cn } from '../../lib/utils'

interface MoaDiscussionRoomProps {
  panel: MoADiscussionPanel
  /** 返回主会话 */
  onBack: () => void
  /** 用户插话（接线后续任务；不传时输入框可输入但发送禁用） */
  onInterject?: (text: string) => void
  /** 用户喊停 / 结束讨论（接线后续任务；不传时按钮禁用） */
  onStop?: () => void
}

/** 稳定引用的 remark 插件数组，避免 MessageResponse 每帧重建管线 */
const DISCUSSION_REMARK_PLUGINS = [remarkPreserveBreaks]

const PHASE_META: Record<MoADiscussionPhase, { text: string; cls: string }> = {
  discussing: { text: '讨论中', cls: 'is-running' },
  finalizing: { text: '收口中', cls: 'is-running' },
  done: { text: '已完成', cls: 'is-completed' },
  error: { text: '出错', cls: 'is-failed' },
  cancelled: { text: '已取消', cls: 'is-stopped' },
}

/** 把毫秒时间戳格式化为 HH:MM:SS（短时讨论够用，免引入额外时间工具） */
function formatClock(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 讨论席头像色板（柔和、与主题协调；按 speakerId 稳定哈希取色） */
const SPEAKER_PALETTE = [
  'hsl(217, 55%, 55%)',
  'hsl(160, 48%, 42%)',
  'hsl(35, 72%, 55%)',
  'hsl(280, 48%, 60%)',
  'hsl(195, 58%, 50%)',
  'hsl(12, 64%, 58%)',
  'hsl(120, 42%, 46%)',
  'hsl(330, 55%, 60%)',
]

function hashIndex(s: string, mod: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h) % mod
}

export function MoaDiscussionRoom({
  panel,
  onBack,
  onInterject,
  onStop,
}: MoaDiscussionRoomProps): JSX.Element {
  const phaseMeta = PHASE_META[panel.phase]
  const isDone = panel.phase === 'done'
  const isFinalizing = panel.phase === 'finalizing'
  const showSummary = isDone && panel.summary != null && panel.summary.trim().length > 0
  const showComposer = panel.phase === 'discussing' || panel.phase === 'finalizing'
  // 过程态共享纪要（T11）：讨论过程中由纪要模型滚动生成；无则不渲染该区块。
  //   与终态「共识方案」(summary) 区分：纪要是压缩上下文用的过程产物，共识是收口结论。
  const showRunningSummary =
    panel.runningSummary != null && panel.runningSummary.trim().length > 0

  // speaker lookup（O(1)）
  const speakerById = useMemo(() => {
    const map = new Map<string, MoADiscussionSpeaker>()
    for (const s of panel.speakers) map.set(s.speakerId, s)
    return map
  }, [panel.speakers])

  // 自动跟随最新发言：subagent-detail__body 是滚动容器（overflow-y:auto）。
  // 用户手动上翻时不强制打断 —— 仅在仍贴近底部时跟随。
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottomRef.current = dist < 64
  }, [])

  // entries / summary / phase 变化时，若用户仍在底部则跟随到最新
  // （rAF 等 markdown/布局稳定后再设 scrollTop）
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !atBottomRef.current) return
    const raf = requestAnimationFrame(() => {
      if (atBottomRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [panel.entries, panel.summary, panel.phase])

  // 用户席输入框
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 讨论纪要区块折叠态（T11）：默认展开，让用户在讨论进行中即可看到滚动纪要；
  //   纪要随轮次更新（runningSummary 变化），折叠后不影响 timeline 滚动跟随。
  const [notesOpen, setNotesOpen] = useState(true)

  // textarea 自适应高度（受控组件：DOM 值在重渲染后更新，故用 effect 而非 onChange 内测量）
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [draft])

  const submit = useCallback(() => {
    const text = draft.trim()
    if (!text || !onInterject) return
    onInterject(text)
    setDraft('')
  }, [draft, onInterject])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submit()
      }
    },
    [submit],
  )

  const canSend = Boolean(onInterject) && draft.trim().length > 0
  const canStop = Boolean(onStop)

  return (
    <div className="subagent-detail">
      {/* 顶部栏：复用 subagent-detail 的 header/back/title/status 样式（chat.css） */}
      <div className="subagent-detail__header">
        <button type="button" className="subagent-detail__back" onClick={onBack}>
          <ArrowLeft size={14} weight="bold" />
          返回主会话
        </button>
        <div className="subagent-detail__title-wrap">
          <span className="subagent-detail__title-dot" aria-hidden />
          <span className="subagent-detail__title">{panel.presetName}</span>
          <span className={cn('subagent-detail__status', phaseMeta.cls)}>
            {phaseMeta.text}
          </span>
          <span className="subagent-detail__model-badge">
            第 {panel.currentRound}/{panel.roundLimit} 轮
          </span>
        </div>
        <div className="subagent-detail__actions" />
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn(
          'subagent-detail__body',
          showComposer && 'subagent-detail__body--with-composer',
        )}
      >
        {/* 议题：让讨论室的第一眼是「大家在聊什么」 */}
        {panel.topic && (
          <div className="subagent-detail__prompt">
            <div className="subagent-detail__prompt-toggle" style={{ cursor: 'default' }}>
              <span className="subagent-detail__prompt-label">议题</span>
              <span className="subagent-detail__prompt-summary">{panel.topic}</span>
            </div>
          </div>
        )}

        {/* 讨论纪要（T11）：议题下的可折叠区块，展示过程态共享纪要；无 runningSummary 不渲染。
            与底部「共识方案」区分：纪要是讨论过程中的滚动压缩，共识是收口结论。 */}
        {showRunningSummary && (
          <div className="moa-discussion-notes">
            <button
              type="button"
              className="moa-discussion-notes__toggle"
              onClick={() => setNotesOpen((v) => !v)}
              aria-expanded={notesOpen}
            >
              <CaretDown
                size={12}
                weight="bold"
                className={cn('moa-discussion-notes__caret', notesOpen && 'is-open')}
              />
              <span className="moa-discussion-notes__label">讨论纪要</span>
              <span className="moa-discussion-notes__hint">过程纪要，供对齐上下文</span>
            </button>
            {notesOpen && (
              <div className="moa-discussion-notes__body">
                <MessageResponse remarkPlugins={DISCUSSION_REMARK_PLUGINS}>
                  {panel.runningSummary ?? ''}
                </MessageResponse>
              </div>
            )}
          </div>
        )}

        {/* 发言时间线 */}
        <div className="subagent-detail__stream">
          {panel.entries.length === 0 ? (
            <div className="subagent-detail__empty">讨论即将开始…</div>
          ) : (
            panel.entries.map((entry) => (
              <EntryRow
                key={entry.entryId}
                entry={entry}
                speaker={speakerById.get(entry.speakerId)}
              />
            ))
          )}

          {/* 收口中：占位提示（区别于 done 的完整 summary） */}
          {isFinalizing && (
            <div className="subagent-detail__empty">总结人正在收口成共识方案…</div>
          )}

          {/* done：底部「共识方案」区（与设计文档 §7.1 一致） */}
          {showSummary && (
            <div className="moa-discussion-summary">
              <div className="moa-discussion-summary__title">共识方案</div>
              <div className="moa-discussion-summary__body">
                <MessageResponse remarkPlugins={DISCUSSION_REMARK_PLUGINS}>
                  {panel.summary ?? ''}
                </MessageResponse>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 用户席：插话 / 喊停（仅讨论中/收口中显示；本轮仅 UI + 回调占位，接线后续任务） */}
      {showComposer && (
        <div className="moa-discussion-composer">
          <textarea
            ref={textareaRef}
            className="moa-discussion-composer__input scrollbar-thin"
            placeholder="向圆桌发言…（回车发送）"
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="moa-discussion-composer__actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canStop}
              title={canStop ? '结束讨论：总结人立即收口' : '结束讨论（接线中）'}
              onClick={() => onStop?.()}
            >
              结束讨论
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!canSend}
              title={onInterject ? '发送（回车发送，Shift+回车换行）' : '发送（接线中）'}
              onClick={submit}
            >
              发送
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 一条发言：头像 + 名称/徽章 + markdown 正文（user 右对齐高亮、moderator「总结人」徽章） */
function EntryRow({
  entry,
  speaker,
}: {
  entry: MoADiscussionEntry
  speaker: MoADiscussionSpeaker | undefined
}): JSX.Element {
  const role = speaker?.role ?? 'participant'
  const name = speaker?.name ?? entry.speakerId
  const isUser = role === 'user'
  const isModerator = role === 'moderator'

  // 头像兜底：speaker 缺失时按 speakerId 合成一个 participant（取色/取首字母）
  const avatarSpeaker: MoADiscussionSpeaker = speaker ?? {
    speakerId: entry.speakerId,
    name: entry.speakerId,
    modelId: '',
    role: 'participant',
  }

  return (
    <div
      className={cn(
        'moa-discussion-entry',
        isUser && 'moa-discussion-entry--user',
        isModerator && 'moa-discussion-entry--moderator',
      )}
    >
      <SpeakerAvatar speaker={avatarSpeaker} />
      <div className="moa-discussion-entry__main">
        <div className="moa-discussion-entry__head">
          {isUser ? null : isModerator ? (
            <span className="moa-discussion-entry__role-tag">总结人</span>
          ) : (
            <>
              <span className="moa-discussion-entry__name">{name}</span>
              {speaker?.modelId ? (
                <span className="moa-discussion-entry__model">{speaker.modelId}</span>
              ) : null}
            </>
          )}
          <span className="moa-discussion-entry__turn">第 {entry.turn} 轮</span>
          {entry.createdAt ? (
            <span className="moa-discussion-entry__time">{formatClock(entry.createdAt)}</span>
          ) : null}
        </div>
        <div className="moa-discussion-entry__body">
          <MessageResponse remarkPlugins={DISCUSSION_REMARK_PLUGINS}>
            {entry.text}
          </MessageResponse>
        </div>
      </div>
    </div>
  )
}

/** 讨论席头像：user「你」、moderator「总」，participant 按首字母 + 稳定哈希色 */
function SpeakerAvatar({ speaker }: { speaker: MoADiscussionSpeaker }): JSX.Element {
  if (speaker.role === 'user') {
    return <div className="moa-discussion-avatar moa-discussion-avatar--user">你</div>
  }
  if (speaker.role === 'moderator') {
    return <div className="moa-discussion-avatar moa-discussion-avatar--moderator">总</div>
  }
  const color = SPEAKER_PALETTE[hashIndex(speaker.speakerId, SPEAKER_PALETTE.length)]
  const initial = (speaker.name.trim()[0] ?? '?').toUpperCase()
  return (
    <div className="moa-discussion-avatar" style={{ backgroundColor: color }}>
      {initial}
    </div>
  )
}

export const MemoMoaDiscussionRoom = memo(MoaDiscussionRoom)
