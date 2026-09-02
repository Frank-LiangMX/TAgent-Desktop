/**
 * Codex App Server v2 notification -> TAgent renderer IR.
 *
 * 协议结构以 codex-cli 0.151.0 `app-server generate-ts --experimental`
 * 为基线。这里只依赖稳定的 discriminant/字段，不把生成代码复制进仓库。
 */
import type {
  TAgentDesktopStreamPayload,
  TAgentMessage,
  TAgentUsage,
} from '@tagent/shared'
import type { RoutedCodexNotification } from './codex-app-server-session-manager'

interface CodexItem {
  type?: string
  id?: string
  text?: string
  summary?: string[]
  content?: string[]
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  path?: string
  changes?: unknown[]
  server?: string
  tool?: string
  name?: string
  namespace?: string | null
  arguments?: unknown
  result?: unknown
  error?: { message?: string } | null
  contentItems?: unknown[] | null
  success?: boolean | null
  [key: string]: unknown
}

interface TokenUsageBreakdown {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
}

export class CodexEventNormalizer {
  private readonly usageByTurn = new Map<string, TAgentUsage>()
  private readonly modelId?: string

  constructor(modelId?: string) {
    this.modelId = modelId?.trim() || undefined
  }

  feed(notification: RoutedCodexNotification): TAgentDesktopStreamPayload[] {
    const params = this.asRecord(notification.params)
    if (!params) return []

    switch (notification.method) {
      case 'item/agentMessage/delta':
        return this.deltaPayload('stream_text_delta', params)
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.deltaPayload('stream_thinking_delta', params)
      case 'thread/tokenUsage/updated':
        this.captureUsage(params)
        return []
      case 'item/started':
        return this.itemStarted(params)
      case 'item/completed':
        return this.itemCompleted(params)
      case 'turn/completed':
        return this.turnCompleted(params)
      case 'error':
        return this.errorPayload(params)
      case 'warning':
      case 'guardianWarning':
      case 'configWarning':
        return this.warningPayload(params)
      default:
        return []
    }
  }

  reset(): void {
    this.usageByTurn.clear()
  }

  private deltaPayload(
    kind: 'stream_text_delta' | 'stream_thinking_delta',
    params: Record<string, unknown>,
  ): TAgentDesktopStreamPayload[] {
    const text = typeof params.delta === 'string' ? params.delta : ''
    if (!text) return []
    const uuid = typeof params.itemId === 'string' ? params.itemId : undefined
    return [{ kind, text, ...(uuid ? { uuid } : {}) }]
  }

  private itemStarted(
    params: Record<string, unknown>,
  ): TAgentDesktopStreamPayload[] {
    const item = this.asItem(params.item)
    if (!item?.id) return []
    const tool = this.toolUseFromItem(item)
    if (!tool) return []
    return [
      {
        kind: 'sdk_message',
        message: {
          type: 'assistant',
          uuid: item.id,
          createdAt: this.timestamp(params.startedAtMs),
          ...(this.modelId ? { modelId: this.modelId } : {}),
          content: [tool],
          _partial: true,
        },
      },
    ]
  }

  private itemCompleted(
    params: Record<string, unknown>,
  ): TAgentDesktopStreamPayload[] {
    const item = this.asItem(params.item)
    if (!item?.id) return []
    const createdAt = this.timestamp(params.completedAtMs)

    if (item.type === 'agentMessage') {
      if (!item.text) return []
      return [
        this.messagePayload({
          type: 'assistant',
          uuid: item.id,
          createdAt,
          content: [{ type: 'text', text: item.text }],
        }),
      ]
    }
    if (item.type === 'reasoning') {
      const thinking = [...(item.summary ?? []), ...(item.content ?? [])]
        .filter(Boolean)
        .join('\n\n')
      if (!thinking) return []
      return [
        this.messagePayload({
          type: 'assistant',
          uuid: item.id,
          createdAt,
          content: [{ type: 'thinking', thinking }],
        }),
      ]
    }

    const tool = this.toolUseFromItem(item)
    if (!tool) return []
    const result = this.toolResultFromItem(item)
    const payloads: TAgentDesktopStreamPayload[] = [
      this.messagePayload({
        type: 'assistant',
        uuid: item.id,
        createdAt,
        content: [tool],
      }),
    ]
    if (result !== undefined) {
      payloads.push(
        this.messagePayload({
          type: 'user',
          uuid: `${item.id}:result`,
          parentToolUseId: item.id,
          createdAt,
          content: [
            {
              type: 'tool_result',
              toolUseId: item.id,
              content: result,
              isError: this.isFailedItem(item),
            },
          ],
        }),
      )
    }
    return payloads
  }

