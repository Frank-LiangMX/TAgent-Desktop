/**
 * TAgentMessage IR 渲染（重写，不搬 TAgent 的 SDKMessageRenderer）
 *
 * 吃 TAgentMessage（IR），不认 SDK 格式。见 docs/decisions/ADR-0001-dual-core.md。
 * 双核统一：kscc 核经主进程转译成 IR，Pi 核未来也转 IR，渲染层一套。
 *
 * 当前阶段：最小渲染（文本/thinking/工具调用/工具结果/错误）。
 * 后续打磨：工具结果富文本、thinking 折叠、代码高亮（搬 @tagent/ui CodeBlock）。
 */
import type {
  TAgentMessage,
  TAgentContentBlock,
  TAgentToolResultBlock,
} from '@tagent/shared'

export function MessageView({ message }: { message: TAgentMessage }): JSX.Element {
  if (message.type === 'user') {
    return <UserView message={message} />
  }
  return <AssistantView message={message} />
}

function UserView({ message }: { message: Extract<TAgentMessage, { type: 'user' }> }): JSX.Element {
  // user 消息含 tool_result 块时不直接显示（工具结果在对应 tool_use 下方展示）
  const textBlocks = message.content.filter((b) => b.type === 'text')
  if (textBlocks.length === 0) return <></>
  return (
    <div style={{ textAlign: 'right', margin: '8px 0' }}>
      <span style={bubbleStyle('user')}>
        {textBlocks.map((b, i) => (
          <span key={i}>{(b as { text: string }).text}</span>
        ))}
      </span>
    </div>
  )
}

function AssistantView({ message }: { message: Extract<TAgentMessage, { type: 'assistant' }> }): JSX.Element {
  if (message.error) {
    return (
      <div style={{ margin: '8px 0' }}>
        <span style={bubbleStyle('error')}>[错误] {message.error.message}</span>
      </div>
    )
  }
  return (
    <div style={{ margin: '8px 0' }}>
      <span style={bubbleStyle('assistant')}>
        {message.content.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </span>
    </div>
  )
}

function BlockView({ block }: { block: TAgentContentBlock }): JSX.Element {
  if (block.type === 'text') {
    return <span style={{ whiteSpace: 'pre-wrap' }}>{(block as { text: string }).text}</span>
  }
  if (block.type === 'thinking') {
    const b = block as { thinking: string }
    return (
      <details style={{ margin: '4px 0', color: '#888', fontSize: 12 }}>
        <summary>思考…</summary>
        <div style={{ whiteSpace: 'pre-wrap', paddingLeft: 12 }}>{b.thinking}</div>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    const b = block as { name: string; input: Record<string, unknown> }
    return (
      <div style={toolStyle}>
        🔧 {b.name}
        <pre style={{ margin: '4px 0 0', fontSize: 11, color: '#666' }}>
          {JSON.stringify(b.input, null, 2).slice(0, 200)}
        </pre>
      </div>
    )
  }
  // 未知块原样忽略（兜底）
  return <></>
}

/** 工具结果单独渲染（tool_result 是 user 消息内的块，但展示在 tool_use 下方） */
export function ToolResultView({ block }: { block: TAgentToolResultBlock }): JSX.Element {
  const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  return (
    <div style={{ ...toolStyle, color: block.isError ? '#c00' : '#080' }}>
      {block.isError ? '✗' : '✓'} 结果
      <pre style={{ margin: '4px 0 0', fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
        {text?.slice(0, 500)}
      </pre>
    </div>
  )
}

function bubbleStyle(role: 'user' | 'assistant' | 'error'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '8px 12px',
    borderRadius: 8,
    maxWidth: '80%',
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
  }
  if (role === 'user') return { ...base, background: '#007aff', color: '#fff' }
  if (role === 'error') return { ...base, background: '#fee', color: '#c00' }
  return { ...base, background: '#e8e8e8', color: '#000' }
}

const toolStyle: React.CSSProperties = {
  margin: '4px 0',
  padding: '6px 10px',
  borderRadius: 6,
  background: '#f5f5f5',
  border: '1px solid #e0e0e0',
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
}
