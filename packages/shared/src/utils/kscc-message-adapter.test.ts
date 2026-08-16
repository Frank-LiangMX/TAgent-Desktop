import { describe, expect, test } from 'vitest'
import { sdkMessageToIR } from './kscc-message-adapter'

describe('sdkMessageToIR - partial / stop_reason（REGRESS-E）', () => {
  test('assistant 显式 _partial:true → IR 带 _partial:true', () => {
    const msg = {
      type: 'assistant',
      uuid: 'u-1',
      parent_tool_use_id: null,
      session_id: 's-1',
      _partial: true,
      message: {
        content: [{ type: 'text', text: '你好 ' }],
      },
    } as never

    const { message } = sdkMessageToIR(msg)
    expect(message).toBeDefined()
    expect(message!.type).toBe('assistant')
    expect((message as { _partial?: boolean })._partial).toBe(true)
  })

  test('无 stop_reason 且无 _partial → 推断为 partial（kscc 常不打标）', () => {
    const msg = {
      type: 'assistant',
      uuid: 'u-snap',
      parent_tool_use_id: null,
      session_id: 's-1',
      message: {
        content: [{ type: 'thinking', thinking: '先看目录' }],
      },
    } as never

    const { message } = sdkMessageToIR(msg)
    expect((message as { _partial?: boolean })._partial).toBe(true)
    expect((message as { stop_reason?: string }).stop_reason).toBeUndefined()
  })

  test('有 stop_reason → final：透传 stop_reason，不带 _partial', () => {
    const msg = {
      type: 'assistant',
      uuid: 'u-2',
      parent_tool_use_id: null,
      session_id: 's-1',
      message: {
        content: [{ type: 'text', text: '完整回答' }],
        stop_reason: 'end_turn',
      },
    } as never

    const { message } = sdkMessageToIR(msg)
    expect(message).toBeDefined()
    expect((message as { _partial?: boolean })._partial).toBeUndefined()
    expect((message as { stop_reason?: string }).stop_reason).toBe('end_turn')
  })

  test('stop_reason=tool_use → final（可进工具），不带 _partial', () => {
    const msg = {
      type: 'assistant',
      uuid: 'u-3',
      parent_tool_use_id: null,
      session_id: 's-1',
      message: {
        content: [
          { type: 'thinking', thinking: '要跑命令' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
    } as never

    const { message } = sdkMessageToIR(msg)
    expect((message as { _partial?: boolean })._partial).toBeUndefined()
    expect((message as { stop_reason?: string }).stop_reason).toBe('tool_use')
  })

  test('stream_event 路径不受影响（控制事件，不带 _partial）', () => {
    const msg = {
      type: 'stream_event',
      uuid: 'u-4',
      parent_tool_use_id: null,
      session_id: 's-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    } as never

    const { message, event } = sdkMessageToIR(msg)
    expect(message).toBeUndefined()
    expect(event).toEqual({
      kind: 'stream_text_delta',
      text: 'hi',
      parentToolUseId: undefined,
      uuid: 'u-4',
    })
  })

  test('user 顶层 attachments 透传到 IR（旁路后历史回放不能丢图）', () => {
    const msg = {
      type: 'user',
      createdAt: 1,
      message: { role: 'user', content: [{ type: 'text', text: '分析一下图片' }] },
      attachments: [
        {
          id: 'a1',
          filename: 'shot.png',
          mediaType: 'image/png',
          localPath: 's1/shot.png',
          size: 12,
        },
      ],
    } as never

    const { message } = sdkMessageToIR(msg)
    expect(message?.type).toBe('user')
    expect((message as { attachments?: unknown[] }).attachments).toEqual([
      {
        id: 'a1',
        filename: 'shot.png',
        mediaType: 'image/png',
        localPath: 's1/shot.png',
        size: 12,
      },
    ])
  })
})
