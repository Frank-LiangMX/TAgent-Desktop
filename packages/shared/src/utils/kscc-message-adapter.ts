/**
 * kscc 核消息转译：SDKMessage → TAgentMessage（IR）
 *
 * 主进程层转译，渲染层只吃 TAgentMessage，不认 SDK 格式。
 * 见 docs/plans/2026-07-25-renderer-decouple-message-ir.md。
 *
 * 流式 delta（stream_text_delta/stream_thinking_delta）单独转 TAgentControlEvent，
 * 不走 TAgentMessage（转录只收完整消息）。
 */
import type { SDKMessage } from '../types/agent'
import type {
  TAgentMessage,
  TAgentContentBlock,
  TAgentToolResultBlock,
  TAgentUsage,
  TAgentControlEvent,
} from '../types/tagent-message'

/** SDK content block → TAgentContentBlock */
function sdkBlockToIR(block: Record<string, unknown>): TAgentContentBlock | TAgentToolResultBlock {
  const type = block.type as string
  if (type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text }
  }
  if (type === 'thinking' && typeof block.thinking === 'string') {
    return { type: 'thinking', thinking: block.thinking }
  }
  if (type === 'tool_use') {
    return {
      type: 'tool_use',
      id: String(block.id ?? ''),
      name: String(block.name ?? ''),
      input: (block.input as Record<string, unknown>) ?? {},
    }
  }
  if (type === 'tool_result') {
    return {
      type: 'tool_result',
      toolUseId: String(block.tool_use_id ?? ''),
      content: block.content,
      isError: Boolean(block.is_error),
    }
  }
  return block as { type: string; [key: string]: unknown }
}

function sdkUsageToIR(u: Record<string, unknown>): TAgentUsage {
  return {
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
    cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
  }
}

/**
 * 转 SDKMessage → TAgentMessage（转录）或 TAgentControlEvent（控制）。
 * 返回 null 表示该消息不进转录也不需要控制事件（如 system init）。
 */
export function sdkMessageToIR(
  msg: SDKMessage
): { message?: TAgentMessage; event?: TAgentControlEvent } {
  const m = msg as Record<string, unknown>
  const type = m.type as string

  if (type === 'user') {
    const message = m.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content)
      ? (message!.content as Array<Record<string, unknown>>).map(sdkBlockToIR)
      : []
    return {
      message: {
        type: 'user',
        uuid: m.uuid as string | undefined,
        parentToolUseId: (m.parent_tool_use_id as string | null) ?? null,
        sessionId: m.session_id as string | undefined,
        isReplay: m.isReplay as boolean | undefined,
        isSynthetic: m.isSynthetic as boolean | undefined,
        content: content as unknown as TAgentMessage['content'],
      } as TAgentMessage,
    }
  }

  if (type === 'assistant') {
    const message = m.message as
      | { content?: Array<Record<string, unknown>>; usage?: Record<string, unknown>; model?: string }
      | undefined
    const content = Array.isArray(message?.content)
      ? message!.content.map(sdkBlockToIR)
      : []
    const error = m.error as { message?: string; errorType?: string } | undefined
    return {
      message: {
        type: 'assistant',
        uuid: m.uuid as string | undefined,
        parentToolUseId: (m.parent_tool_use_id as string | null) ?? null,
        sessionId: m.session_id as string | undefined,
        isReplay: m.isReplay as boolean | undefined,
        modelId: (m._channelModelId as string | undefined) ?? message?.model,
        error: error ? { message: error.message ?? '', code: error.errorType } : undefined,
        content: content as TAgentContentBlock[],
        usage: message?.usage ? sdkUsageToIR(message.usage) : undefined,
      } as TAgentMessage,
    }
  }

  if (type === 'result') {
    const usage = m.usage as Record<string, unknown> | undefined
    return {
      event: {
        kind: 'result',
        subtype: m.subtype as string | undefined,
        usage: usage ? sdkUsageToIR(usage) : undefined,
        totalCostUsd: Number(m.total_cost_usd ?? 0),
      },
    }
  }

  if (type === 'stream_event') {
    const event = m.event as { type?: string; delta?: Record<string, unknown> } | undefined
    const delta = event?.delta as { type?: string; text?: string; thinking?: string } | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return {
        event: {
          kind: 'stream_text_delta',
          text: delta.text,
          parentToolUseId: (m.parent_tool_use_id as string | undefined) ?? undefined,
        },
      }
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return {
        event: {
          kind: 'stream_thinking_delta',
          text: delta.thinking,
          parentToolUseId: (m.parent_tool_use_id as string | undefined) ?? undefined,
        },
      }
    }
    return {}
  }

  // 子代理生命周期事件（task_started / task_progress / task_notification）
  if (type === 'system') {
    const subtype = m.subtype as string | undefined
    if (subtype === 'task_started') {
      return {
        event: {
          kind: 'tagent_event',
          event: {
            type: 'task_started',
            taskId: m.task_id as string,
            toolUseId: m.tool_use_id as string | undefined,
            description: m.description as string,
            taskType: (m.task_type ?? m.subagent_type) as string | undefined,
          },
        },
      }
    }
    if (subtype === 'task_progress') {
      return {
        event: {
          kind: 'tagent_event',
          event: {
            type: 'task_progress',
            taskId: m.task_id as string,
            toolUseId: m.tool_use_id as string | undefined,
            description: m.description as string,
            lastToolName: m.last_tool_name as string | undefined,
            usage: m.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined,
            summary: m.summary as string | undefined,
          },
        },
      }
    }
    if (subtype === 'task_notification') {
      return {
        event: {
          kind: 'tagent_event',
          event: {
            type: 'task_notification',
            taskId: m.task_id as string,
            toolUseId: m.tool_use_id as string | undefined,
            status: m.status as 'completed' | 'failed' | 'stopped',
            summary: m.summary as string,
            outputFile: m.output_file as string | undefined,
            usage: m.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined,
          },
        },
      }
    }
    // 压缩进行中 / 完成（TAgent 自研 Pi 压缩事件，形态对齐 SDK compact 文案）
    if (subtype === 'compacting') {
      return {
        event: {
          kind: 'tagent_event',
          event: { type: 'compacting' },
        },
      }
    }
    if (subtype === 'compact_boundary') {
      const meta = m.compact_metadata as
        | { trigger?: 'manual' | 'auto'; pre_tokens?: number; post_tokens?: number }
        | undefined
      return {
        event: {
          kind: 'tagent_event',
          event: {
            type: 'compact_complete',
            trigger: meta?.trigger,
            tokensBefore: meta?.pre_tokens,
          },
        },
      }
    }
    // 其他 system 消息（init 等）不转译
    return {}
  }

  // 其他（tool_progress/prompt_suggestion/tool_use_summary）暂不转译，后续按需
  return {}
}
