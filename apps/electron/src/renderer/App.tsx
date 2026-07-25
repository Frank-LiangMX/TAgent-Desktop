/**
 * TAgent-Desktop App 根组件
 */
import { Chat } from './Chat'

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
      onStreamEvent: (cb: (payload: unknown) => void) => () => void
    }
  }
}

export function App(): JSX.Element {
  return <Chat />
}
