/**
 * SessionRuntime 崩溃恢复 / 过长上下文降级 单测（Round 4）
 *
 * 用 mock adapter 模拟子进程异常退出 / 抛错 / 过长上下文，验证：
 * - 非用户 stop 的进程死掉会自动 resume 一次（且只一次）
 * - 再失败上报 session_error
 * - 过长上下文 → 中文错误，不恢复
 * - 正常 turn（Pi 核每 turn 后退出 / kscc 干净 result）不触发恢复
 * - 用户主动 stop 不触发恢复
 *
 * 见 docs/decisions/ADR-0002-longlived-process.md「已知缺口」。
 */
import { describe, expect, it } from 'vitest'
import type { AgentProviderAdapter, SDKMessage } from '@tagent/shared'

import { SessionRuntime } from './session-runtime'

/** mock query 的单次行为 */
type Behavior =
  | { kind: 'crash' } // yield assistant(带 session_id) 后 return：模拟 turn 进行中进程退出
  | { kind: 'crashNoSessionId' } // yield assistant(无 session_id) 后 return：无 resumeId 可恢复
  | { kind: 'ok' } // yield assistant + success result 后 return：干净结束
  | { kind: 'throw'; message: string } // 直接抛错
  | { kind: 'promptTooLongResult' } // yield assistant + error result(过长 errors)
  | { kind: 'crashAfterSignal'; signal: Promise<void> } // yield assistant 后等信号再 return

interface MockHandle {
  adapter: AgentProviderAdapter
  calls: Array<{ resumeSessionId?: string; prompt?: string }>
}

type QueryInput = Parameters<AgentProviderAdapter['query']>[0]

function createMock(behaviors: Behavior[], opts?: { interruptQuery?: () => Promise<void> }): MockHandle {
  const calls: Array<{ resumeSessionId?: string; prompt?: string }> = []
  let live = false
  const adapter = {
    query: (input: QueryInput): AsyncIterable<SDKMessage> => {
      const idx = calls.length
      const qInput = input as { resumeSessionId?: string; prompt?: string }
      calls.push({ resumeSessionId: qInput.resumeSessionId, prompt: qInput.prompt })
      live = true
      const beh = behaviors[idx] ?? behaviors[behaviors.length - 1]
      return (async function* (): AsyncGenerator<SDKMessage> {
        if (!beh) return
        if (beh.kind === 'throw') throw new Error(beh.message)
        const withSid = beh.kind !== 'crashNoSessionId'
        yield {
          type: 'assistant',
          message: { content: [] },
          parent_tool_use_id: null,
          ...(withSid ? { session_id: 'sdk-sess-1' } : {}),
        } as SDKMessage
        if (beh.kind === 'crash' || beh.kind === 'crashNoSessionId') {
          live = false
          return
        }
        if (beh.kind === 'crashAfterSignal') {
          await beh.signal
          live = false
          return
        }
        if (beh.kind === 'ok') {
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 0, output_tokens: 0 },
          } as SDKMessage
          live = false
          return
        }
        if (beh.kind === 'promptTooLongResult') {
          yield {
            type: 'result',
            subtype: 'error',
            errors: ['prompt is too long: 1 > 2'],
            usage: { input_tokens: 0, output_tokens: 0 },
          } as SDKMessage
          live = false
          return
        }
        live = false
      })()
    },
    abort: () => {
      live = false
    },
    hasActiveChannel: () => live,
    interruptQuery: opts?.interruptQuery ?? (async () => {}),
    sendQueuedMessage: async () => {},
    dispose: () => {},
  } as unknown as AgentProviderAdapter
  return { adapter, calls }
}

function withTimeout<T>(p: Promise<T>, ms = 8000): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error('test timeout')), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(t))
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (pred()) resolve()
      else if (Date.now() - start > ms) reject(new Error('waitFor timeout'))
      else setTimeout(tick, 5)
    }
    tick()
  })
}

interface RunResult {
  calls: MockHandle['calls']
  turnEnds: number
  errors: Error[]
  messages: SDKMessage[]
  rt: SessionRuntime
}

/** 跑一个简单（非信号）场景，等首个终止事件（turnEnd / error）后返回 */
async function runSimple(behaviors: Behavior[], queryInput?: Partial<QueryInput>): Promise<RunResult> {
  const { adapter, calls } = createMock(behaviors)
  const rt = new SessionRuntime('s1', adapter)
  const turnEnds: number[] = []
  const errors: Error[] = []
  const messages: SDKMessage[] = []
  let settle!: () => void
  const settled = new Promise<void>((r) => {
    settle = r
  })
  rt.setCallbacks({
    onMessage: (m) => {
      messages.push(m)
    },
    onTurnEnd: () => {
      turnEnds.push(1)
      settle()
    },
    onError: (e) => {
      errors.push(e)
      settle()
    },
  })
  await rt.sendMessage({ sessionId: 's1', prompt: 'hello', ...queryInput } as QueryInput)
  await withTimeout(settled)
  await flush()
  return { calls, turnEnds: turnEnds.length, errors, messages, rt }
}

