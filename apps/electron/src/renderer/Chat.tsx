/**
 * 最小会话页（骨架验证用）
 *
 * 发消息 → 主进程 spawn kscc（长驻）→ 流式回复显示。
 * 不搬 TAgent 的 AgentView/SDKMessageRenderer（那套复杂，后续接）。
 * 先跑通"发消息→看回复"闭环，验证长驻骨架。
 */
import { useState, useEffect, useRef } from 'react'

interface StreamEventPayload {
  sessionId: string
  kind: 'message' | 'turn_end' | 'error'
  message?: unknown
  error?: string
}

interface Msg {
  role: 'user' | 'assistant'
  text: string
}

export function Chat(): JSX.Element {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const sessionIdRef = useRef('session-' + Date.now())
  const assistantBufRef = useRef('')

  useEffect(() => {
    const off = window.electronAPI.onStreamEvent((payload: unknown) => {
      const p = payload as StreamEventPayload
      if (p.sessionId !== sessionIdRef.current) return
      if (p.kind === 'message') {
        // 从 SDKMessage 提取文本（最小提取，完整渲染后续搬 SDKMessageRenderer）
        const text = extractText(p.message)
        if (text) {
          assistantBufRef.current += text
          setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { role: 'assistant', text: assistantBufRef.current }
            } else {
              next.push({ role: 'assistant', text: assistantBufRef.current })
            }
            return next
          })
        }
      } else if (p.kind === 'turn_end') {
        setRunning(false)
        assistantBufRef.current = ''
      } else if (p.kind === 'error') {
        setMessages((prev) => [...prev, { role: 'assistant', text: `[错误] ${p.error}` }])
        setRunning(false)
      }
    })
    return off
  }, [])

  const send = async (): Promise<void> => {
    if (!input.trim() || running) return
    const text = input.trim()
    setInput('')
    setRunning(true)
    assistantBufRef.current = ''
    setMessages((prev) => [...prev, { role: 'user', text }])
    await window.electronAPI.sendMessage({
      sessionId: sessionIdRef.current,
      prompt: text,
      channelKind: 'kscc',
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              margin: '8px 0',
              textAlign: m.role === 'user' ? 'right' : 'left',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                padding: '8px 12px',
                borderRadius: 8,
                background: m.role === 'user' ? '#007aff' : '#e8e8e8',
                color: m.role === 'user' ? '#fff' : '#000',
                maxWidth: '80%',
                whiteSpace: 'pre-wrap',
                textAlign: 'left',
              }}
            >
              {m.text || '…'}
            </span>
          </div>
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
        <button
          style={{ marginLeft: 8, padding: '8px 16px' }}
          onClick={() => void send()}
          disabled={running}
        >
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

/** 从 SDKMessage 最小提取文本（流式 text_delta + 完整 text block） */
function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const msg = message as Record<string, unknown>
  // stream_event: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }
  if (msg.type === 'stream_event') {
    const event = msg.event as Record<string, unknown> | undefined
    const delta = event?.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') return delta.text
    return ''
  }
  // assistant: { type: 'assistant', message: { content: [{ type: 'text', text }] } }
  if (msg.type === 'assistant') {
    const message = msg.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) return ''
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
  }
  return ''
}
