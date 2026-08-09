/**
 * moa-persist 纯函数单测（P0 #2 · AUDIT-fresh-session-consult）：
 * 断言 `buildMoAFinalAssistantSDKMessage` 产出的 SDKMessage shape 与普通 assistant 对齐、
 * 且补齐 `message.role:'assistant'`（利于后续 resume / IR）。
 */
import { describe, expect, it } from 'vitest'
import { buildMoAFinalAssistantSDKMessage } from './moa-persist'

type AssistantShape = {
  type: string
  message: {
    role: string
    content: Array<{ type: string; text: string }>
    stop_reason: string
    model: string
  }
  parent_tool_use_id: string | null
  uuid: string
  createdAt: number
  _channelModelId: string
}

describe('buildMoAFinalAssistantSDKMessage (P0 #2 落盘 shape)', () => {
  const msg = buildMoAFinalAssistantSDKMessage(
    '汇总结论：1. 第一 2. 第二',
    'glm-5.2',
    'moa-agg-moa-rt-sess-0',
    1_000,
  ) as unknown as AssistantShape

  it('produces type: "assistant" at top level', () => {
    expect(msg.type).toBe('assistant')
  })

  it('sets message.role: "assistant" (AUDIT 缺失项；利于 resume / IR 识别角色)', () => {
    expect(msg.message.role).toBe('assistant')
  })

  it('carries aggregator text in message.content[0]', () => {
    expect(msg.message.content).toEqual([
      { type: 'text', text: '汇总结论：1. 第一 2. 第二' },
    ])
  })

  it('sets stop_reason: "end_turn" (sdkMessageToIR 据此判 final 非 partial)', () => {
    expect(msg.message.stop_reason).toBe('end_turn')
  })

  it('records aggregator modelId in message.model + _channelModelId (匹配显示名)', () => {
    expect(msg.message.model).toBe('glm-5.2')
    expect(msg._channelModelId).toBe('glm-5.2')
  })

  it('carries uuid (moa-agg-*) + parent_tool_use_id null + createdAt', () => {
    expect(msg.uuid).toBe('moa-agg-moa-rt-sess-0')
    expect(msg.parent_tool_use_id).toBeNull()
    expect(msg.createdAt).toBe(1_000)
  })

  it('round-trips through sdkMessageToIR as a final (non-partial) assistant', async () => {
    const { sdkMessageToIR } = await import('../utils/kscc-message-adapter')
    const { message } = sdkMessageToIR(
      buildMoAFinalAssistantSDKMessage('结论', 'glm-5.2', 'moa-agg-x', 0),
    )
    expect(message?.type).toBe('assistant')
    // stop_reason='end_turn' → 非 partial（不被标 _partial）
    expect(message).not.toHaveProperty('_partial')
  })
})
