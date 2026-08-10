/**
 * ClaudeStreamObserver 单测：fixture 驱动 + 解析规则覆盖。
 *
 * 本机未装 claude，无法采真流；fixture 按 Claude Code stream-json 文档建模
 * （顶层 type：system / assistant / user / result；assistant.content 为
 * text + tool_use 块；user.content 为 tool_result；result 带 is_error / errors[]），
 * 不依赖任何真实 claude 调用。
 *
 * 验收对齐本文件实现契约：
 * - system init → 忽略
 * - assistant text 块 → textChunk + summary 累积（多块拼接）
 * - assistant tool_use（Bash）→ toolUse + lastToolName=command + 计数
 * - 工具名映射表全量断言（Bash/Edit/Read/WebSearch/Task + 小写变体）
 * - user tool_result → toolResult 匹配 tool_use_id，is_error 透传
 * - result success → summary = result 字符串
 * - result is_error:true（含 subtype="success" 的已知怪例）→ getError()，summary 不混入
 * - result subtype 以 error 开头 → getError()
 */
import { describe, expect, it } from 'vitest'
import { ClaudeStreamObserver } from './claude-stream-observer'
import type { CliStreamObserver } from './run-ndjson-cli'

/** 单行 JSON 事件 → 字符串 */
function ev(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('ClaudeStreamObserver 路 解析规则', () => {
  it('忽略非 JSON / 空行', () => {
    const obs = new ClaudeStreamObserver()
    expect(obs.onLine('not json')).toEqual({})
    expect(obs.onLine('')).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
    expect(obs.getError()).toBeUndefined()
  })

  it('system init → 忽略（不计数、不产 hit）', () => {
    const obs = new ClaudeStreamObserver()
    const r = obs.onLine(ev({ type: 'system', subtype: 'init', session_id: 'sess_1' }))
    expect(r).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('assistant 文本块 → textChunk + 累积 summary（多块拼接）', () => {
    const obs = new ClaudeStreamObserver()
    const r1 = obs.onLine(
      ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'CLAUDE_' }] } }),
    )
    const r2 = obs.onLine(
      ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }),
    )
    expect(r1.textChunk).toBe('CLAUDE_')
    expect(r2.textChunk).toBe('OK')
    expect(obs.getSummary()).toBe('CLAUDE_OK')
  })

  it('assistant 单条 content 同时含 text + tool_use → 文本与工具各就其位', () => {
    const obs = new ClaudeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    )
    expect(r.textChunk).toBe('let me check')
    expect(r.lastToolName).toBe('command')
    expect(r.toolUse).toEqual({ id: 'toolu_1', name: 'command', input: { command: 'ls' } })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('user tool_result → toolResult 匹配 tool_use_id，content 字符串透传', () => {
    const obs = new ClaudeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'entries' }] },
      }),
    )
    expect(r.toolResult).toEqual({ toolUseId: 'toolu_1', content: 'entries' })
  })

  it('tool_result content 为文本块数组 → 拼接；is_error:true → isError', () => {
    const obs = new ClaudeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              is_error: true,
              content: [{ type: 'text', text: 'boom: ' }, { type: 'text', text: 'permission denied' }],
            },
          ],
        },
      }),
    )
    expect(r.toolResult).toEqual({
      toolUseId: 'toolu_2',
      content: 'boom: permission denied',
      isError: true,
    })
  })

  it('缺 tool_use_id → 忽略该条', () => {
    const obs = new ClaudeStreamObserver()
    const r = obs.onLine(
      ev({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    )
    expect(r).toEqual({})
  })

  it('工具名映射表全量断言（大写 Claude 风格 + 小写变体）', () => {
    const cases: Array<[string, string]> = [
      ['Bash', 'command'],
      ['bash', 'command'],
      ['Shell', 'command'],
      ['Edit', 'file'],
      ['Write', 'file'],
      ['MultiEdit', 'file'],
      ['edit', 'file'],
      ['Read', 'tool'],
      ['Glob', 'tool'],
      ['Grep', 'tool'],
      ['WebSearch', 'web_search'],
      ['WebFetch', 'web_search'],
      ['Task', 'tool'],
      ['CustomTool', 'CustomTool'],
    ]
    for (const [tool, expected] of cases) {
      const obs = new ClaudeStreamObserver()
      const r = obs.onLine(
        ev({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: `id_${tool}`, name: tool, input: {} }] },
        }),
      )
      expect(r.lastToolName, `tool=${tool}`).toBe(expected)
      expect(r.toolUse?.name, `tool=${tool}`).toBe(expected)
    }
  })

  it('缺 id → 兜底 claude-tool-N；缺 input → 空 input', () => {
    const obs = new ClaudeStreamObserver()
    const r = obs.onLine(
      ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
    )
    expect(r.toolUse?.id).toBe('claude-tool-1')
    expect(r.toolUse?.input).toEqual({})
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('result success → summary = result 字符串（终态优先于 textChunks）', () => {
    const obs = new ClaudeStreamObserver()
    obs.onLine(ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }))
    obs.onLine(
      ev({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'FINAL_ANSWER',
        errors: [],
      }),
    )
    expect(obs.getSummary()).toBe('FINAL_ANSWER')
    expect(obs.getError()).toBeUndefined()
  })

  it('result is_error:true（subtype="success" 的社区实证怪例）→ getError() 含 errors[] 消息', () => {
    const obs = new ClaudeStreamObserver()
    obs.onLine(ev({ type: 'text', part: 'x' })) // 非本协议事件 → 忽略
    obs.onLine(
      ev({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'API Error: rate limited',
        errors: [{ message: 'API Error: rate limited' }],
      }),
    )
    expect(obs.getError()).toContain('rate limited')
    // 原始 result 文本保留在 summary（与 kscc 一致）；失败判定以 getError() 为准，
    // runNdjsonCli finalize 用 getError() 组合 ok:false 的 summary（label 前缀 + 错误信息）
    expect(obs.getSummary()).toBe('API Error: rate limited')
  })

  it('result subtype 以 error 开头（无 is_error）→ getError() 兜底文案含 subtype', () => {
    const obs = new ClaudeStreamObserver()
    obs.onLine(ev({ type: 'result', subtype: 'error_during_execution', result: 'failed', errors: [] }))
    expect(obs.getError()).toContain('error_during_execution')
  })

  it('errors[] 为字符串数组 → 拼接进 getError()', () => {
    const obs = new ClaudeStreamObserver()
    obs.onLine(ev({ type: 'result', subtype: 'error_x', is_error: true, errors: ['first', 'second'] }))
    expect(obs.getError()).toBe('first; second')
  })
})

describe('ClaudeStreamObserver 路 CliStreamObserver 契约', () => {
  it('implements CliStreamObserver（含 getError）', () => {
    const obs: CliStreamObserver = new ClaudeStreamObserver()
    expect(typeof obs.onLine).toBe('function')
    expect(typeof obs.getSummary).toBe('function')
    expect(typeof obs.getToolCallCount).toBe('function')
    expect(typeof obs.getError).toBe('function')
  })
})
