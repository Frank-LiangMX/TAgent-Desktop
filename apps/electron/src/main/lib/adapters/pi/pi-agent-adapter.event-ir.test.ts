/**
 * Pi 核终态收束 + 稳定性补丁单测
 *
 * - message_end(error) 只推可见 assistant，不推 result
 * - agent_end 按最后 assistant stopReason 推唯一 result
 * - error → error_during_execution + errors[]
 * - length → max_tokens
 * - stop/aborted → success
 * - toolcall_end 不双发 tool_use；tool_execution_start 展示进行中
 * - isRetryablePiTurnError / dropTrailingFailedAssistants / 退避
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'

import {
  dropTrailingFailedAssistants,
  isRetryablePiTurnError,
  mapPiStopReasonToResult,
  piEventToIR,
  piTurnRetryDelayMs,
  PI_TURN_RETRY_BASE_DELAY_MS,
} from './pi-agent-adapter'

const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function makeAssistant(partial: {
  stopReason: AssistantMessage['stopReason']
  errorMessage?: string
  usage?: Usage
  text?: string
}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: partial.text ?? '' }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test-model',
    usage: partial.usage ?? emptyUsage,
    stopReason: partial.stopReason,
    errorMessage: partial.errorMessage,
    timestamp: Date.now(),
  }
}

describe('mapPiStopReasonToResult', () => {
  it('error → error_during_execution + errors', () => {
    expect(mapPiStopReasonToResult({ stopReason: 'error', errorMessage: 'Request timed out.' })).toEqual({
      subtype: 'error_during_execution',
      errors: ['Request timed out.'],
    })
  })

  it('error 无文案 → 默认 stream error', () => {
    expect(mapPiStopReasonToResult({ stopReason: 'error' })).toEqual({
      subtype: 'error_during_execution',
      errors: ['stream error'],
    })
  })

  it('length → max_tokens', () => {
    expect(mapPiStopReasonToResult({ stopReason: 'length' })).toEqual({ subtype: 'max_tokens' })
  })

  it('stop / aborted / toolUse / 缺省 → success', () => {
    expect(mapPiStopReasonToResult({ stopReason: 'stop' })).toEqual({ subtype: 'success' })
    expect(mapPiStopReasonToResult({ stopReason: 'aborted' })).toEqual({ subtype: 'success' })
    expect(mapPiStopReasonToResult({ stopReason: 'toolUse' })).toEqual({ subtype: 'success' })
    expect(mapPiStopReasonToResult(undefined)).toEqual({ subtype: 'success' })
  })
})

describe('piEventToIR 终态收束', () => {
  it('message_end(error) 只推 assistant 文本，不推 result', () => {
    const event = {
      type: 'message_end',
      message: makeAssistant({
        stopReason: 'error',
        errorMessage: 'Request timed out.',
        text: '',
      }),
    } as AgentEvent

    const out = piEventToIR(event, 'sess-1')
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('sdk_message')
    if (out[0]?.kind === 'sdk_message') {
      const msg = out[0].message
      expect(msg.type).toBe('assistant')
      if (msg.type === 'assistant') {
        expect(msg.error?.message).toBe('Request timed out.')
        // 稳定 uuid：pi-{sessionId}-{timestamp}
        expect(msg.uuid).toMatch(/^pi-sess-1-\d+$/)
        const text = msg.content.find((b) => b.type === 'text')
        expect(text && text.type === 'text' ? text.text : '').toContain('请求失败')
      }
    }
    expect(out.every((p) => p.kind !== 'result')).toBe(true)
  })

  it('同 turn 的 stream delta / turn_end 共用 assistant.uuid', () => {
    const ts = 1_700_000_000_000
    const assistant = makeAssistant({ stopReason: 'stop', text: 'hello' })
    assistant.timestamp = ts

    const deltaOut = piEventToIR(
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'hel',
          partial: assistant,
        },
      } as AgentEvent,
      'sess-1',
    )
    expect(deltaOut).toEqual([
      { kind: 'stream_text_delta', text: 'hel', uuid: `pi-sess-1-${ts}` },
    ])

    const endOut = piEventToIR(
      {
        type: 'turn_end',
        message: assistant,
        toolResults: [],
      } as AgentEvent,
      'sess-1',
    )
    expect(endOut).toHaveLength(1)
    if (endOut[0]?.kind === 'sdk_message' && endOut[0].message.type === 'assistant') {
      expect(endOut[0].message.uuid).toBe(`pi-sess-1-${ts}`)
    }
  })

  it('agent_end(error) 推唯一 error_during_execution result 且带 errors', () => {
    const event = {
      type: 'agent_end',
      messages: [
        makeAssistant({
          stopReason: 'error',
          errorMessage: 'maximum context length exceeded',
          usage: { ...emptyUsage, input: 100, output: 0, totalTokens: 100 },
        }),
      ],
    } as AgentEvent

    const out = piEventToIR(event, 'sess-1')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'result',
      subtype: 'error_during_execution',
      errors: ['maximum context length exceeded'],
    })
  })

  it('agent_end(length) → max_tokens', () => {
    const event = {
      type: 'agent_end',
      messages: [makeAssistant({ stopReason: 'length', text: 'partial…' })],
    } as AgentEvent

    const out = piEventToIR(event, 'sess-1')
    expect(out).toEqual([
      expect.objectContaining({ kind: 'result', subtype: 'max_tokens' }),
    ])
  })

  it('agent_end(stop) → success', () => {
    const event = {
      type: 'agent_end',
      messages: [makeAssistant({ stopReason: 'stop', text: 'done' })],
    } as AgentEvent

    const out = piEventToIR(event, 'sess-1')
    expect(out).toEqual([expect.objectContaining({ kind: 'result', subtype: 'success' })])
  })

  it('agent_end 取最后一条 assistant 的 stopReason（工具轮后错误）', () => {
    const event = {
      type: 'agent_end',
      messages: [
        makeAssistant({ stopReason: 'toolUse', text: 'calling…' }),
        { role: 'toolResult', toolCallId: 't1', toolName: 'Read', content: [], isError: false, timestamp: 1 },
        makeAssistant({
          stopReason: 'error',
          errorMessage: 'upstream 500',
          text: '',
        }),
      ],
    } as AgentEvent

    const out = piEventToIR(event, 'sess-1')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'result',
      subtype: 'error_during_execution',
      errors: ['upstream 500'],
    })
  })

  it('message_end(error) + agent_end 合计只有一条 result（回归双 result）', () => {
    const errAssistant = makeAssistant({
      stopReason: 'error',
      errorMessage: 'boom',
      text: '',
    })
    const fromMessageEnd = piEventToIR(
      { type: 'message_end', message: errAssistant } as AgentEvent,
      'sess-1',
    )
    const fromAgentEnd = piEventToIR(
      { type: 'agent_end', messages: [errAssistant] } as AgentEvent,
      'sess-1',
    )
    const results = [...fromMessageEnd, ...fromAgentEnd].filter((p) => p.kind === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ subtype: 'error_during_execution', errors: ['boom'] })
  })
})

describe('工具双发修复（toolcall_end / tool_execution_start / turn_end）', () => {
  it('toolcall_end 不推 tool_use sdk_message', () => {
    const out = piEventToIR(
      {
        type: 'message_update',
        message: makeAssistant({ stopReason: 'toolUse', text: '' }),
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 'tc-1', name: 'Read', arguments: { path: 'a.ts' } },
          partial: makeAssistant({ stopReason: 'toolUse', text: '' }),
        },
      } as AgentEvent,
      'sess-1',
    )
    expect(out).toEqual([])
  })

  it('tool_execution_start 推进行中 tool_use（无 stop_reason）', () => {
    const out = piEventToIR(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'Read',
        args: { path: 'a.ts' },
      } as AgentEvent,
      'sess-1',
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'tc-1', name: 'Read', input: { path: 'a.ts' } }],
      },
    })
    if (out[0]?.kind === 'sdk_message' && out[0].message.type === 'assistant') {
      expect(out[0].message.stop_reason).toBeUndefined()
    }
  })

  it('turn_end 仍推 tool_use + tool_result（终态唯一完整卡片）', () => {
    const assistant = makeAssistant({ stopReason: 'toolUse', text: '' })
    assistant.content = [
      { type: 'toolCall', id: 'tc-1', name: 'Read', arguments: { path: 'a.ts' } },
    ] as AssistantMessage['content']

    const out = piEventToIR(
      {
        type: 'turn_end',
        message: assistant,
        toolResults: [
          {
            role: 'toolResult',
            toolCallId: 'tc-1',
            toolName: 'Read',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      } as AgentEvent,
      'sess-1',
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        stop_reason: 'toolUse',
        content: [{ type: 'tool_use', id: 'tc-1', name: 'Read' }],
      },
    })
    expect(out[1]).toMatchObject({
      kind: 'sdk_message',
      message: {
        type: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tc-1', content: 'ok' }],
      },
    })
  })
})

describe('isRetryablePiTurnError', () => {
  it('网络 / 超时 / 5xx / 429 可重试', () => {
    expect(isRetryablePiTurnError('Request timed out.')).toBe(true)
    expect(isRetryablePiTurnError('ETIMEDOUT')).toBe(true)
    expect(isRetryablePiTurnError('fetch failed')).toBe(true)
    expect(isRetryablePiTurnError('ECONNRESET')).toBe(true)
    expect(isRetryablePiTurnError('upstream 502 Bad Gateway')).toBe(true)
    expect(isRetryablePiTurnError('503 Service Unavailable')).toBe(true)
    expect(isRetryablePiTurnError('HTTP 500 Internal Server Error')).toBe(true)
    expect(isRetryablePiTurnError('429 Too Many Requests')).toBe(true)
    expect(isRetryablePiTurnError('rate limit exceeded')).toBe(true)
  })

  it('鉴权 / 余额 / 用户拒绝 不可重试', () => {
    expect(isRetryablePiTurnError('401 Unauthorized')).toBe(false)
    expect(isRetryablePiTurnError('Invalid API Key')).toBe(false)
    expect(isRetryablePiTurnError('authentication failed')).toBe(false)
    expect(isRetryablePiTurnError('insufficient_quota')).toBe(false)
    expect(isRetryablePiTurnError('余额不足')).toBe(false)
    expect(isRetryablePiTurnError('Request aborted')).toBe(false)
    expect(isRetryablePiTurnError('user rejected permission')).toBe(false)
  })

  it('未知文案默认不重试', () => {
    expect(isRetryablePiTurnError('something weird happened')).toBe(false)
    expect(isRetryablePiTurnError('')).toBe(false)
  })
})

describe('piTurnRetryDelayMs', () => {
  it('指数退避 1s → 2s → 4s', () => {
    expect(piTurnRetryDelayMs(0)).toBe(PI_TURN_RETRY_BASE_DELAY_MS)
    expect(piTurnRetryDelayMs(1)).toBe(PI_TURN_RETRY_BASE_DELAY_MS * 2)
    expect(piTurnRetryDelayMs(2)).toBe(PI_TURN_RETRY_BASE_DELAY_MS * 4)
  })
})

describe('dropTrailingFailedAssistants', () => {
  it('剥离末尾 error/aborted assistant，保留工具结果与 user', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'hi', timestamp: 1 } as AgentMessage,
      makeAssistant({ stopReason: 'toolUse', text: 'call' }),
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'Read',
        content: [],
        isError: false,
        timestamp: 2,
      } as AgentMessage,
      makeAssistant({ stopReason: 'error', errorMessage: 'timeout', text: '' }),
    ]
    const next = dropTrailingFailedAssistants(msgs)
    expect(next).toHaveLength(3)
    expect(next[next.length - 1]?.role).toBe('toolResult')
  })

  it('不改动成功结束的 transcript', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'hi', timestamp: 1 } as AgentMessage,
      makeAssistant({ stopReason: 'stop', text: 'done' }),
    ]
    expect(dropTrailingFailedAssistants(msgs)).toHaveLength(2)
  })
})
