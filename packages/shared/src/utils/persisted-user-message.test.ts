/**
 * persisted-user-message 单测
 *
 * 覆盖：isControlUserTextBlock 控制文哨兵（中断 / 拒工具 / 续聊摘要）、
 * isPersistedRealUserMessage 真实用户输入识别（控制文 / tool_result-only / steer 排除）。
 * 纯函数，node 环境直接跑（对齐 vitest.config.ts environment: 'node'）。
 */
import { describe, expect, test } from 'vitest'
import {
  isControlUserTextBlock,
  isPersistedRealUserMessage,
  extractPersistedUserText,
} from './persisted-user-message'

describe('isControlUserTextBlock', () => {
  test('识别 kscc 续聊摘要为控制文（不进主线用户气泡）', () => {
    expect(
      isControlUserTextBlock(
        'This session is being continued from a previous conversation that ran out of context.',
      ),
    ).toBe(true)
  })

  test('续聊摘要带前导空白仍识别（trim）', () => {
    expect(
      isControlUserTextBlock(
        '  This session is being continued from a previous conversation. Summary of work so far…',
      ),
    ).toBe(true)
  })

  test('识别中文续接摘要变体', () => {
    expect(isControlUserTextBlock('[会话已从上一段上下文续接] 继续上一段工作')).toBe(true)
  })

  test('既有中断 / 拒工具哨兵仍识别', () => {
    expect(isControlUserTextBlock('[Request interrupted by user for tool use]')).toBe(true)
    expect(isControlUserTextBlock('[Request cancelled by the user]')).toBe(true)
    expect(
      isControlUserTextBlock("The user doesn't want to proceed with this tool use"),
    ).toBe(true)
    expect(isControlUserTextBlock('Permission for Bash was denied')).toBe(true)
  })

  test('真实用户输入不是控制文', () => {
    expect(isControlUserTextBlock('接着开发权限 enforce 那一刀')).toBe(false)
    expect(isControlUserTextBlock('帮我把这两个文件合并')).toBe(false)
    expect(isControlUserTextBlock('')).toBe(false)
    expect(isControlUserTextBlock('   ')).toBe(false)
  })
})

describe('isPersistedRealUserMessage', () => {
  test('续聊摘要 user 行不算真实用户输入（SDK message 包装形态）', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This session is being continued from a previous conversation that ran out of context.',
          },
        ],
      },
    }
    expect(isPersistedRealUserMessage(msg)).toBe(false)
  })

  test('续聊摘要 user 行不算真实用户输入（IR content 形态）', () => {
    const msg = {
      type: 'user',
      content: [
        {
          type: 'text',
          text: 'This session is being continued from a previous conversation.',
        },
      ],
    }
    expect(isPersistedRealUserMessage(msg)).toBe(false)
  })

  test('真实用户输入行算真实用户输入', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '接着开发权限 enforce 那一刀' }],
      },
    }
    expect(isPersistedRealUserMessage(msg)).toBe(true)
  })

  test('仅 tool_result 的 user 行不算真实用户输入', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
      },
    }
    expect(isPersistedRealUserMessage(msg)).toBe(false)
  })

  test('steer 用户输入排除', () => {
    const msg = {
      type: 'user',
      isSteer: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '把范围收窄到渲染层' }],
      },
    }
    expect(isPersistedRealUserMessage(msg)).toBe(false)
  })
})

describe('extractPersistedUserText', () => {
  test('提取 user 行纯文本（供撤回回填输入框）', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '帮我重构这个模块' }],
      },
    }
    expect(extractPersistedUserText(msg)).toBe('帮我重构这个模块')
  })

  test('续聊摘要仍可提取文本（控制文判定不影响提取本身）', () => {
    const msg = {
      type: 'user',
      content: [
        {
          type: 'text',
          text: 'This session is being continued from a previous conversation.',
        },
      ],
    }
    expect(extractPersistedUserText(msg)).toBe(
      'This session is being continued from a previous conversation.',
    )
  })
})
