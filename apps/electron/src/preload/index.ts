/**
 * TAgent-Desktop preload：渲染进程↔主进程桥。
 * 暴露会话 IPC：发消息/收流式/停止/销毁。
 *
 * 流式统一走 STREAM_EVENT，payload.kind 区分：message/turn_end/error。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { AGENT_IPC_CHANNELS } from '@tagent/shared'

export interface SendMessageInput {
  sessionId: string
  prompt: string
  channelKind?: 'kscc' | 'external'
  model?: string
}

export interface StreamEventPayload {
  sessionId: string
  kind: 'message' | 'turn_end' | 'error'
  message?: unknown
  error?: string
}

const electronAPI = {
  /** 发消息（首次 spawn + 起循环，后续 enqueue 复用） */
  sendMessage: (input: SendMessageInput) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEND_MESSAGE, input),
  /** 停止当前轮（软中断，保进程） */
  stopAgent: (sessionId: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_AGENT, sessionId),
  /** 销毁会话（杀进程） */
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SESSION, sessionId),
  /** 监听流式事件（统一通道，kind 区分） */
  onStreamEvent: (cb: (payload: StreamEventPayload) => void) => {
    const handler = (_e: unknown, payload: StreamEventPayload) => cb(payload)
    ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_EVENT, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_EVENT, handler)
  },
} as const

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
