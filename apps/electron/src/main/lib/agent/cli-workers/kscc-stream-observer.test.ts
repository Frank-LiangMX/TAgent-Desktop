/**
 * KsccStreamObserver 单测：fixture 驱动 + 解析规则覆盖。
 *
 * 验收对齐 SLICE-2 brief：
 * - `kscc-stream.stdout.txt` → summary `KSCC_STREAM_OK`
 * - `kscc-tool.stdout.txt`  → 有 tool 次数、summary 含 `TOOL_DONE`
 * - JSON parse 失败 → 忽略；assistant.text 累积；result 优先；thinking/system 忽略；user/tool_result 回传。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KsccStreamObserver } from './kscc-stream-observer'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 从测试文件目录向上找 `docs/dev/cli-probe-2026-08-10`（robust to 目录深度变化）。
 * 兜底：按相对项目根的固定回退路径。
 */
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

describe('KsccStreamObserver · fixture 驱动', () => {
  it('kscc-stream.stdout.txt → summary 为 KSCC_STREAM_OK，无工具', () => {
    const obs = new KsccStreamObserver()
    for (const line of readLines('kscc-stream.stdout.txt')) obs.onLine(line)
    expect(obs.getSummary()).toBe('KSCC_STREAM_OK')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('kscc-tool.stdout.txt → 有工具次数、summary 含 TOOL_DONE、工具名恒为 Bash', () => {
    const obs = new KsccStreamObserver()
    const toolNames: string[] = []
    for (const line of readLines('kscc-tool.stdout.txt')) {
      const r = obs.onLine(line)
      if (r.lastToolName) toolNames.push(r.lastToolName)
    }
    expect(obs.getToolCallCount()).toBeGreaterThanOrEqual(1)
    expect(obs.getSummary()).toContain('TOOL_DONE')
    // fixture 里三次工具调用都是 Bash
    expect(toolNames.length).toBeGreaterThanOrEqual(1)
    expect(toolNames.every((n) => n === 'Bash')).toBe(true)
  })
})

describe('KsccStreamObserver · 解析规则', () => {
  it('忽略非 JSON / 空行', () => {
    const obs = new KsccStreamObserver()
    expect(obs.onLine('not json')).toEqual({})
    expect(obs.onLine('')).toEqual({})
    expect(obs.onLine('   ')).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('解析 tool_use 结构（含 id/input）', () => {
    const obs = new KsccStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_abc',
              name: 'Bash',
              input: { command: 'dir' },
            },
          ],
        },
      }),
    )
    expect(r.lastToolName).toBe('Bash')
    expect(r.toolUse).toEqual({
      id: 'call_abc',
      name: 'Bash',
      input: { command: 'dir' },
    })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('解析 user/tool_result', () => {
    const obs = new KsccStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc',
              content: 'ok-out',
              is_error: false,
            },
          ],
        },
      }),
    )
    expect(r.toolResult).toEqual({
      toolUseId: 'call_abc',
      content: 'ok-out',
    })
  })

  it('累积 assistant.text（无 result 行时为摘要）', () => {
    const obs = new KsccStreamObserver()
    obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello ' }] },
      }),
    )
    obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world' }] },
      }),
    )
    expect(obs.getSummary()).toBe('hello world')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('result 行优先于累积 text 作为摘要', () => {
    const obs = new KsccStreamObserver()
    obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'accumulated' }] },
      }),
    )
    obs.onLine(JSON.stringify({ type: 'result', result: 'final' }))
    expect(obs.getSummary()).toBe('final')
  })

  it('tool_use 计数 + 每行返回最后一条 lastToolName', () => {
    const obs = new KsccStreamObserver()
    const r1 = obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] },
      }),
    )
    const r2 = obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }] },
      }),
    )
    expect(r1.lastToolName).toBe('Bash')
    expect(r2.lastToolName).toBe('Read')
    expect(obs.getToolCallCount()).toBe(2)
  })

  it('一行多 tool_use：全计数，lastToolName 取最后一条', () => {
    const obs = new KsccStreamObserver()
    const r = obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
            { type: 'tool_use', id: 'b', name: 'Glob', input: {} },
          ],
        },
      }),
    )
    expect(r.lastToolName).toBe('Glob')
    expect(obs.getToolCallCount()).toBe(2)
  })

  it('忽略 thinking 块（不计工具、不进摘要）', () => {
    const obs = new KsccStreamObserver()
    obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'secret thoughts' }] },
      }),
    )
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('忽略 system / user 行', () => {
    const obs = new KsccStreamObserver()
    obs.onLine(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] }))
    obs.onLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'x', tool_use_id: 'a' }] },
      }),
    )
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('result 行非字符串 result 不收口，回落累积 text', () => {
    const obs = new KsccStreamObserver()
    obs.onLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'kept' }] },
      }),
    )
    // result 字段为对象（个别 CLI 形态）→ 不当 finalText
    obs.onLine(JSON.stringify({ type: 'result', result: { structured: true } }))
    expect(obs.getSummary()).toBe('kept')
  })
})
