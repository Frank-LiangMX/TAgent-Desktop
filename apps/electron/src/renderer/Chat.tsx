/**
 * 最小会话页（骨架验证用）
 *
 * 吃 AgentStreamPayload（TAgent IPC 格式）+ TAgentMessage IR 渲染。
 * 消息渲染区用 MessageView（IR，重写不搬 TAgent）。
 * 外壳最小自写，后续逐个搬 TAgent 外壳组件替换。
 */
import { useState, useEffect, useRef } from 'react'
import type { TAgentDesktopStreamPayload, TAgentMessage } from '@tagent/shared'
import { sdkMessageToIR } from '@tagent/shared'
import { MessageView, ToolResultView } from './components/MessageView'

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

export function Chat({ sessionId }: { sessionId: string }): JSX.Element {
  const [items, setItems] = useState<DisplayItem[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const itemIdxRef = useRef(0)
  const streamingRef = useRef<DisplayItem | null>(null)

  // 切换会话时加载历史（SDKMessage → IR 显示）
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
      // 完整消息（IR）：结束流式占位，加完整消息
      const msg = p.message
      if (streamingRef.current) {
        streamingRef.current = null
      }
      setItems((prev) => [...prev, { key: `m${itemIdxRef.current++}`, message: msg }])
    } else if (p.kind === 'stream_text_delta') {
      // 流式文本增量：累积到流式占位
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
      // 一轮结束
      streamingRef.current = null
      setRunning(false)
    } else if (p.kind === 'tagent_event') {
      const evt = p.event as { type: string; message?: string }
      if (evt.type === 'turn_end') {
        streamingRef.current = null
        setRunning(false)
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
    if (!input.trim() || running) return
    const text = input.trim()
    setInput('')
    setRunning(true)
    // 乐观显示用户消息
    setItems((prev) => [
      ...prev,
      {
        key: `u${itemIdxRef.current++}`,
        message: {
          type: 'user',
          content: [{ type: 'text', text }],
        } as TAgentMessage,
      },
    ])
    await window.electronAPI.sendMessage({
      sessionId: sessionIdRef.current,
      prompt: text,
      channelKind: 'kscc',
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {items.map((item) => (
          <ItemView key={item.key} item={item} />
        ))}
        {running && <div style={{ color: '#888', fontSize: 12 }}>运行中…</div>}
      </div>
      <div style={{ display: 'flex', padding: 16, borderTop: '1px solid #eee' }}>
        <input
          style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #ccc' }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="发消息（Enter 发送）"
          disabled={running}
        />
        <button style={{ marginLeft: 8, padding: '8px 16px' }} onClick={() => void send()} disabled={running}>
          发送
        </button>
        {running && (
          <button
            style={{ marginLeft: 8, padding: '8px 16px' }}
            onClick={() => window.electronAPI.stopAgent(sessionIdRef.current)}
          >
            停止
          </button>
        )}
      </div>
    </div>
  )
}

function ItemView({ item }: { item: DisplayItem }): JSX.Element {
  if (item.message) {
    // tool_result 单独渲染（user 消息内含 tool_result 块时）
    if (item.message.type === 'user') {
      const toolResults = item.message.content.filter((b) => b.type === 'tool_result') as Array<
        Extract<TAgentMessage, { type: 'user' }>['content'][number] & { type: 'tool_result' }
      >
      if (toolResults.length > 0 && item.message.content.every((b) => b.type !== 'text')) {
        return (
          <div>
            {toolResults.map((tr, i) => (
              <ToolResultView key={i} block={tr as never} />
            ))}
          </div>
        )
      }
    }
    return <MessageView message={item.message} />
  }
  // 流式占位
  return (
    <div style={{ margin: '8px 0' }}>
      {item.streamingThinking && (
        <details style={{ color: '#888', fontSize: 12 }} open>
          <summary>思考…</summary>
          <div style={{ whiteSpace: 'pre-wrap', paddingLeft: 12 }}>{item.streamingThinking}</div>
        </details>
      )}
      <span
        style={{
          display: 'inline-block',
          padding: '8px 12px',
          borderRadius: 8,
          background: '#e8e8e8',
          maxWidth: '80%',
          whiteSpace: 'pre-wrap',
        }}
      >
        {item.streamingText || '…'}
      </span>
    </div>
  )
}
