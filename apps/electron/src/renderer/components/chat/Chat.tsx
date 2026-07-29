/**
 * 会话页核心
 *
 * 吃 TAgentDesktopStreamPayload（IPC 流式）+ TAgentMessage IR 渲染。
 * 消息区用 Conversation 容器（自动钉底），输入区用 TipTap ChatInput。
 * 模型：首条消息只绑定运行内核（KSCC / 外部），同内核内渠道与模型可继续切换。
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { StickToBottomContext } from 'use-stick-to-bottom'
import type { TAgentDesktopStreamPayload, TAgentMessage, TAgentPermissionMode, SubagentEagerness } from '@tagent/shared'
import {
  resolveChannelDefaultModelId,
  sdkMessageToIR,
  TAGENT_DEFAULT_PERMISSION_MODE,
  type TAgentUsage,
} from '@tagent/shared'
import { ContextUsageBadge, type ContextUsageSnapshotView } from './ContextUsageBadge'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ScrollMinimap,
  type MinimapItem,
  Message,
  MessageContent,
  MessageResponse,
  MessageLoading,
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
  Button,
} from '@tagent/ui'
import { ArrowUp, Square, Shrink } from 'lucide-react'
import {
  COMPACTION_IN_PROGRESS_LABEL,
  getCompactBoundaryLabel,
} from '@tagent/shared'
import { MessageView } from './MessageView'
import { ChatInput, type ChatInputHandle } from './ChatInput'
import { ModelSelector } from './ModelSelector'
import { PermissionModeSelector } from './PermissionModeSelector'
import { SubagentEagernessSelector } from './SubagentEagernessSelector'
import {
  resolveEagerness,
  reduceTaskEvent,
  type TaskCardState,
  type TaskCardEvent,
} from './subagent-ui-model'
import { PermissionBanner } from '../permission/PermissionBanner'
import { ScrollPositionManager } from '../shell/ScrollPositionManager'
import {
  channelsAtom,
  selectedModelSelectionAtom,
  bumpSessionsRefreshAtom,
} from '../../atoms/channel-atoms'
import {
  getChannelCoreKind,
  type ChannelCoreKind,
  type ModelSelection,
} from '../../atoms/model-selection'
import { tabsAtom } from '../../atoms/tabs'

interface SessionMeta {
  id: string
  title: string
  workspaceId?: string
  modelId?: string
  channelId?: string
}

interface StreamEventEnvelope {
  sessionId: string
  payload: TAgentDesktopStreamPayload
}

/** 一轮显示项：完整消息或流式增量 */
interface DisplayItem {
  /** 稳定 key */
  key: string
  /** 完整消息（IR） */
  message?: TAgentMessage
  /** 流式追加中的文本（stream_text_delta 累积） */
  streamingText?: string
  /** 流式 thinking 累积 */
  streamingThinking?: string
  /** 是否流式中 */
  streaming?: boolean
  /** 子代理任务卡片（task_started/progress/notification 状态机，独立小卡片） */
  taskCard?: TaskCardState
  /** 上下文压缩状态行 */
  compactStatus?: 'compacting' | 'complete'
  compactTrigger?: 'auto' | 'manual'
}

