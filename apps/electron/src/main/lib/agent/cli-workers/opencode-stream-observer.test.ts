/**
 * OpencodeStreamObserver 单测：fixture 驱动 + 解析规则覆盖。
 *
 * 本机 opencode 0 凭据 / 免费模型限流，无法采真流；fixture 按 untether/opencode.jsonc 文档建模
 * （事件形态 = SLICE-9 brief 指定的顶层 type：step_start / text / tool_use / step_finish / error，
 *   text.part 为纯字符串、tool_use.part.id 为调用 id、tool_use.part.tool 映射 UI 分类），
 * 不依赖任何真实 opencode 调用。
 *
 * 验收对齐 SLICE-9 brief：
 * - step_start（含 sessionID/title）→ 忽略
 * - text 文本块 → textChunk + summary 累积（多块拼接）
 * - tool_use pending → 不触发 onProgress、不计数、无 toolResult
 * - tool_use completed（bash，state.output）→ toolUse + lastToolName=command + toolResult，计数 1
 * - tool_use failed → toolResult 带 isError
 * - 两段式同 id（pending→completed）→ 只计 1 次，仅 completed 触发
 * - 工具名映射表全量断言（bash→command、edit→file、read→tool、websearch→web_search、task→tool）
 * - error 事件 → getError() 含 APIError/message；getSummary 不含错误文本
 * - 多次 step（step_start→...→step_finish ×2）→ 累计正确、不重计
 */
import { describe, expect, it } from 'vitest'
import { OpencodeStreamObserver } from './opencode-stream-observer'
import type { CliStreamObserver } from './run-ndjson-cli'

