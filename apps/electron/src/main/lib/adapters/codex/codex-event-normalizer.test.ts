import { describe, expect, it } from 'vitest'
import { CodexEventNormalizer } from './codex-event-normalizer'
import type { RoutedCodexNotification } from './codex-app-server-session-manager'

function notification(
  method: string,
  params: Record<string, unknown>,
): RoutedCodexNotification {
  return {
    method,
    params: { threadId: 'thr_1', ...params },
    tagentSessionId: 'sess_1',
    threadId: 'thr_1',
  }
}

describe('CodexEventNormalizer', () => {
  it('把 agent/reasoning delta 映射到统一流式事件', () => {
    const normalizer = new CodexEventNormalizer()
    expect(
      normalizer.feed(
        notification('item/agentMessage/delta', {
          turnId: 'turn_1',
          itemId: 'item_text',
          delta: '完成',
        }),
      ),
    ).toEqual([
      {
        kind: 'stream_text_delta',
        text: '完成',
        uuid: 'item_text',
      },
    ])
    expect(
      normalizer.feed(
        notification('item/reasoning/summaryTextDelta', {
          turnId: 'turn_1',
          itemId: 'item_reasoning',
          delta: '分析中',
          summaryIndex: 0,
        }),
      ),
    ).toEqual([
      {
        kind: 'stream_thinking_delta',
        text: '分析中',
        uuid: 'item_reasoning',
      },
    ])
  })

  it('把命令生命周期映射为 tool_use + tool_result', () => {
    const normalizer = new CodexEventNormalizer()
    const started = normalizer.feed(
      notification('item/started', {
        turnId: 'turn_1',
        startedAtMs: 100,
        item: {
          type: 'commandExecution',
          id: 'cmd_1',
          command: 'bun test',
          cwd: 'F:\\repo',
          status: 'inProgress',
        },
      }),
    )
    expect(started).toEqual([
      {
        kind: 'sdk_message',
        message: expect.objectContaining({
          type: 'assistant',
          uuid: 'cmd_1',
          _partial: true,
          content: [
            {
              type: 'tool_use',
              id: 'cmd_1',
              name: 'Bash',
              input: { command: 'bun test', cwd: 'F:\\repo' },
            },
          ],
        }),
      },
    ])

    const completed = normalizer.feed(
      notification('item/completed', {
        turnId: 'turn_1',
        completedAtMs: 200,
        item: {
          type: 'commandExecution',
          id: 'cmd_1',
          command: 'bun test',
          cwd: 'F:\\repo',
          status: 'completed',
          aggregatedOutput: '19 passed',
          exitCode: 0,
        },
      }),
    )
    expect(completed).toHaveLength(2)
    expect(completed[0]).toEqual(
      expect.objectContaining({
        kind: 'sdk_message',
        message: expect.objectContaining({
          type: 'assistant',
          uuid: 'cmd_1',
        }),
      }),
    )
    expect(completed[1]).toEqual(
      expect.objectContaining({
        kind: 'sdk_message',
        message: expect.objectContaining({
          type: 'user',
          parentToolUseId: 'cmd_1',
          content: [
            expect.objectContaining({
              type: 'tool_result',
              toolUseId: 'cmd_1',
              content: '19 passed\nexit code: 0',
              isError: false,
            }),
          ],
        }),
      }),
    )
  })

  it('把 Dynamic Tool 生命周期映射为 tool_use + tool_result', () => {
    const normalizer = new CodexEventNormalizer()
    expect(
      normalizer.feed(
        notification('item/started', {
          turnId: 'turn_1',
          item: {
            type: 'dynamicToolCall',
            id: 'tool_1',
            namespace: null,
            tool: 'kb_search',
            arguments: { query: 'App Server' },
            status: 'inProgress',
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'sdk_message',
        message: expect.objectContaining({
          type: 'assistant',
          uuid: 'tool_1',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'kb_search',
              input: { query: 'App Server' },
            },
          ],
        }),
      },
    ])

    const completed = normalizer.feed(
      notification('item/completed', {
        turnId: 'turn_1',
        item: {
          type: 'dynamicToolCall',
          id: 'tool_1',
          namespace: null,
          tool: 'kb_search',
          arguments: { query: 'App Server' },
          contentItems: [
            { type: 'inputText', text: '错误：知识库不可用' },
          ],
          success: false,
          status: 'failed',
        },
      }),
    )
    expect(completed).toHaveLength(2)
    expect(completed[1]).toEqual(
      expect.objectContaining({
        kind: 'sdk_message',
        message: expect.objectContaining({
          type: 'user',
          parentToolUseId: 'tool_1',
          content: [
            expect.objectContaining({
              type: 'tool_result',
              toolUseId: 'tool_1',
              isError: true,
            }),
          ],
        }),
      }),
    )
  })

  it('在 turn/completed 输出 usage 和结构化错误', () => {
    const normalizer = new CodexEventNormalizer()
    normalizer.feed(
      notification('thread/tokenUsage/updated', {
        turnId: 'turn_1',
        tokenUsage: {
          last: {
            inputTokens: 120,
            cachedInputTokens: 80,
            outputTokens: 30,
          },
        },
      }),
    )
    expect(
      normalizer.feed(
        notification('turn/completed', {
          turn: {
            id: 'turn_1',
            status: 'failed',
            error: { message: '额度不足' },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'result',
        subtype: 'failed',
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 80,
        },
        errors: ['额度不足'],
      },
    ])
  })
})