export function Chat({ session }: { session: SessionMeta }): JSX.Element {
  const sessionId = session.id
  const [items, setItems] = useState<DisplayItem[]>([])
  const [running, setRunning] = useState(false)
  /** 历史加载完成的标志：false 时 Conversation resize=instant（无动画）+ ScrollPositionManager 恢复位置 */
  const [scrollReady, setScrollReady] = useState(false)
  /** 虚拟化：当前挂载的消息条数（从尾部切）。20 首 batch，idle 帧递增 40/批，全挂完置 Infinity。
   * 保近期：底部对话区永远全量渲染，旧的渐进补齐，超长会话不卡。 */
  const [visibleCount, setVisibleCount] = useState<number>(20)
  const [selectionOverride, setSelectionOverride] = useState<ModelSelection | null>(null)
  const [sentCoreKind, setSentCoreKind] = useState<ChannelCoreKind | null>(null)
  /** 会话当前权限模式（默认 auto；切会话 key 重建后重置。运行中切换即时生效） */
  const [permissionMode, setPermissionMode] = useState<TAgentPermissionMode>(TAGENT_DEFAULT_PERMISSION_MODE)
  /** 子代理委派积极性（默认 conservative；切会话 key 重建后重置，挂载时回显持久化值。下次发送注入 kscc 生效） */
  const [subagentEagerness, setSubagentEagerness] = useState<SubagentEagerness>('conservative')
  /** 最近一轮 usage（仅外部/Pi 展示；kscc 不采信） */
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshotView | null>(null)
  const [isCompactingUi, setIsCompactingUi] = useState(false)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  const applyUsage = (usage: TAgentUsage | undefined, contextWindow = 128_000): void => {
    if (!usage || usage.inputTokens <= 0) return
    setContextUsage((prev) => ({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      // 保留上一轮窗口，避免闪烁；首轮用默认（与 Pi 占位 Model 一致）
      contextWindow: prev?.contextWindow && prev.contextWindow > 0 ? prev.contextWindow : contextWindow,
    }))
  }

  // 切会话时清空占用环（Chat 若被 key 重建则多余无害）
  useEffect(() => {
    setContextUsage(null)
    setIsCompactingUi(false)
  }, [sessionId])
  const scrollContextRef = useRef<StickToBottomContext | null>(null)
  const itemIdxRef = useRef(0)
  const streamingRef = useRef<DisplayItem | null>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)

  const channels = useAtomValue(channelsAtom)
  const selectedModelSelection = useAtomValue(selectedModelSelectionAtom)
  const setSelectedModelSelection = useSetAtom(selectedModelSelectionAtom)
  const bumpRefresh = useSetAtom(bumpSessionsRefreshAtom)
  const setTabs = useSetAtom(tabsAtom)

  // 构造 ScrollMinimap 的 items：按 user 分组，每项 = 用户消息 + 紧随的助手回复（对齐 TAgent_General）
  // 面板里用户气泡右对齐、助手 replyPreview 气泡左对齐。
  const minimapItems = useMemo<MinimapItem[]>(() => {
    const msgs = items.filter((it) => it.message).map((it) => it.message!)
    const result: MinimapItem[] = []
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (!m || m.type !== 'user') continue
      const userText = firstText(m) ?? ''
      // 找紧随的下一条 assistant 作 replyPreview
      let replyPreview: string | undefined
      let replyModel: string | undefined
      for (let j = i + 1; j < msgs.length; j++) {
        const next = msgs[j]
        if (!next) continue
        if (next.type === 'user') break
        if (next.type === 'assistant') {
          const t = firstText(next)
          if (t) replyPreview = t.replace(/\s+/g, ' ').trim().slice(0, 120)
          replyModel = next.modelId
          break
        }
      }
      result.push({
        id: items[i]!.key,
        role: 'user',
        preview: userText.slice(0, 160) || '用户消息',
        replyPreview,
        model: replyModel,
      })
    }
    return result
  }, [items])

  /** 虚拟化：是否已全挂（visibleCount 追上 items.length 或 Infinity） */
  const fullyMounted = visibleCount >= items.length
  /** 实际挂载数（Infinity 当 items.length） */
  const effectiveVisible = visibleCount >= items.length ? items.length : visibleCount
  /** 挂载窗口起点（旧消息条数，未挂载） */
  const visibleStartOffset = Math.max(0, items.length - effectiveVisible)
  /** 虚拟化切片：尾部 effectiveVisible 条（最新在底） */
  const visibleItems = items.slice(visibleStartOffset)
  /** scrollReady 门控：历史加载完 && 全挂完才恢复滚动位置（对齐旧版 scrollReady = ready && fullyMounted） */
  const effectiveScrollReady = scrollReady && fullyMounted

  // 选择优先级：本会话最近选择 > 持久化会话选择 > 新会话全局选择。
  // 旧会话只有 channelId 没有 modelId 时，用该渠道当前默认模型做一次迁移。
  const sessionChannel = channels.find((channel) => channel.id === session.channelId)
  const sessionModelId = session.modelId ?? resolveChannelDefaultModelId(sessionChannel)
  const persistedSelection = session.channelId && sessionModelId
    ? { channelId: session.channelId, modelId: sessionModelId }
    : null
  const effectiveSelection = selectionOverride ?? persistedSelection ?? selectedModelSelection
  const lockedKind = sessionChannel ? getChannelCoreKind(sessionChannel) : sentCoreKind

  // 切换会话时加载历史。滚动位置恢复交给 ScrollPositionManager（Conversation 内部），
  // 它用 useLayoutEffect + stopScroll + 直接设 scrollTop（无动画、无可见滚动过程）。
  useEffect(() => {
    sessionIdRef.current = sessionId
    setItems([])
    setRunning(false)
    setScrollReady(false)
    setVisibleCount(20) // 虚拟化：切会话重置首批 20
    streamingRef.current = null
    itemIdxRef.current = 0
    setSubagentEagerness('conservative') // 切会话重置，下面异步回显持久化值
    void (async () => {
      const history = (await window.electronAPI.getMessages(sessionId)) as unknown[]
      const irItems: DisplayItem[] = []
      for (const raw of history) {
        const { message } = sdkMessageToIR(raw as never)
        if (message) {
          irItems.push({ key: `h${itemIdxRef.current++}`, message })
        }
      }
      setItems(irItems)
      setScrollReady(true)
      // 回显持久化的子代理委派积极性（新会话无 meta → resolveEagerness 回退默认 conservative）
      try {
        const metas = (await window.electronAPI.listSessions()) as Array<{
          id: string
          subagentEagerness?: SubagentEagerness
        }>
        const persisted = metas.find((m) => m.id === sessionId)
        if (persisted) setSubagentEagerness(resolveEagerness(persisted))
      } catch {
        /* 回显失败不影响主流程，沿用默认 conservative */
      }
    })()
  }, [sessionId])

  // main 会话滚动时关闭滚动内容自身的 backdrop-filter，避免 GPU 合成滞后产生拖影。
  // 输入框是滚动容器的兄弟节点，不受 is-scrolling 选择器影响，玻璃遮挡保持不变。
  useEffect(() => {
    const scrollEl = scrollContextRef.current?.scrollRef.current
    if (!scrollEl) return

    let scrollTimer = 0
    const handleScroll = (): void => {
      scrollEl.classList.add('is-scrolling')
      window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        scrollEl.classList.remove('is-scrolling')
      }, 150)
    }

    scrollEl.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollEl.removeEventListener('scroll', handleScroll)
      window.clearTimeout(scrollTimer)
      scrollEl.classList.remove('is-scrolling')
    }
  }, [sessionId])

  // 虚拟化分批递增：未全挂时，idle 帧每批 +40 补齐旧消息（保近期，底部对话不受影响）
  useEffect(() => {
    if (fullyMounted) return
    if (items.length === 0) return
    // requestIdleCallback 兼容（Electron Chromium 原生支持，fallback setTimeout）
    const scheduleIdle: (cb: () => void) => number =
      typeof window !== 'undefined' && 'requestIdleCallback' in window
        ? window.requestIdleCallback
        : (cb) => window.setTimeout(cb, 16) as unknown as number
    const cancelIdle: (h: number) => void =
      typeof window !== 'undefined' && 'cancelIdleCallback' in window
        ? window.cancelIdleCallback
        : (h) => window.clearTimeout(h)
    const handle = scheduleIdle(() => {
      setVisibleCount((prev) => {
        if (prev >= items.length) return prev // 已全挂，不动
        const next = Math.min(prev + 40, items.length)
        return next >= items.length ? Number.POSITIVE_INFINITY : next // 全挂完置 Infinity，流式追加走全量分支
      })
    })
    return () => cancelIdle(handle)
  }, [visibleCount, items.length, fullyMounted])

  // 监听流式事件
  useEffect(() => {
    const off = window.electronAPI.onStreamEvent((payload: unknown) => {
      const env = payload as StreamEventEnvelope
      if (env.sessionId !== sessionIdRef.current) return
      handlePayload(env.payload)
    })
    return off
  }, [])

  /**
   * 任务卡片 apply：existing=undefined 新建（分配稳定 key），否则就地更新 taskCard
   * （保留 message / streamingText 等其他字段）。reduceTaskEvent 的承载项工厂。
   */
  const taskCardApply = (
    existing: DisplayItem | undefined,
    card: TaskCardState,
  ): DisplayItem =>
    existing ? { ...existing, taskCard: card } : { key: `task${itemIdxRef.current++}`, taskCard: card }

  const handlePayload = (p: TAgentDesktopStreamPayload): void => {
    if (p.kind === 'sdk_message') {
      if (streamingRef.current) {
        streamingRef.current = null
      }
      // assistant.usage 更新底栏（Pi）；kscc 圆环不展示，但状态可写无害
      if (p.message.type === 'assistant' && p.message.usage) {
        applyUsage(p.message.usage)
      }
      setItems((prev) => [...prev, { key: `m${itemIdxRef.current++}`, message: p.message }])
    } else if (p.kind === 'result') {
      if (p.usage) applyUsage(p.usage)
      streamingRef.current = null
      setRunning(false)
      bumpRefresh()
    } else if (p.kind === 'stream_text_delta') {
      setItems((prev) => {
        let stream = streamingRef.current
        if (!stream) {
          stream = { key: `s${itemIdxRef.current++}`, streaming: true, streamingText: '' }
          streamingRef.current = stream
          return [...prev, stream]
        }
        stream.streamingText = (stream.streamingText ?? '') + p.text
        return [...prev]
      })
    } else if (p.kind === 'stream_thinking_delta') {
      setItems((prev) => {
        let stream = streamingRef.current
        if (!stream) {
          stream = { key: `s${itemIdxRef.current++}`, streaming: true, streamingThinking: '' }
          streamingRef.current = stream
          return [...prev, stream]
        }
        stream.streamingThinking = (stream.streamingThinking ?? '') + p.text
        return [...prev]
      })
    } else if (p.kind === 'tagent_event') {
      const evt = p.event as {
        type: string
        message?: string
        taskId?: string
        toolUseId?: string
        description?: string
        status?: string
        summary?: string
        lastToolName?: string
      }
      if (evt.type === 'turn_end') {
        streamingRef.current = null
        setRunning(false)
        bumpRefresh()
      } else if (evt.type === 'session_error') {
        setItems((prev) => [
          ...prev,
          {
            key: `e${itemIdxRef.current++}`,
            message: {
              type: 'assistant',
              content: [{ type: 'text', text: `[错误] ${evt.message ?? ''}` }],
            } as TAgentMessage,
          },
        ])
        setRunning(false)
      } else if (evt.type === 'compacting') {
        setIsCompactingUi(true)
        setItems((prev) => [
          ...prev,
          {
            key: `c${itemIdxRef.current++}`,
            compactStatus: 'compacting' as const,
          },
        ])
      } else if (evt.type === 'compact_complete') {
        setIsCompactingUi(false)
        const trigger = (evt as { trigger?: 'auto' | 'manual' }).trigger
        setItems((prev) => {
          // 去掉进行中的占位，换成完成分隔
          const filtered = prev.filter((it) => it.compactStatus !== 'compacting')
          return [
            ...filtered,
            {
              key: `c${itemIdxRef.current++}`,
              compactStatus: 'complete' as const,
              compactTrigger: trigger,
            },
          ]
        })
      } else if (evt.type === 'task_started') {
        // 子代理启动：upsert 任务卡片（running），不再塞 assistant 文本气泡
        const event: TaskCardEvent = {
          type: 'task_started',
          taskId: evt.taskId ?? '',
          toolUseId: evt.toolUseId,
          description: evt.description ?? '',
        }
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply))
      } else if (evt.type === 'task_progress') {
        // 子代理进度：更新同一张任务卡片的 lastToolName / progressText，不新增气泡
        const event: TaskCardEvent = {
          type: 'task_progress',
          taskId: evt.taskId,
          toolUseId: evt.toolUseId,
          description: evt.description,
          lastToolName: evt.lastToolName,
        }
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply))
      } else if (evt.type === 'task_notification') {
        // 子代理收口：置 status + summary，清空进度文案
        const status: TaskCardState['status'] =
          evt.status === 'completed' || evt.status === 'failed' || evt.status === 'stopped'
            ? evt.status
            : 'stopped'
        const event: TaskCardEvent = {
          type: 'task_notification',
          taskId: evt.taskId ?? '',
          toolUseId: evt.toolUseId,
          status,
          summary: evt.summary ?? '',
        }
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply))
      }
    }
  }

  const compactContext = async (): Promise<void> => {
    try {
      const res = await window.electronAPI.compactSession(sessionIdRef.current)
      if (!res.ok) {
        alert(res.reason ?? '压缩失败')
        return
      }
      if (!res.compacted) {
        alert(res.reason ?? '当前无需压缩')
      }
      // 成功时 compact_complete 事件由主进程流推入 items
    } catch (err) {
      alert(err instanceof Error ? err.message : '压缩失败')
    }
  }

  const send = async (): Promise<void> => {
    const text = chatInputRef.current?.getText().trim()
    if (!text || running) return
    if (!effectiveSelection) {
      alert('没有可用模型，请先在「设置 → 渠道」中启用渠道和模型')
      return
    }
    const channel = channels.find((item) => item.id === effectiveSelection.channelId)
    const model = channel?.models.find((item) => item.id === effectiveSelection.modelId)
    if (!channel?.enabled || !model?.enabled) {
      alert('当前渠道或模型已停用，请选择同一运行区域内的可用模型')
      return
    }
    chatInputRef.current?.clear()
    setRunning(true)
    try {
      const res = await window.electronAPI.sendMessage({
        sessionId: sessionIdRef.current,
        prompt: text,
        channelId: effectiveSelection.channelId,
        model: effectiveSelection.modelId,
        workspaceId: session.workspaceId,
      })
      // IPC 返回失败：没有 result 事件会来，必须在这里解除 running，否则输入框永久 disabled
      if (res && !res.ok) {
        alert(`发送失败：${res.error ?? '未知错误'}`)
        setRunning(false)
      } else {
        const coreKind = getChannelCoreKind(channel)
        setSelectionOverride(effectiveSelection)
        setSentCoreKind(coreKind)
        // 将本轮真实使用的渠道 / 模型同步到当前标签，切换标签后仍展示最新选择。
        setTabs((prev) => prev.map((tab) => (
          tab.sessionId === sessionIdRef.current
            ? {
                ...tab,
                channelId: effectiveSelection.channelId,
                modelId: effectiveSelection.modelId,
              }
            : tab
        )))
      }
      bumpRefresh()
    } catch (err) {
      // IPC 异常：同上，防止 running 卡死
      console.error('[Chat] sendMessage 异常:', err)
      alert(`发送异常：${err instanceof Error ? err.message : String(err)}`)
      setRunning(false)
    }
  }

  return (
    <div className="relative h-full min-h-0">
      {/* 消息区：占满全高，自动钉底，680px 居中线程。
       * 底部 padding 给浮岛 composer 留位，最后一条不被盖死 */}
      <Conversation
        className="absolute inset-0 min-h-0"
        contextRef={scrollContextRef}
        resize={effectiveScrollReady ? 'smooth' : 'instant'}
      >
        <ConversationContent className="px-4 pt-2 pb-44">
          {items.length === 0 && !running ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground/60">输入消息开始对话</p>
            </div>
          ) : (
            <div className="tagent-thread">
              {/* 虚拟化加载提示：未全挂时常驻显示（说清楚在加载、剩多少条），不闪烁 */}
              {!fullyMounted && items.length > 0 && (
                <div
                  className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
                  <span>正在加载更早的 {items.length - effectiveVisible} 条…</span>
                </div>
              )}
              {visibleItems.map((item) => (
                <ItemView key={item.key} item={item} />
              ))}
              {running && <MessageLoading />}
            </div>
          )}
        </ConversationContent>
        {/* 切会话恢复滚动位置（无动画、不打断查历史），对齐 TAgent_General ScrollPositionManager */}
        <ScrollPositionManager id={sessionId} ready={effectiveScrollReady} />
        <ScrollMinimap items={minimapItems} />
        <ConversationScrollButton />
      </Conversation>

      {/* 权限确认横幅（工具写操作/危险命令时弹） */}
      <PermissionBanner sessionId={sessionId} />

      {/* 输入区：composer 玻璃浮岛 absolute 浮在底部，680px 居中。
       * 消息从下方滚过透出（透明玻璃 + blur），对齐 TAgent_General 浮岛布局 */}
      <div
        className="pointer-events-none absolute inset-x-0 px-4 pt-2"
        style={{ bottom: 'var(--shell-band-inset-bottom, 24px)' }}
      >
        <div className="pointer-events-auto mx-auto max-w-[680px]">
          <ChatInput
            ref={chatInputRef}
            onSubmit={() => void send()}
            disabled={running}
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
            footer={
              <div className="flex items-center justify-between px-2 pb-2 pt-1">
                <div className="flex items-center gap-1">
                  <ModelSelector
                    selection={effectiveSelection}
                    lockedKind={lockedKind}
                    onSelect={(nextSelection) => {
                      setSelectionOverride(nextSelection)
                      setSelectedModelSelection(nextSelection)
                    }}
                  />
                  <PermissionModeSelector
                    mode={permissionMode}
                    onChange={async (m) => {
                      setPermissionMode(m)
                      await window.electronAPI.setSessionPermissionMode(sessionId, m)
                    }}
                  />
                  <SubagentEagernessSelector
                    eagerness={subagentEagerness}
                    onChange={async (level) => {
                      setSubagentEagerness(level)
                      // 持久化到会话 meta；下次发送时主进程注入 kscc systemPrompt append 生效
                      await window.electronAPI.updateSessionMeta(sessionId, { subagentEagerness: level })
                    }}
                  />
                  {/* 手动压缩（Pi 核；无活跃 Agent 时主进程返回 reason） */}
                  {!running && lockedKind === 'external' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 rounded-full px-2 text-[11px] text-muted-foreground"
                      title="压缩上下文"
                      onClick={() => void compactContext()}
                    >
                      <Shrink className="size-3.5" />
                      压缩
                    </Button>
                  )}
                  {/* Context 占用环：仅外部/Pi；kscc 占用率不可信，不展示 */}
                  {lockedKind === 'external' && (
                    <ContextUsageBadge
                      usage={contextUsage}
                      isCompacting={isCompactingUi}
                      onCompact={() => void compactContext()}
                    />
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {running && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 rounded-full text-destructive hover:bg-destructive/10"
                      onClick={() => window.electronAPI.stopAgent(sessionIdRef.current)}
                    >
                      <Square className="size-4 fill-current" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    className="size-9 rounded-full"
                    disabled={running}
                    onClick={() => void send()}
                  >
                    <ArrowUp className="size-5" />
                  </Button>
                </div>
              </div>
            }
          />
        </div>
      </div>
    </div>
  )
}

