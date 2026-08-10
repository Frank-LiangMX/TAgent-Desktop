/**
 * CodexStreamObserver 单测：fixture 驱动 + 解析规则覆盖。
 *
 * 验收对齐 SLICE-4 brief：
 * - `codex-json.stdout.txt` → summary `CODEX_JSON_OK`，无工具
 * - `codex-tool.stdout.txt`  → 有 tool 次（command_execution）、summary 含 `TOOL_DONE`、toolResult isError
 * - thread/turn 忽略；item.started command_execution → toolUse；item.completed command_execution → toolResult；
 *   item.completed agent_message → text
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CodexStreamObserver } from './codex-stream-observer'

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

describe('CodexStreamObserver · fixture 驱动', () => {
  it('codex-json.stdout.txt → summary 为 CODEX_JSON_OK，无工具', () => {
    const obs = new CodexStreamObserver()
    for (const line of readLines('codex-json.stdout.txt')) obs.onLine(line)
    expect(obs.getSummary()).toBe('CODEX_JSON_OK')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('codex-tool.stdout.txt → 1 次 command_execution、summary 含 TOOL_DONE、toolResult isError', () => {
    const obs = new CodexStreamObserver()
    const toolNames: string[] = []
    let toolResult: { content: string; isError?: boolean } | undefined
    for (const line of readLines('codex-tool.stdout.txt')) {
      const r = obs.onLine(line)
      if (r.lastToolName) toolNames.push(r.lastToolName)
      if (r.toolResult) toolResult = r.toolResult
    }
    expect(obs.getToolCallCount()).toBe(1)
    expect(obs.getSummary()).toContain('TOOL_DONE')
    expect(toolNames).toEqual(['command_execution'])
    // fixture 里 command_execution status=failed（sandbox 错误）
    expect(toolResult?.isError).toBe(true)
    expect(toolResult?.content).toContain('execution error')
  })

  it('codex-tool.stdout.txt → toolUse.input.command 含 pwsh 命令', () => {
    const obs = new CodexStreamObserver()
    let toolUse: { name: string; input: { command?: string } } | undefined
    for (const line of readLines('codex-tool.stdout.txt')) {
      const r = obs.onLine(line)
      if (r.toolUse) toolUse = r.toolUse
    }
    expect(toolUse?.name).toBe('command_execution')
    expect(toolUse?.input.command).toContain('Get-ChildItem')
  })
})

describe('CodexStreamObserver · 解析规则', () => {
  it('忽略非 JSON / 空行', () => {
    const obs = new CodexStreamObserver()
    expect(obs.onLine('not json')).toEqual({})
    expect(obs.onLine('')).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('item.started command_execution → toolUse + lastToolName + 计数', () => {
    const obs = new CodexStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: "pwsh -Command 'ls'",
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      }),
    )
    expect(r.lastToolName).toBe('command_execution')
    expect(r.toolUse).toEqual({
      id: 'item_1',
      name: 'command_execution',
      input: { command: "pwsh -Command 'ls'" },
    })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('item.completed command_execution(failed) → toolResult isError', () => {
    const obs = new CodexStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'execution error: boom',
          exit_code: -1,
          status: 'failed',
        },
      }),
    )
    expect(r.toolResult).toEqual({ toolUseId: 'item_1', content: 'execution error: boom', isError: true })
  })

  it('item.completed command_execution(success) → toolResult 无 isError', () => {
    const obs = new CodexStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          aggregated_output: 'file_a\nfile_b',
          status: 'completed',
        },
      }),
    )
    expect(r.toolResult).toEqual({ toolUseId: 'item_1', content: 'file_a\nfile_b' })
  })

  it('item.completed agent_message → textChunk + 累积 summary', () => {
    const obs = new CodexStreamObserver()
    const r = obs.onLine(
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hi' } }),
    )
    expect(r.textChunk).toBe('hi')
    obs.onLine(
      JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: ' there' } }),
    )
    expect(obs.getSummary()).toBe('hi there')
  })

  it('thread.started / turn.started / turn.completed 忽略', () => {
    const obs = new CodexStreamObserver()
    obs.onLine(JSON.stringify({ type: 'thread.started', thread_id: 't' }))
    obs.onLine(JSON.stringify({ type: 'turn.started' }))
    obs.onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }))
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('item.started 非 command_execution（如 agent_message started）→ 忽略', () => {
    const obs = new CodexStreamObserver()
    const r = obs.onLine(
      JSON.stringify({ type: 'item.started', item: { id: 'i', type: 'agent_message' } }),
    )
    expect(r).toEqual({})
    expect(obs.getToolCallCount()).toBe(0)
  })
})
