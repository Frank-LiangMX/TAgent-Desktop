/**
 * TAgent-Desktop App 根组件
 * 侧栏（会话列表）+ Chat（消息区）。
 */
import { useState } from 'react'
import { Chat } from './Chat'
import { SessionSidebar } from './components/SessionSidebar'

declare global {
  interface Window {
    electronAPI: {
      sendMessage: (input: {
        sessionId: string
        prompt: string
        channelKind?: 'kscc' | 'external'
        model?: string
      }) => Promise<{ ok: boolean; error?: string }>
      stopAgent: (sessionId: string) => Promise<{ ok: boolean }>
      deleteSession: (sessionId: string) => Promise<{ ok: boolean }>
      listSessions: () => Promise<unknown[]>
      getMessages: (sessionId: string) => Promise<unknown[]>
      onStreamEvent: (cb: (payload: unknown) => void) => () => void
    }
  }
}

interface SessionMeta {
  id: string
  title: string
  modelId?: string
}

export function App(): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null)

  const newSession = (): void => {
    // 新会话用临时 id（发首条消息时主进程建 meta）
    setActiveId('session-' + Date.now())
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <SessionSidebar
        activeSessionId={activeId}
        onSelect={(s) => setActiveId(s.id)}
        onNew={newSession}
      />
      <div style={{ flex: 1 }}>
        {activeId ? (
          <Chat key={activeId} sessionId={activeId} />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#999',
            }}
          >
            选择左侧会话，或点「新建会话」开始
          </div>
        )}
      </div>
    </div>
  )
}
