/**
 * 会话页核心
 *
 * 吃 TAgentDesktopStreamPayload（IPC 流式）+ TAgentMessage IR 渲染。
 * 消息区用 Conversation 容器（自动钉底），输入区用 TipTap ChatInput。
 * 渠道：首条消息按 effectiveChannelId 绑核（kscc↔external 互斥），发送后锁定。
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { TAgentDesktopStreamPayload, TAgentMessage } from '@tagent/shared'
import { sdkMessageToIR } from '@tagent/shared'
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
import { ArrowUp, Square } from 'lucide-react'
import { MessageView } from './MessageView'
import { ChatInput, type ChatInputHandle } from './ChatInput'
import { ModelSelector } from './ModelSelector'
import { PermissionBanner } from '../permission/PermissionBanner'
import { ScrollPositionManager } from '../shell/ScrollPositionManager'
import { channelsAtom, selectedChannelIdAtom, bumpSessionsRefreshAtom } from '../../atoms/channel-atoms'
import { currentWorkspaceIdAtom } from '../../atoms/workspace-atoms'

interface SessionMeta {
  id: string
  title: string
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
  const [sentChannelId, setSentChannelId] = useState<string | null>(null)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const itemIdxRef = useRef(0)
  const streamingRef = useRef<DisplayItem | null>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)

  const channels = useAtomValue(channelsAtom)
  const selectedChannelId = useAtomValue(selectedChannelIdAtom)
  const setSelectedChannelId = useSetAtom(selectedChannelIdAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const bumpRefresh = useSetAtom(bumpSessionsRefreshAtom)

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

  // 绑核优先级：本会话已发送 > meta 已绑定 > 全局选中（新会话）
  const effectiveChannelId = sentChannelId ?? session.channelId ?? selectedChannelId
  const locked = sentChannelId !== null || !!session.channelId
  const ksccChannelId = channels.find((c) => c.provider === 'kscc-internal')?.id

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
    })()
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

  const handlePayload = (p: TAgentDesktopStreamPayload): void => {
    if (p.kind === 'sdk_message') {
      if (streamingRef.current) {
        streamingRef.current = null
      }
      setItems((prev) => [...prev, { key: `m${itemIdxRef.current++}`, message: p.message }])
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
    } else if (p.kind === 'result') {
      streamingRef.current = null
      setRunning(false)
      bumpRefresh()
    } else if (p.kind === 'tagent_event') {
      const evt = p.event as { type: string; message?: string }
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
      }
    }
  }

  const send = async (): Promise<void> => {
    const text = chatInputRef.current?.getText().trim()
    if (!text || running) return
    const channelId = effectiveChannelId ?? ksccChannelId
    if (!channelId) {
      alert('未选择渠道，请先在「渠道管理」中添加并启用渠道')
      return
    }
    chatInputRef.current?.clear()
    setRunning(true)
    setSentChannelId(channelId)
    try {
      const res = await window.electronAPI.sendMessage({
        sessionId: sessionIdRef.current,
        prompt: text,
        channelId,
        workspaceId: currentWorkspaceId ?? undefined,
      })
      // IPC 返回失败：没有 result 事件会来，必须在这里解除 running，否则输入框永久 disabled
      if (res && !res.ok) {
        alert(`发送失败：${res.error ?? '未知错误'}`)
        setRunning(false)
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
      <Conversation className="absolute inset-0 min-h-0" resize={effectiveScrollReady ? 'smooth' : 'instant'}>
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
                <ModelSelector
                  effectiveChannelId={effectiveChannelId}
                  locked={locked}
                  onSelectChannel={setSelectedChannelId}
                />
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