/** 显示项渲染 */
function ItemView({ item }: { item: DisplayItem }): JSX.Element {
  // 子代理任务卡片（task_started/progress/notification 状态机，独立小卡片）
  if (item.taskCard) {
    return (
      <div data-message-id={item.key}>
        <TaskCardView card={item.taskCard} />
      </div>
    )
  }

  // 上下文压缩状态行
  if (item.compactStatus === 'compacting') {
    return (
      <div data-message-id={item.key} className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-primary/60" />
        {COMPACTION_IN_PROGRESS_LABEL}
      </div>
    )
  }
  if (item.compactStatus === 'complete') {
    return (
      <div data-message-id={item.key} className="relative flex items-center justify-center py-2">
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
        <span className="mx-3 text-xs text-muted-foreground select-none">
          {getCompactBoundaryLabel(
            item.compactTrigger ? { trigger: item.compactTrigger } : undefined,
          )}
        </span>
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      </div>
    )
  }

  // 完整消息（IR）→ MessageView（挂 data-message-id 供 ScrollMinimap 定位）
  if (item.message) {
    return (
      <div data-message-id={item.key}>
        <MessageView message={item.message} />
      </div>
    )
  }

  // 流式占位
  return (
    <div data-message-id={item.key}>
      <Message from="assistant">
        <MessageContent>
          {/* thinking 流式 */}
          {item.streamingThinking && (
            <Reasoning isStreaming defaultOpen>
              <ReasoningTrigger />
              <ReasoningContent>{item.streamingThinking}</ReasoningContent>
            </Reasoning>
          )}
          {/* text 流式：typewriter 逐字挤出，平滑端点粗粒度分块（~500ms/块）的顿挫感 */}
          {item.streamingText && <TypewriterText text={item.streamingText} />}
          {/* 无内容时显示加载 */}
          {!item.streamingText && !item.streamingThinking && <MessageLoading />}
        </MessageContent>
    </Message>
    </div>
  )
}

