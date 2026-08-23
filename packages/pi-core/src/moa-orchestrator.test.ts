/**
 * moa-orchestrator 单测：
 * - buildAggregatorPrompt：参考席输出拼装 + 失败席标记
 * - runReferenceModels：onSeatUpdate 进度回调（running→ok/failed/cancelled）+ AbortSignal
 * - runAggregatorModel：流式 onTextDelta + abort / 空正文降级
 *
 * spawnKsccBare 被 mock 成喂预置 NDJSON 行，避免真实拉起 kscc 子进程。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// 可变 mock 状态（vi.hoisted 保证 vi.mock 工厂能引用）
const state = vi.hoisted(() => ({ lines: [] as string[], throwOnIter: false }))

function makeLines(lines: string[], throwOnIter: boolean): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next(): Promise<IteratorResult<string>> {
          if (throwOnIter) return Promise.reject(new Error('spawn boom'))
          if (i < lines.length) return Promise.resolve({ value: lines[i++]!, done: false })
          return Promise.resolve({ value: undefined as never, done: true })
        },
      }
    },
  }
}

vi.mock('./kscc-spawn.ts', () => ({
  spawnKsccBare: vi.fn((_opts: unknown) => ({
    lines: makeLines(state.lines, state.throwOnIter),
    wait: async () => 0,
    kill: () => {},
    get stderr() {
      return ''
    },
  })),
}))

// Pi HTTP 直连 streamFn mock：createHttpDirectStreamFn 返回一个 yield httpState.events 的流。
// 捕获 factory opts / context / options 以断言凭据 + systemPrompt + timeout 注入。
const httpState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  lastFactoryOpts: null as unknown,
  lastContext: null as unknown,
  lastOptions: null as unknown,
}))

vi.mock('./http-direct-stream-fn.ts', () => ({
  createHttpDirectStreamFn: vi.fn((opts: unknown) => {
    httpState.lastFactoryOpts = opts
    return (_model: unknown, context: unknown, options: unknown) => {
      httpState.lastContext = context
      httpState.lastOptions = options
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of httpState.events) yield e
        },
        result: async () => ({ content: [] }),
      }
    }
  }),
}))

import {
  runReferenceModels,
  runAggregatorModel,
  buildAggregatorPrompt,
  createPiHttpSeatRunner,
  type ReferenceOutput,
} from './moa-orchestrator'

// 重置 mock 状态（每席的 NDJSON 行 / 是否抛错）。spawnKsccBare 的调用记录不参与断言，无需 reset。
beforeEach(() => {
  state.lines = []
  state.throwOnIter = false
})

function textDelta(t: string): string {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
}
function resultLine(text: string): string {
  return JSON.stringify({ type: 'result', result: text })
}

describe('buildAggregatorPrompt', () => {
  it('embeds each reference output and the original question', () => {
    const refs: ReferenceOutput[] = [
      { name: '架构师', modelId: 'glm-5.2', text: '用 DDD 拆分', latencyMs: 100, ok: true },
      { name: '实战派', modelId: 'kimi-k2.5', text: '按上下文边界', latencyMs: 200, ok: true },
    ]
    const prompt = buildAggregatorPrompt('如何拆分模块？', refs)
    expect(prompt).toContain('聚合器模型')
    expect(prompt).toContain('[参考模型 架构师]')
    expect(prompt).toContain('用 DDD 拆分')
    expect(prompt).toContain('[参考模型 实战派]')
    expect(prompt).toContain('[原始问题]')
    expect(prompt).toContain('如何拆分模块？')
  })

  it('marks failed reference seats with a failure banner', () => {
    const refs: ReferenceOutput[] = [
      { name: '架构师', modelId: 'glm-5.2', text: 'OK', latencyMs: 10, ok: true },
      { name: '实战派', modelId: 'kimi-k2.5', text: '超时', latencyMs: 30000, ok: false },
    ]
    const prompt = buildAggregatorPrompt('Q', refs)
    expect(prompt).toContain('[参考模型 架构师]')
    expect(prompt).not.toMatch(/架构师.*\[该参考模型运行失败\]/)
    expect(prompt).toMatch(/实战派\s*\[该参考模型运行失败\]/)
  })

  it('embeds historyText when provided (system 段能拿到会话上下文)', () => {
    const refs: ReferenceOutput[] = [
      { name: '甲', modelId: 'm-a', text: 'A', latencyMs: 1, ok: true },
    ]
    const prompt = buildAggregatorPrompt('Q', refs, '[会话上下文]\n[用户] 旧问\n\n')
    expect(prompt).toContain('[会话上下文]')
    expect(prompt).toContain('[用户] 旧问')
    // 仍然含原始问题
    expect(prompt).toContain('[原始问题]')
    expect(prompt).toContain('Q')
  })

  it('omits history block when historyText is undefined', () => {
    const refs: ReferenceOutput[] = [
      { name: '甲', modelId: 'm-a', text: 'A', latencyMs: 1, ok: true },
    ]
    const prompt = buildAggregatorPrompt('Q', refs)
    expect(prompt).not.toContain('[会话上下文]')
  })
})

describe('runReferenceModels', () => {
  it('reports running→ok per seat and returns outputs', async () => {
    state.lines = [textDelta('答案 A'), resultLine('答案 A')]
    const updates: Array<{ seatId?: string; status: string; text?: string }> = []
    const out = await runReferenceModels('Q', [
      { name: '甲', modelId: 'm-a', seatId: 'ref-0' },
      { name: '乙', modelId: 'm-b', seatId: 'ref-1' },
    ], { ksccPath: 'kscc', onSeatUpdate: (u) => updates.push({ seatId: u.seatId, status: u.status, text: u.text }) })

    expect(out).toHaveLength(2)
    expect(out.every((r) => r.ok)).toBe(true)
    expect(out.map((r) => r.text)).toEqual(['答案 A', '答案 A'])
    // 每席 running 然后 ok
    const statuses = updates.map((u) => u.status)
    expect(statuses).toContain('running')
    expect(statuses.filter((s) => s === 'ok')).toHaveLength(2)
    expect(updates.find((u) => u.seatId === 'ref-0' && u.status === 'ok')?.text).toBe('答案 A')
  })

  it('marks failed when the seat process throws', async () => {
    state.throwOnIter = true
    const updates: Array<{ status: string; error?: string }> = []
    const out = await runReferenceModels('Q', [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }], {
      onSeatUpdate: (u) => updates.push({ status: u.status, error: u.error }),
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.ok).toBe(false)
    expect(updates.some((u) => u.status === 'failed' && u.error?.includes('boom'))).toBe(true)
  })

  it('cancels seats when signal already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const updates: string[] = []
    const out = await runReferenceModels('Q', [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }], {
      signal: ac.signal,
      onSeatUpdate: (u) => updates.push(u.status),
    })
    expect(out[0]!.ok).toBe(false)
    expect(out[0]!.text).toBe('已取消')
    expect(updates).toContain('cancelled')
  })

  it('prepends historyText to the user question (runReferenceModels 注入会话上下文)', async () => {
    state.lines = [resultLine('A')]
    // 抓取传给 spawnKsccBare 的实际 context（vi.mock 工厂可注入）
    const { spawnKsccBare } = await import('./kscc-spawn.ts')
    const calls = (spawnKsccBare as unknown as { mock: { calls: unknown[][] } }).mock.calls
    calls.length = 0
    await runReferenceModels(
      '本轮议题',
      [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }],
      { historyText: '[会话上下文]\n[用户] 旧问\n\n' },
    )
    expect(calls.length).toBeGreaterThan(0)
    const ctx = (calls[0]![0] as { context: { messages: Array<{ role: string; content: string }> } })
      .context
    expect(ctx.messages[0]?.role).toBe('user')
    expect(ctx.messages[0]?.content).toContain('[会话上下文]')
    expect(ctx.messages[0]?.content).toContain('[本轮议题]')
    expect(ctx.messages[0]?.content).toContain('本轮议题')
  })
})

describe('runAggregatorModel', () => {
  it('streams text deltas and returns final text', async () => {
    state.lines = [textDelta('Hello '), textDelta('world'), resultLine('Hello world')]
    const deltas: string[] = []
    const out = await runAggregatorModel('Q', [{ name: '甲', modelId: 'm-a', text: 'A', latencyMs: 1, ok: true }], 'm-agg', {
      ksccPath: 'kscc',
      onTextDelta: (t) => deltas.push(t),
    })
    expect(out.ok).toBe(true)
    expect(out.text).toBe('Hello world')
    expect(deltas.join('')).toBe('Hello world')
  })

  it('returns ok=false with cancel reason when signal already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await runAggregatorModel('Q', [], 'm-agg', { signal: ac.signal })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('已取消')
  })

  it('returns ok=false when aggregator yields no text', async () => {
    state.lines = []
    const out = await runAggregatorModel('Q', [], 'm-agg', { ksccPath: 'kscc' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('未返回正文')
  })
})

describe('createPiHttpSeatRunner (Pi HTTP 直连席，mock HTTP)', () => {
  beforeEach(() => {
    httpState.events = []
    httpState.lastFactoryOpts = null
    httpState.lastContext = null
    httpState.lastOptions = null
  })

  it('collects final text from done.message (参考席：无 onTextDelta)', async () => {
    httpState.events = [
      { type: 'text_delta', delta: 'Hello ', partial: {} },
      { type: 'text_delta', delta: 'world', partial: {} },
      { type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    ]
    const runner = createPiHttpSeatRunner({ provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com' })
    const text = await runner.runSeat({ modelId: 'gpt-4o', prompt: 'Q', timeoutMs: 1000 })
    expect(text).toBe('Hello world')
  })

  it('streams deltas via onTextDelta (汇总席)', async () => {
    httpState.events = [
      { type: 'text_delta', delta: 'A', partial: {} },
      { type: 'text_delta', delta: 'B', partial: {} },
      { type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: 'AB' }] } },
    ]
    const runner = createPiHttpSeatRunner({ provider: 'openai', apiKey: 'k' })
    const deltas: string[] = []
    const text = await runner.runSeat({ modelId: 'gpt-4o', prompt: 'Q', onTextDelta: (d) => deltas.push(d) })
    expect(text).toBe('AB')
    expect(deltas.join('')).toBe('AB')
  })

  it('exposes final usage through the optional path without changing runSeat', async () => {
    httpState.events = [
      {
        type: 'done',
        reason: 'stop',
        message: {
          content: [{ type: 'text', text: 'metered' }],
          usage: { input: 12, output: 7, totalTokens: 19 },
        },
      },
    ]
    const runner = createPiHttpSeatRunner({ provider: 'openai', apiKey: 'k' })
    expect(runner.runSeatWithUsage).toEqual(expect.any(Function))
    const result = await runner.runSeatWithUsage!({ modelId: 'gpt-4o', prompt: 'Q' })
    expect(result).toEqual({ text: 'metered', usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } })
  })

  it('throws on error event with errorMessage', async () => {
    httpState.events = [{ type: 'error', reason: 'error', error: { errorMessage: 'bad request' } }]
    const runner = createPiHttpSeatRunner({ provider: 'openai', apiKey: 'k' })
    await expect(runner.runSeat({ modelId: 'gpt-4o', prompt: 'Q' })).rejects.toThrow('bad request')
  })

  it('passes modelId/apiKey/baseUrl to factory, systemPrompt+tools:[] into Context, timeoutMs into options', async () => {
    httpState.events = [{ type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: 'ok' }] } }]
    const runner = createPiHttpSeatRunner({ provider: 'openai', apiKey: 'secret', baseUrl: 'https://api.openai.com' })
    await runner.runSeat({ modelId: 'gpt-4o', prompt: '本轮议题', systemPrompt: 'be concise', timeoutMs: 5000 })
    expect(httpState.lastFactoryOpts).toMatchObject({
      provider: 'openai',
      apiKey: 'secret',
      baseUrl: 'https://api.openai.com',
      modelId: 'gpt-4o',
    })
    expect(httpState.lastContext).toMatchObject({ systemPrompt: 'be concise', tools: [] })
    expect((httpState.lastContext as { messages: Array<{ role: string; content: string }> }).messages[0]).toMatchObject({
      role: 'user',
      content: '本轮议题',
    })
    expect(httpState.lastOptions).toMatchObject({ timeoutMs: 5000 })
  })
})

describe('seatRunner injection (kscc bare vs Pi HTTP 分流)', () => {
  it('runReferenceModels uses injected seatRunner instead of spawnKsccBare', async () => {
    const fakeRunner = { runSeat: vi.fn(async (args: { modelId: string }) => `seat:${args.modelId}`) }
    const out = await runReferenceModels('Q', [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }], {
      seatRunner: fakeRunner as never,
    })
    expect(out[0]!.ok).toBe(true)
    expect(out[0]!.text).toBe('seat:m-a')
    expect(fakeRunner.runSeat).toHaveBeenCalledOnce()
  })

  it('runReferenceModels forwards ref.systemPrompt to the runner (同模多角色)', async () => {
    const fakeRunner = {
      runSeat: vi.fn(async (_args: { systemPrompt?: string; modelId: string }) => 'ok'),
    }
    await runReferenceModels(
      'Q',
      [{ name: '怀疑者', modelId: 'm', seatId: 'ref-0', systemPrompt: 'skeptic' }],
      { seatRunner: fakeRunner as never },
    )
    expect(fakeRunner.runSeat.mock.calls[0]![0]).toMatchObject({ systemPrompt: 'skeptic', modelId: 'm' })
  })

  it('runAggregatorModel uses injected seatRunner, streams deltas, builds aggregator systemPrompt', async () => {
    const fakeRunner = {
      runSeat: vi.fn(async (args: { onTextDelta?: (t: string) => void }) => {
        args.onTextDelta?.('agg-')
        return 'agg-final'
      }),
    }
    const deltas: string[] = []
    const out = await runAggregatorModel(
      'Q',
      [{ name: '甲', modelId: 'm-a', text: 'REFOUT', latencyMs: 1, ok: true }],
      'm-agg',
      { seatRunner: fakeRunner as never, onTextDelta: (d) => deltas.push(d) },
    )
    expect(out.ok).toBe(true)
    expect(out.text).toBe('agg-final')
    expect(deltas.join('')).toBe('agg-')
    const callArg = fakeRunner.runSeat.mock.calls[0]![0] as {
      modelId: string
      systemPrompt: string
      onTextDelta?: (t: string) => void
    }
    expect(callArg.modelId).toBe('m-agg')
    expect(callArg.systemPrompt).toContain('聚合器模型')
    expect(callArg.systemPrompt).toContain('REFOUT')
    expect(typeof callArg.onTextDelta).toBe('function')
  })
})