describe('SessionRuntime 崩溃恢复', () => {
  it('进程异常退出 → 自动 resume 一次并重注入在飞消息', async () => {
    const r = await runSimple([{ kind: 'crash' }, { kind: 'ok' }])
    expect(r.calls.length).toBe(2) // 原始 1 + 恢复 1
    expect(r.calls[1]?.resumeSessionId).toBe('sdk-sess-1') // 用流里捕获的 session id resume
    expect(r.calls[1]?.prompt).toBe('hello') // 重注入在飞消息
    expect(r.turnEnds).toBe(1) // 恢复后那一轮成功结束
    expect(r.errors.length).toBe(0)
  })

  it('恢复只触发一次：再次崩溃即上报 session_error，不再重试', async () => {
    const r = await runSimple([{ kind: 'crash' }, { kind: 'crash' }])
    expect(r.calls.length).toBe(2) // 不会第 3 次
    expect(r.errors.length).toBe(1)
    expect(r.turnEnds).toBe(0)
  })

  it('无 resumeId 可恢复时 → 不恢复，上报 session_error', async () => {
    const r = await runSimple([{ kind: 'crashNoSessionId' }])
    expect(r.calls.length).toBe(1)
    expect(r.errors.length).toBe(1)
  })

  it('正常 turn（result 后退出）不触发恢复', async () => {
    const r = await runSimple([{ kind: 'ok' }])
    expect(r.calls.length).toBe(1)
    expect(r.turnEnds).toBe(1)
    expect(r.errors.length).toBe(0)
  })
})

describe('SessionRuntime 过长上下文降级', () => {
  it('抛出 prompt too long → 中文 session_error，不恢复', async () => {
    const r = await runSimple([{ kind: 'throw', message: 'prompt is too long: 1 > 2' }])
    expect(r.calls.length).toBe(1)
    expect(r.turnEnds).toBe(0)
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]?.message).toContain('对话上下文过长')
  })

  it('result.errors 命中 prompt too long → 中文 session_error，不恢复', async () => {
    const r = await runSimple([{ kind: 'promptTooLongResult' }])
    expect(r.calls.length).toBe(1)
    expect(r.turnEnds).toBe(0)
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]?.message).toContain('对话上下文过长')
  })

  it('stderr 命中过长上下文 + 进程退出 → 中文错误，不恢复', async () => {
    let triggerCrash!: () => void
    const signal = new Promise<void>((r) => {
      triggerCrash = r
    })
    const { adapter, calls } = createMock([{ kind: 'crashAfterSignal', signal }])
    const rt = new SessionRuntime('s1', adapter)
    const errors: Error[] = []
    const turnEnds: number[] = []
    const messages: SDKMessage[] = []
    let settle!: () => void
    const settled = new Promise<void>((r) => {
      settle = r
    })
    rt.setCallbacks({
      onMessage: (m) => {
        messages.push(m)
      },
      onTurnEnd: () => {
        turnEnds.push(1)
        settle()
      },
      onError: (e) => {
        errors.push(e)
        settle()
      },
    })
    await rt.sendMessage({ sessionId: 's1', prompt: 'hello' } as QueryInput)
    await waitFor(() => messages.length > 0) // assistant 已到，generator 正等信号
    rt.reportStderr('context_length_exceeded') // 喂过长 stderr
    triggerCrash() // 进程退出
    await withTimeout(settled)
    await flush()

    expect(calls.length).toBe(1) // 不恢复
    expect(turnEnds.length).toBe(0)
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toContain('对话上下文过长')
  })
})

describe('SessionRuntime 用户主动 stop', () => {
  it('用户 interrupt 后进程退出 → 不恢复、不报错', async () => {
    let triggerCrash!: () => void
    const signal = new Promise<void>((r) => {
      triggerCrash = r
    })
    // 可控的 interruptQuery：保持 pending，使 interrupt() 设置 userStopping 后 turnInFlight 仍为 true
    let resolveInterrupt!: () => void
    const interruptRelease = new Promise<void>((r) => {
      resolveInterrupt = r
    })
    const { adapter, calls } = createMock([{ kind: 'crashAfterSignal', signal }], {
      interruptQuery: () => interruptRelease,
    })
    const rt = new SessionRuntime('s1', adapter)
    const errors: Error[] = []
    const turnEnds: number[] = []
    const messages: SDKMessage[] = []
    rt.setCallbacks({
      onMessage: (m) => {
        messages.push(m)
      },
      onTurnEnd: () => {
        turnEnds.push(1)
      },
      onError: (e) => {
        errors.push(e)
      },
    })
    await rt.sendMessage({ sessionId: 's1', prompt: 'hello' } as QueryInput)
    await waitFor(() => messages.length > 0)
    // 用户主动停止（不等其完成）：userStopping 置 true，turnInFlight 仍 true（interruptQuery pending）
    void rt.interrupt()
    triggerCrash() // 进程随后退出
    // 用户停止走干净关闭路径（不调 onTurnEnd/onError），改等 loop 收尾
    await withTimeout(waitFor(() => !rt.isRunning()))
    await flush()
    resolveInterrupt() // 清理 pending 的 interrupt

    expect(calls.length).toBe(1) // 不触发自动恢复
    expect(errors.length).toBe(0) // 不报错
    expect(turnEnds.length).toBe(0)
  })
})
