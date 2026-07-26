/**
 * 会话页核心
 *
 * 吃 TAgentDesktopStreamPayload（IPC 流式）+ TAgentMessage IR 渲染。
 * 消息区用 Conversation 容器（自动钉底），输入区用 TipTap ChatInput。
 * 渠道：首条消息按 effectiveChannelId 绑核（kscc↔external 互斥），发送后锁定。
 */
import { useState, useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { TAgentDesktopStreamPayload, TAgentMessage, Channel } from '@tagent/shared'
import { sdkMessageToIR } from '@tagent/shared'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Message,
  MessageContent,
  MessageResponse,
  MessageLoading,
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
  Button,
} from '@tagent/ui'
import { MessageView } from './components/MessageView'
import { ChatInput, type ChatInputHandle } from './components/ChatInput'
import { channelsAtom, selectedChannelIdAtom, bumpSessionsRefreshAtom } from './atoms/channel-atoms'
import { currentWorkspaceIdAtom } from './atoms/workspace-atoms'

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

  // 绑核优先级：本会话已发送 > meta 已绑定 > 全局选中（新会话）
  const effectiveChannelId = sentChannelId ?? session.channelId ?? selectedChannelId
  const locked = sentChannelId !== null || !!session.channelId
  const enabledChannels = channels.filter((c) => c.enabled)
  const activeChannel: Channel | undefined = channels.find((c) => c.id === effectiveChannelId)
  const ksccChannelId = channels.find((c) => c.provider === 'kscc-internal')?.id

  // 切换会话时加载历史
  useEffect(() => {
    sessionIdRef.current = sessionId
    setItems([])
    setRunning(false)
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
    })()
  }, [sessionId])

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
    <div className="flex flex-col h-full">
      {/* 会话头：渠道选择 + 模型 */}
      <div className="h-10 shrink-0 border-b flex items-center px-3 gap-2 text-xs">
        <span className="text-muted-foreground">渠道:</span>
        <select
          className="px-1.5 py-0.5 text-xs rounded border border-input bg-background"
          value={effectiveChannelId ?? ''}
          disabled={locked}
          onChange={(e) => setSelectedChannelId(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {enabledChannels.length === 0 && <option value="">（无可用渠道）</option>}
          {enabledChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.provider}）
            </option>
          ))}
        </select>
        {activeChannel?.defaultModelId && (
          <span className="text-muted-foreground">模型: {activeChannel.defaultModelId}</span>
        )}
        {locked && <span className="text-muted-foreground/50 text-[11px]">已绑定（不可切换）</span>}
      </div>

      {/* 消息区：Conversation 自动钉底 */}
      <Conversation className="flex-1">
        <ConversationContent className="px-4 py-2">
          {items.map((item) => (
            <ItemView key={item.key} item={item} />
          ))}
          {running && <MessageLoading />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* 输入区 */}
      <div className="shrink-0 border-t px-4 py-3">
        <ChatInput
          ref={chatInputRef}
          onSubmit={() => void send()}
          disabled={running}
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
        />
        <div className="flex gap-2 mt-2">
          <Button size="sm" disabled={running} onClick={() => void send()}>
            发送
          </Button>
          {running && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => window.electronAPI.stopAgent(sessionIdRef.current)}
            >
              停止
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 显示项渲染 */
function ItemView({ item }: { item: DisplayItem }): JSX.Element {
  // 完整消息（IR）→ MessageView
  if (item.message) {
    return <MessageView message={item.message} />
  }

  // 流式占位
  return (
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
