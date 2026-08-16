/**
 * 主会话拉起、仍在跑的后台进程（Bash / CLI 工人）。
 * 给摘要「后台进程」列表用：查看 + 停止。
 */

export type SessionProcessSource = 'bash' | 'cli-worker'

export interface SessionBackgroundProcess {
  id: string
  sessionId: string
  pid?: number
  command: string
  source: SessionProcessSource
  startedAt: number
}
