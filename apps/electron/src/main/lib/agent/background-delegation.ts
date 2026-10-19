/**
 * 后台子代理：派出即返回、独立跑完、按「派出时」的冻结分叉回投。
 *
 * 父轮不等子代理。子代理完成后唤醒主会话，但回投 prompt 只能接在
 * 派出那一刻的父上下文后面，不能读后来新聊的 live 历史。
 */

export const BACKGROUND_DELEGATION_MAX_CONCURRENT = 3
export const BACKGROUND_DELEGATION_MAX_PENDING_CALLBACKS = 8

export type TaskDelegationMode = 'foreground' | 'background'

export interface BackgroundCallbackPayload {
  taskId: string
  description: string
  subagentType: string
  status: 'completed' | 'partial' | 'failed' | 'stopped'
  summary: string
  resultText: string
  durationMs: number
  /** 派出时冻结的父 Agent 消息；回投时整段替换 live 历史 */
  fork: unknown[]
}

export function parseTaskDelegationMode(value: unknown): TaskDelegationMode {
  return value === 'foreground' ? 'foreground' : 'background'
}

export function wrapBackgroundCallbackPrompt(payload: BackgroundCallbackPayload): string {
  const statusLabel =
    payload.status === 'completed' ? '已完成' : payload.status === 'partial' ? '已返回阶段结果，尚未全部完成' : payload.status === 'failed' ? '失败' : '已停止'
  const result = payload.resultText.trim() || '（无文本输出）'
  const truncated =
    result.length > 12_000 ? `${result.slice(0, 12_000)}\n... (截断，共 ${result.length} 字符)` : result
  const title = payload.description.trim() || payload.subagentType
  return [
    `【后台子代理回投】子代理「${title}」（${payload.subagentType}，id ${payload.taskId}）${statusLabel}。`,
    '下面是它的结论。请据此收口：向用户说明结果，必要时跟进。不要把这段话当成新的独立任务。',
    '',
    truncated,
  ].join('\n')
}

export function snapshotAgentMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return []
  try {
    return JSON.parse(JSON.stringify(messages)) as unknown[]
  } catch {
    return [...messages]
  }
}

export function enqueueBackgroundCallback(
  queue: BackgroundCallbackPayload[],
  payload: BackgroundCallbackPayload,
  max = BACKGROUND_DELEGATION_MAX_PENDING_CALLBACKS,
): BackgroundCallbackPayload[] {
  const withoutDup = queue.filter((item) => item.taskId !== payload.taskId)
  withoutDup.push(payload)
  if (withoutDup.length <= max) return withoutDup
  return withoutDup.slice(withoutDup.length - max)
}
