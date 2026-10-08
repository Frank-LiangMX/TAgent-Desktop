/**
 * moa-orchestrator 单测：
 * - buildAggregatorPrompt：参考席输出拼装 + 失败席标记
 * - runReferenceModels：onSeatUpdate 进度回调（running→ok/failed/cancelled）+ AbortSignal
 * - runAggregatorModel：流式 onTextDelta + abort / 空正文降级
 *
 * 历史 kscc bare 默认席 runner 已移除：编排层必须由宿主注入 seatRunner（Pi HTTP 直连）。
 * 本测试用注入的假 runner 驱动，不再 mock 子进程。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

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
  type MoASeatRunner,
  type ReferenceOutput,
} from './moa-orchestrator'

/** 固定返回文本的假席 runner。 */
function fakeRunner(text: string): MoASeatRunner & { runSeat: ReturnType<typeof vi.fn> } {
  const runSeat = vi.fn(async () => text)
  return { runSeat } as unknown as MoASeatRunner & { runSeat: ReturnType<typeof vi.fn> }
}

/** 抛错的假席 runner。 */
function throwingRunner(message: string): MoASeatRunner {
  return { runSeat: async () => { throw new Error(message) } }
}

describe('buildAggregatorPrompt', () => {
  it('embeds each reference output and the original question', () => {
    const refs: ReferenceOutput[] = [
      { name: '架构师', modelId: 'glm-5.2', text: '用 DDD 拆分', latencyMs: 100, ok: true },
      { name: '实战派', modelId: 'kimi-k2.5', text: '按上下文边界', latencyMs: 200, ok: true },
    ]
    const prompt = buildAggregatorPrompt('如何拆分模块？', refs)
    expect(prompt).toContain('如何拆分模块？')
    expect(prompt).toContain('用 DDD 拆分')
    expect(prompt).toContain('按上下文边界')
    expect(prompt).toContain('架构师')
    expect(prompt).toContain('实战派')
  })

  it('marks failed seats with their error text', () => {
    const refs: ReferenceOutput[] = [
      { name: '坏席', modelId: 'm-x', text: '请求超时', latencyMs: 50, ok: false },
    ]
    const prompt = buildAggregatorPrompt('Q', refs)
    expect(prompt).toContain('坏席')
    expect(prompt).toContain('请求超时')
  })

  it('omits the 会话上下文 header when historyText is not provided', () => {
    const refs: ReferenceOutput[] = [
      { name: '甲', modelId: 'm-a', text: 'A', latencyMs: 1, ok: true },
    ]
    const prompt = buildAggregatorPrompt('Q', refs)
    expect(prompt).not.toContain('[会话上下文]')
  })
})

describe('runReferenceModels', () => {
  it('reports running→ok per seat and returns outputs', async () => {
    const updates: Array<{ seatId?: string; status: string; text?: string }> = []
    const out = await runReferenceModels('Q', [
      { name: '甲', modelId: 'm-a', seatId: 'ref-0' },
      { name: '乙', modelId: 'm-b', seatId: 'ref-1' },
    ], { seatRunner: fakeRunner('答案 A'), onSeatUpdate: (u) => updates.push({ seatId: u.seatId, status: u.status, text: u.text }) })

    expect(out).toHaveLength(2)
    expect(out.every((r) => r.ok)).toBe(true)
    expect(out.map((r) => r.text)).toEqual(['答案 A', '答案 A'])
    // 每席 running 然后 ok
    const statuses = updates.map((u) => u.status)
    expect(statuses).toContain('running')
    expect(statuses.filter((s) => s === 'ok')).toHaveLength(2)
    expect(updates.find((u) => u.seatId === 'ref-0' && u.status === 'ok')?.text).toBe('答案 A')
  })

  it('marks failed when the seat runner throws', async () => {
    const updates: Array<{ status: string; error?: string }> = []
    const out = await runReferenceModels('Q', [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }], {
      seatRunner: throwingRunner('boom'),
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
      seatRunner: fakeRunner('A'),
      signal: ac.signal,
      onSeatUpdate: (u) => updates.push(u.status),
    })
    expect(out[0]!.ok).toBe(false)
    expect(out[0]!.text).toBe('已取消')
    expect(updates).toContain('cancelled')
  })

  it('fails closed when no seat runner is injected (历史 kscc 默认通路已移除)', async () => {
    const out = await runReferenceModels('Q', [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }])
    expect(out[0]!.ok).toBe(false)
    expect(out[0]!.text).toContain('seatRunner')
  })

  it('prepends historyText to the user question (runReferenceModels 注入会话上下文)', async () => {
    const runner = fakeRunner('A')
    await runReferenceModels(
      '本轮议题',
      [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }],
      { seatRunner: runner, historyText: '[会话上下文]\n[用户] 旧问\n\n' },
    )
    const prompt = String(runner.runSeat.mock.calls[0]![0].prompt)
    expect(prompt).toContain('[会话上下文]')
    expect(prompt).toContain('[本轮议题]')
    expect(prompt).toContain('本轮议题')
  })
})

describe('runAggregatorModel', () => {
  it('streams text deltas and returns final text', async () => {
    const deltas: string[] = []
    const runner: MoASeatRunner = {
      runSeat: async (args) => {
        args.onTextDelta?.('Hello ')
        args.onTextDelta?.('world')
        return 'Hello world'
      },
    }
    const out = await runAggregatorModel('Q', [{ name: '甲', modelId: 'm-a', text: 'A', latencyMs: 1, ok: true }], 'm-agg', {
      seatRunner: runner,
      onTextDelta: (t) => deltas.push(t),
    })
    expect(out.ok).toBe(true)
    expect(out.text).toBe('Hello world')
    expect(deltas.join('')).toBe('Hello world')
  })

  it('returns ok=false with cancel reason when signal already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await runAggregatorModel('Q', [], 'm-agg', { seatRunner: fakeRunner('X'), signal: ac.signal })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('已取消')
  })

  it('returns ok=false when aggregator yields no text', async () => {
    const out = await runAggregatorModel('Q', [], 'm-agg', { seatRunner: fakeRunner('') })
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

describe('seatRunner injection (Pi HTTP 直连)', () => {
  it('runReferenceModels uses injected seatRunner', async () => {
    const runner = fakeRunner('seat:m-a')
    const out = await runReferenceModels('Q', [{ name: '甲', modelId: 'm-a', seatId: 'ref-0' }], {
      seatRunner: runner,
    })
    expect(out[0]!.ok).toBe(true)
    expect(out[0]!.text).toBe('seat:m-a')
    expect(runner.runSeat).toHaveBeenCalledOnce()
  })

  it('runReferenceModels forwards ref.systemPrompt to the runner (同模多角色)', async () => {
    const runner = {
      runSeat: vi.fn(async (_args: { systemPrompt?: string; modelId: string }) => 'ok'),
    }
    await runReferenceModels(
      'Q',
      [{ name: '怀疑者', modelId: 'm', seatId: 'ref-0', systemPrompt: 'skeptic' }],
      { seatRunner: runner as never },
    )
    expect(runner.runSeat.mock.calls[0]![0]).toMatchObject({ systemPrompt: 'skeptic', modelId: 'm' })
  })

  it('runAggregatorModel uses injected seatRunner, streams deltas, builds aggregator systemPrompt', async () => {
    const runner = {
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
      { seatRunner: runner as never, onTextDelta: (d) => deltas.push(d) },
    )
    expect(out.ok).toBe(true)
    expect(out.text).toBe('agg-final')
    expect(deltas.join('')).toBe('agg-')
    const callArg = runner.runSeat.mock.calls[0]![0] as {
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