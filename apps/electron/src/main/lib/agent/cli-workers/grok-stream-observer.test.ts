/**
 * GrokStreamObserver 单测：fixture 驱动 + 解析规则覆盖。
 *
 * 验收对齐 SLICE-4 brief：
 * - `grok-stream.stdout.txt` → summary `GROK_STREAM_OK`，无工具
 * - `grok-tool.stdout.txt`  → 有 tool 次、summary 含 `TOOL_DONE`、toolResult 非空
 * - thought/available_commands/usage/end 忽略；text 累积；tool_call/tool_call_update 解析
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GrokStreamObserver } from './grok-stream-observer'

const here = dirname(fileURLToPath(import.meta.url))

/** 从测试文件目录向上找 `docs/dev/cli-probe-2026-08-10`（robust to 目录深度变化）。 */
function findProbeDir(): string {
  let dir = here
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'docs', 'dev', 'cli-probe-2026-08-10')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(here, '..', '..', '..', '..', '..', '..', '..', 'docs', 'dev', 'cli-probe-2026-08-10')
}

/** 读 fixture 为行数组（兼容 CRLF） */
function readLines(name: string): string[] {
  return readFileSync(join(findProbeDir(), name), 'utf8').split(/\r?\n/)
}

describe('GrokStreamObserver · fixture 驱动', () => {
  it('grok-stream.stdout.txt → summary 为 GROK_STREAM_OK，无工具', () => {
    const obs = new GrokStreamObserver()
    for (const line of readLines('grok-stream.stdout.txt')) obs.onLine(line)
    expect(obs.getSummary()).toBe('GROK_STREAM_OK')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('grok-tool.stdout.txt → 有工具次数、summary 含 TOOL_DONE、toolResult 非空', () => {
    const obs = new GrokStreamObserver()
    const toolNames: string[] = []
    let toolResultContent = ''
    for (const line of readLines('grok-tool.stdout.txt')) {
      const r = obs.onLine(line)
      if (r.lastToolName) toolNames.push(r.lastToolName)
      if (r.toolResult) toolResultContent = r.toolResult.content
    }
    expect(obs.getToolCallCount()).toBe(1)
    expect(obs.getSummary()).toBe('TOOL_DONE')
    // tool_call 是 list_dir
    expect(toolNames).toContain('list_dir')
    // tool_call_update(completed) 的 rawOutput 已 stringify
    expect(toolResultContent).toContain('ListDir')
  })
})

describe('GrokStreamObserver · 解析规则', () => {
  it('忽略非 JSON / 空行', () => {
    const obs = new GrokStreamObserver()
    expect(obs.onLine('not json')).toEqual({})
    expect(obs.onLine('')).toEqual({})
    expect(obs.onLine('   ')).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('text 分片累积进 summary 并回传 textChunk', () => {
    const obs = new GrokStreamObserver()
    const r1 = obs.onLine(JSON.stringify({ type: 'text', data: 'GRO' }))
    const r2 = obs.onLine(JSON.stringify({ type: 'text', data: 'K' }))
    expect(r1.textChunk).toBe('GRO')
    expect(r2.textChunk).toBe('K')
    expect(obs.getSummary()).toBe('GROK')
  })

  it('thought 被忽略（不计工具、不进 summary、不回传 textChunk）', () => {
    const obs = new GrokStreamObserver()
    const r = obs.onLine(JSON.stringify({ type: 'thought', data: 'reasoning' }))
    expect(r).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('tool_call 解析为 toolUse（id/name/input）+ lastToolName + 计数', () => {
    const obs = new GrokStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'tool_call',
        toolCallId: 'call-xyz',
        toolName: 'list_dir',
        rawInput: { target_directory: '.' },
        status: 'pending',
      }),
    )
    expect(r.lastToolName).toBe('list_dir')
    expect(r.toolUse).toEqual({ id: 'call-xyz', name: 'list_dir', input: { target_directory: '.' } })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('tool_call 缺 toolCallId → 兜底 id；缺 rawInput → 空 input', () => {
    const obs = new GrokStreamObserver()
    const r = obs.onLine(JSON.stringify({ type: 'tool_call', toolName: 'grep' }))
    expect(r.toolUse?.id).toBe('grok-tool-1')
    expect(r.toolUse?.input).toEqual({})
  })

  it('tool_call_update status=completed 且有 rawOutput → toolResult（content=stringify）', () => {
    const obs = new GrokStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'call-xyz',
        status: 'completed',
        rawOutput: { type: 'ListDir', Content: { content: 'a\nb' } },
      }),
    )
    expect(r.toolResult).toEqual({
      toolUseId: 'call-xyz',
      content: JSON.stringify({ type: 'ListDir', Content: { content: 'a\nb' } }),
    })
  })

  it('tool_call_update 中间态（status=null / rawOutput=null）→ 忽略', () => {
    const obs = new GrokStreamObserver()
    const r1 = obs.onLine(
      JSON.stringify({ type: 'tool_call_update', toolCallId: 'c', status: null, rawOutput: null }),
    )
    expect(r1).toEqual({})
    // status 非 completed 也忽略
    const r2 = obs.onLine(
      JSON.stringify({ type: 'tool_call_update', toolCallId: 'c', status: 'running', rawOutput: 'x' }),
    )
    expect(r2).toEqual({})
  })

  it('available_commands / usage / end 忽略（不计工具、不进 summary）', () => {
    const obs = new GrokStreamObserver()
    obs.onLine(JSON.stringify({ type: 'available_commands', tools: ['run_terminal_command'], commands: [] }))
    obs.onLine(JSON.stringify({ type: 'usage', usage: { input_tokens: 1 } }))
    obs.onLine(
      JSON.stringify({ type: 'end', stopReason: 'end_turn', usage: { total_tokens: 1 }, total_cost_usd: 0 }),
    )
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })
})