/**
 * TaskCardView — 子代理任务卡片
 *
 * 圆角边框 + 状态色圆点（running 脉冲）+ 可选进度文案 / 收口摘要。
 * 放在消息流中，承载 task_started → task_progress → task_notification 生命周期。
 */
const TASK_CARD_STATUS: Record<TaskCardState['status'], {
  label: string
  box: string
  dot: string
  text: string
}> = {
  running: {
    label: '运行中',
    box: 'border-muted-foreground/20 bg-muted/20',
    dot: 'bg-muted-foreground/60 animate-pulse',
    text: 'text-muted-foreground',
  },
  completed: {
    label: '已完成',
    box: 'border-emerald-500/30 bg-emerald-500/5',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  failed: {
    label: '失败',
    box: 'border-destructive/30 bg-destructive/5',
    dot: 'bg-destructive',
    text: 'text-destructive',
  },
  stopped: {
    label: '已停止',
    box: 'border-muted-foreground/20 bg-muted/20',
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground/70',
  },
}

function TaskCardView({ card }: { card: TaskCardState }): JSX.Element {
  const s = TASK_CARD_STATUS[card.status]
  const isRunning = card.status === 'running'
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${s.box}`}>
      <span className={`mt-1 size-2 shrink-0 rounded-full ${s.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-foreground/80">子代理</span>
          <span className={s.text}>{s.label}</span>
          {isRunning && card.lastToolName && (
            <span className="truncate text-muted-foreground/60">· {card.lastToolName}</span>
          )}
        </div>
        {card.description && (
          <div className="mt-0.5 truncate text-xs text-foreground/70">{card.description}</div>
        )}
        {isRunning && card.progressText && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{card.progressText}</div>
        )}
        {!isRunning && card.summary && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{card.summary}</div>
        )}
      </div>
    </div>
  )
}