  private turnCompleted(
    params: Record<string, unknown>,
  ): TAgentDesktopStreamPayload[] {
    const turn = this.asRecord(params.turn)
    const turnId = typeof turn?.id === 'string' ? turn.id : undefined
    const status = typeof turn?.status === 'string' ? turn.status : 'completed'
    const error = this.asRecord(turn?.error)
    const errorMessage =
      typeof error?.message === 'string' ? error.message : undefined
    const usage = turnId ? this.usageByTurn.get(turnId) : undefined
    if (turnId) this.usageByTurn.delete(turnId)
    return [
      {
        kind: 'result',
        subtype: status,
        ...(usage ? { usage } : {}),
        ...(errorMessage ? { errors: [errorMessage] } : {}),
      },
    ]
  }

  private errorPayload(
    params: Record<string, unknown>,
  ): TAgentDesktopStreamPayload[] {
    const error = this.asRecord(params.error)
    const message =
      typeof error?.message === 'string' ? error.message : 'Codex 执行失败'
    const willRetry = params.willRetry === true
    return [
      {
        kind: 'tagent_event',
        event: {
          type: willRetry ? 'codex_retrying' : 'session_error',
          message,
          willRetry,
        },
      },
    ]
  }

  private warningPayload(
    params: Record<string, unknown>,
  ): TAgentDesktopStreamPayload[] {
    const message =
      typeof params.message === 'string'
        ? params.message
        : typeof params.text === 'string'
          ? params.text
          : undefined
    if (!message) return []
    return [
      {
        kind: 'tagent_event',
        event: { type: 'provider_warning', provider: 'codex', message },
      },
    ]
  }

  private captureUsage(params: Record<string, unknown>): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined
    const tokenUsage = this.asRecord(params.tokenUsage)
    const last = this.asRecord(tokenUsage?.last) as TokenUsageBreakdown | undefined
    if (!turnId || !last) return
    this.usageByTurn.set(turnId, {
      inputTokens: last.inputTokens ?? 0,
      outputTokens: last.outputTokens ?? 0,
      cacheReadTokens: last.cachedInputTokens ?? 0,
    })
  }

  private toolUseFromItem(
    item: CodexItem,
  ): { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | undefined {
    if (!item.id) return undefined
    switch (item.type) {
      case 'commandExecution':
        return {
          type: 'tool_use',
          id: item.id,
          name: 'Bash',
          input: {
            command: item.command ?? '',
            ...(item.cwd ? { cwd: item.cwd } : {}),
          },
        }
      case 'fileChange':
        return {
          type: 'tool_use',
          id: item.id,
          name: 'ApplyPatch',
          input: { changes: item.changes ?? [] },
        }
      case 'mcpToolCall':
        return {
          type: 'tool_use',
          id: item.id,
          name: `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`,
          input: this.asToolInput(item.arguments),
        }
      case 'dynamicToolCall':
        return {
          type: 'tool_use',
          id: item.id,
          name: item.namespace
            ? `${item.namespace}:${item.tool ?? 'tool'}`
            : (item.tool ?? 'tool'),
          input: this.asToolInput(item.arguments),
        }
      case 'webSearch':
        return {
          type: 'tool_use',
          id: item.id,
          name: 'WebSearch',
          input: this.omitItemEnvelope(item),
        }
      case 'imageView':
        return {
          type: 'tool_use',
          id: item.id,
          name: 'ViewImage',
          input: { path: item.path },
        }
      default:
        return undefined
    }
  }

  private toolResultFromItem(item: CodexItem): string | undefined {
    switch (item.type) {
      case 'commandExecution':
        return [
          item.aggregatedOutput ?? '',
          item.exitCode == null ? '' : `exit code: ${item.exitCode}`,
        ]
          .filter(Boolean)
          .join('\n')
      case 'fileChange':
        return `文件变更：${item.status ?? 'completed'}`
      case 'mcpToolCall':
        return item.error?.message ?? this.stringify(item.result)
      case 'dynamicToolCall':
        return this.stringify(item.contentItems)
      case 'webSearch':
      case 'imageView':
        return this.stringify(this.omitItemEnvelope(item))
      default:
        return undefined
    }
  }

  private isFailedItem(item: CodexItem): boolean {
    return (
      item.status === 'failed' ||
      item.status === 'declined' ||
      item.success === false ||
      Boolean(item.error)
    )
  }

  private messagePayload(message: TAgentMessage): TAgentDesktopStreamPayload {
    if (message.type === 'assistant' && this.modelId && !message.modelId) {
      return {
        kind: 'sdk_message',
        message: { ...message, modelId: this.modelId },
      }
    }
    return { kind: 'sdk_message', message }
  }

  private asItem(value: unknown): CodexItem | undefined {
    return this.asRecord(value) as CodexItem | undefined
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  }

  private asToolInput(value: unknown): Record<string, unknown> {
    return this.asRecord(value) ?? { value }
  }

  private omitItemEnvelope(item: CodexItem): Record<string, unknown> {
    const { id: _id, type: _type, ...rest } = item
    return rest
  }

  private timestamp(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : Date.now()
  }

  private stringify(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return ''
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
}