/** 单行 JSON 事件 → 字符串 */
function ev(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('OpencodeStreamObserver · 解析规则', () => {
  it('忽略非 JSON / 空行', () => {
    const obs = new OpencodeStreamObserver()
    expect(obs.onLine('not json')).toEqual({})
    expect(obs.onLine('')).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
    expect(obs.getError()).toBeUndefined()
  })

  it('step_start（含 sessionID/title 字段）→ 忽略', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({ type: 'step_start', part: { type: 'step-start', sessionID: 'sess_1', title: 'plan' } }),
    )
    expect(r).toEqual({})
    expect(obs.getSummary()).toBe('')
    expect(obs.getToolCallCount()).toBe(0)
  })

  it('text 文本块（part 为纯字符串）→ textChunk + 累积 summary（多块拼接）', () => {
    const obs = new OpencodeStreamObserver()
    const r1 = obs.onLine(ev({ type: 'text', part: 'OPENCODE_' }))
    const r2 = obs.onLine(ev({ type: 'text', part: 'OK' }))
    expect(r1.textChunk).toBe('OPENCODE_')
    expect(r2.textChunk).toBe('OK')
    expect(obs.getSummary()).toBe('OPENCODE_OK')
  })

  it('text part 非字符串 → 忽略', () => {
    const obs = new OpencodeStreamObserver()
    expect(obs.onLine(ev({ type: 'text', part: { type: 'text', text: 'x' } }))).toEqual({})
    expect(obs.getSummary()).toBe('')
  })

  it('tool_use pending → 不触发 onProgress、不计数、无 toolResult', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'tool_use',
        part: { tool: 'bash', id: 'call_1', state: { status: 'pending', input: { command: 'ls' } } },
      }),
    )
    expect(r).toEqual({})
    expect(obs.getToolCallCount()).toBe(0)
    // 同 id 再 completed → 首次见，计数 1（pending 未占坑）
    const r2 = obs.onLine(
      ev({ type: 'tool_use', part: { tool: 'bash', id: 'call_1', state: { status: 'completed', output: 'done' } } }),
    )
    expect(r2.lastToolName).toBe('command')
    expect(r2.toolUse).toBeDefined()
    expect(r2.toolResult).toEqual({ toolUseId: 'call_1', content: 'done' })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('tool_use completed（bash，state.output）→ toolUse + lastToolName=command + toolResult，计数 1', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'tool_use',
        part: {
          tool: 'bash',
          id: 'call_1',
          state: { status: 'completed', input: { command: 'ls' }, output: 'entries' },
        },
      }),
    )
    expect(r.lastToolName).toBe('command')
    expect(r.toolUse).toEqual({ id: 'call_1', name: 'command', input: { command: 'ls' } })
    expect(r.toolResult).toEqual({ toolUseId: 'call_1', content: 'entries' })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('tool_use output 为对象 → toolResult.content = JSON.stringify', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'tool_use',
        part: { tool: 'read', id: 'call_2', state: { status: 'completed', output: { hits: 3 } } },
      }),
    )
    expect(r.toolResult?.content).toBe(JSON.stringify({ hits: 3 }))
  })

  it('tool_use status=failed → toolResult.isError=true', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'tool_use',
        part: { tool: 'bash', id: 'call_3', state: { status: 'failed', input: {}, output: 'err' } },
      }),
    )
    expect(r.toolResult?.isError).toBe(true)
    // failed 也是首次见 → 仍计数 + toolUse
    expect(r.toolUse).toBeDefined()
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('tool_use status=error → toolResult.isError=true', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({
        type: 'tool_use',
        part: { tool: 'bash', id: 'call_e', state: { status: 'error', output: 'boom' } },
      }),
    )
    expect(r.toolResult?.isError).toBe(true)
  })

  it('两段式同 id（pending→completed）→ 只计 1 次，仅 completed 触发', () => {
    const obs = new OpencodeStreamObserver()
    const r1 = obs.onLine(
      ev({ type: 'tool_use', part: { tool: 'bash', id: 'call_x', state: { status: 'pending', input: { command: 'ls' } } } }),
    )
    expect(r1).toEqual({})
    expect(obs.getToolCallCount()).toBe(0)
    const r2 = obs.onLine(
      ev({ type: 'tool_use', part: { tool: 'bash', id: 'call_x', state: { status: 'completed', output: 'out' } } }),
    )
    expect(r2.toolUse).toBeDefined()
    expect(r2.lastToolName).toBe('command')
    expect(r2.toolResult).toEqual({ toolUseId: 'call_x', content: 'out' })
    expect(obs.getToolCallCount()).toBe(1)
  })

  it('缺 id → 兜底 opencode-tool-N；缺 input → 空 input；缺 output → content 为空串', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } }),
    )
    expect(r.toolUse?.id).toBe('opencode-tool-1')
    expect(r.toolUse?.input).toEqual({})
    expect(r.toolResult?.content).toBe('')
  })

  it('工具名映射表全量断言（bash→command、edit→file、read→tool、websearch→web_search、task→tool）', () => {
    const cases: Array<[string, string]> = [
      ['bash', 'command'],
      ['shell', 'command'],
      ['edit', 'file'],
      ['write', 'file'],
      ['multiedit', 'file'],
      ['read', 'tool'],
      ['glob', 'tool'],
      ['grep', 'tool'],
      ['websearch', 'web_search'],
      ['webfetch', 'web_search'],
      ['task', 'tool'],
    ]
    for (const [tool, expected] of cases) {
      const obs = new OpencodeStreamObserver()
      const r = obs.onLine(
        ev({ type: 'tool_use', part: { tool, id: `id_${tool}`, state: { status: 'completed', output: 'x' } } }),
      )
      expect(r.lastToolName, `tool=${tool}`).toBe(expected)
      expect(r.toolUse?.name, `tool=${tool}`).toBe(expected)
    }
  })

  it('未列出的工具名 → 原样透传（保留工具名信息）', () => {
    const obs = new OpencodeStreamObserver()
    const r = obs.onLine(
      ev({ type: 'tool_use', part: { tool: 'customtool', id: 'c1', state: { status: 'completed', output: 'x' } } }),
    )
    expect(r.lastToolName).toBe('customtool')
    expect(r.toolUse?.name).toBe('customtool')
  })

  it('error 事件 → getError() 含 APIError/message；getSummary 不含错误文本', () => {
    const obs = new OpencodeStreamObserver()
    obs.onLine(ev({ type: 'text', part: 'partial answer' }))
    obs.onLine(
      ev({ type: 'error', error: { name: 'APIError', data: { message: 'rate limit exceeded, retry later' } } }),
    )
    expect(obs.getError()).toContain('APIError')
    expect(obs.getError()).toContain('rate limit exceeded')
    // summary 仅含 text 文本块，不混入错误信息
    expect(obs.getSummary()).toBe('partial answer')
    expect(obs.getSummary()).not.toContain('APIError')
    expect(obs.getSummary()).not.toContain('rate limit')
  })

  it('error 事件缺 data.message / 仅 name → getError() 仍含 name', () => {
    const obs = new OpencodeStreamObserver()
    obs.onLine(ev({ type: 'error', error: { name: 'APIError', data: {} } }))
    expect(obs.getError()).toContain('APIError')
  })

  it('多次 step（step_start→...→step_finish ×2）→ 累计正确、不重计', () => {
    const obs = new OpencodeStreamObserver()
    const lines = [
      ev({ type: 'step_start', part: { type: 'step-start', sessionID: 's1', title: 'step one' } }),
      ev({ type: 'text', part: 'STEP1_' }),
      ev({ type: 'tool_use', part: { tool: 'read', id: 't1', state: { status: 'completed', output: 'a' } } }),
      ev({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 1 }, cost: 0 } }),
      ev({ type: 'step_start', part: { type: 'step-start', sessionID: 's2', title: 'step two' } }),
      ev({ type: 'text', part: 'STEP2' }),
      ev({ type: 'tool_use', part: { tool: 'bash', id: 't2', state: { status: 'completed', output: 'b' } } }),
      ev({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 2 }, cost: 0 } }),
    ]
    let lastTool = ''
    for (const line of lines) {
      const r = obs.onLine(line)
      if (r.lastToolName) lastTool = r.lastToolName
    }
    expect(obs.getToolCallCount()).toBe(2) // 不重计
    expect(obs.getSummary()).toBe('STEP1_STEP2')
    expect(lastTool).toBe('command') // 最后一个工具是 bash → command
  })
})

describe('OpencodeStreamObserver · CliStreamObserver 契约', () => {
  it('implements CliStreamObserver（含 getError）', () => {
    // 编译期：implements CliStreamObserver 已保证签名；运行期再核四方法存在
    const obs: CliStreamObserver = new OpencodeStreamObserver()
    expect(typeof obs.onLine).toBe('function')
    expect(typeof obs.getSummary).toBe('function')
    expect(typeof obs.getToolCallCount).toBe('function')
    expect(typeof obs.getError).toBe('function')
  })
})