/**
 * Typewriter 逐字显示：端点（aicode/minimax）流式粒度粗，每 ~500ms 发一大块，
 * 块到达后不瞬间全部显示，而是用 rAF 在块间隔内逐字挤出，视觉连续丝滑。
 *
 * 速度自适应：按"剩余字符 / 剩余预估时间"算每帧步长，保证下一块到达前刚好显示完。
 * 收尾：turn 结束后 streamingText 不再增长，剩余字符快速追完。
 */
function TypewriterText({ text }: { text: string }): JSX.Element {
  const [displayed, setDisplayed] = useState('')
  const rafRef = useRef<number | null>(null)
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    // text 增长时若 rAF 没在跑，启动；rAF 循环读 textRef 最新值，自动追上新块
    if (rafRef.current != null) return
    const step = () => {
      const full = textRef.current
      setDisplayed((cur) => {
        if (cur.length >= full.length) {
          rafRef.current = null
          return cur // 已追上，停 rAF，等下一块触发 effect 重启
        }
        // 每帧追加：剩余字符的 1/8（约 8 帧 ≈ 130ms 追完一段），最少 1 字
        const remain = full.length - cur.length
        const add = Math.max(1, Math.ceil(remain / 8))
        return full.slice(0, cur.length + add)
      })
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [text])

  // 新消息/切换会话时 text 重置为空，displayed 同步重置
  useEffect(() => {
    if (text === '') setDisplayed('')
  }, [text])

  return <MessageResponse>{displayed}</MessageResponse>
}

/** 取消息首个 text 块的文本（供 minimap preview） */
function firstText(m: TAgentMessage): string | undefined {
  const block = m.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  return block?.text
}
