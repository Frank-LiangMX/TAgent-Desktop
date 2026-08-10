/**
 * MimoStreamObserver 单测：fixture 驱动 + 解析规则覆盖。
 *
 * 验收对齐 SLICE-4 brief：
 * - `mimo-json.stdout.txt` → summary `MIMO_JSON_OK`，无工具
 * - `mimo-tool.stdout.txt`  → 1 次 tool（read）、summary 含 `TOOL_DONE`、一条 tool_use 同时产出 toolUse+toolResult
 * - step_start/step_finish 忽略；text 累积；tool_use 单条 completed 双发；callID 去重
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MimoStreamObserver } from './mimo-stream-observer'

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

describe('MimoStreamObserver · fixture 驱动', () => {
  it('mimo-json.stdout.txt → summary 为 MIMO_JSON_OK，无工具', () => {
    const obs = new MimoStreamObserver()
    for (const line of readLines('mimo-json.stdout.txt')) obs.onLine(line)
    expect(obs.getSummary()).toBe('MIMO_JSON_OK')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('mimo-tool.stdout.txt → 1 次 read、summary 含 TOOL_DONE、单条 tool_use 同时产出 toolUse+toolResult', () => {
    const obs = new MimoStreamObserver()
    const toolNames: string[] = []
    let toolUse: { name: string; input: Record<string, unknown> } | undefined
    let toolResult: { content: string; isError?: boolean } | undefined
    for (const line of readLines('mimo-tool.stdout.txt')) {
      const r = obs.onLine(line)
      if (r.lastToolName) toolNames.push(r.lastToolName)
      if (r.toolUse) toolUse = r.toolUse
      if (r.toolResult) toolResult = r.toolResult
    }
    expect(obs.getToolCallCount()).toBe(1)
    expect(obs.getSummary()).toBe('TOOL_DONE')
    expect(toolNames).toEqual(['read'])
    // toolUse: name=read，input 含 file_path
    expect(toolUse?.name).toBe('read')
    expect(toolUse?.input).toHaveProperty('file_path')
    // toolResult: content 是 read 的目录列表（含 <entries>）
    expect(toolResult?.content).toContain('<entries>')
    // 一条 completed → 非 error
    expect(toolResult?.isError).toBeUndefined()
  })
})

describe('MimoStreamObserver · 解析规则', () => {
  it('忽略非 JSON / 空行', () => {
    const obs = new MimoStreamObserver()
    expect(obs.onLine('not json')).toEqual({})
    expect(obs.onLine('')).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('text → textChunk + 累积 summary', () => {
    const obs = new MimoStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'text',
        part: { type: 'text', text: 'MIMO_OK' },
      }),
    )
    expect(r.textChunk).toBe('MIMO_OK')
    expect(obs.getSummary()).toBe('MIMO_OK')
  })

  it('tool_use 单条 completed → 同时产出 toolUse + toolResult（不计两次）', () => {
    const obs = new MimoStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          callID: 'call_1',
          state: { status: 'completed', input: { file_path: '/a' }, output: 'contents' },
        },
      }),
    )
    expect(r.lastToolName).toBe('read')
    expect(r.toolUse).toEqual({ id: 'call_1', name: 'read', input: { file_path: '/a' } })
    expect(r.toolResult).toEqual({ toolUseId: 'call_1', content: 'contents' })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('tool_use output 为对象 → toolResult.content = JSON.stringify', () => {
    const obs = new MimoStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'grep',
          callID: 'call_2',
          state: { status: 'completed', input: { pattern: 'x' }, output: { hits: 3 } },
        },
      }),
    )
    expect(r.toolResult?.content).toBe(JSON.stringify({ hits: 3 }))
  })

  it('tool_use status=failed → toolResult.isError=true', () => {
    const obs = new MimoStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call_3',
          state: { status: 'failed', input: {}, output: 'err' },
        },
      }),
    )
    expect(r.toolResult?.isError).toBe(true)
  })

  it('两段式 tool_use（in_progress → completed）按 callID 去重，仅计一次工具', () => {
    const obs = new MimoStreamObserver()
    // 第一段：新 callID，status=in_progress → 只 toolUse
    const r1 = obs.onLine(
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'read', callID: 'call_x', state: { status: 'in_progress', input: { file_path: '/a' } } },
      }),
    )
    expect(r1.toolUse).toBeDefined()
    expect(r1.toolResult).toBeUndefined()
    expect(obs.getToolCallCount()).toBe(1)
    // 第二段：同 callID，status=completed → 只 toolResult，不重复计数
    const r2 = obs.onLine(
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'read', callID: 'call_x', state: { status: 'completed', output: 'out' } },
      }),
    )
    expect(r2.toolUse).toBeUndefined()
    expect(r2.toolResult).toEqual({ toolUseId: 'call_x', content: 'out' })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('step_start / step_finish 忽略', () => {
    const obs = new MimoStreamObserver()
    obs.onLine(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }))
    obs.onLine(
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 1 }, cost: 0 } }),
    )
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('tool_use 缺 callID → 兜底 id；缺 input → 空 input', () => {
    const obs = new MimoStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'read', state: { status: 'completed', output: 'x' } },
      }),
    )
    expect(r.toolUse?.id).toBe('mimo-tool-1')
    expect(r.toolUse?.input).toEqual({})
  })
})
