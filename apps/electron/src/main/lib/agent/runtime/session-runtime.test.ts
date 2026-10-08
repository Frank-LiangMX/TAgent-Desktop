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
import { describe, expect, it, vi } from 'vitest'
import type { AgentProviderAdapter, SDKMessage } from '@tagent/shared'

import {
  SessionRuntime,
  TURN_SETTLE_TIMEOUT_MS,
  classifyTurnTerminal,
  type TurnTerminalInfo,
} from './session-runtime'

/** mock query 的单次行为 */
type Behavior =
  | { kind: 'crash' } // yield assistant(带 session_id) 后 return：模拟 turn 进行中进程退出
  | { kind: 'crashNoSessionId' } // yield assistant(无 session_id) 后 return：无 resumeId 可恢复
  | { kind: 'ok' } // yield assistant + success result 后 return：干净结束
  | { kind: 'okThenLate'; signal: Promise<void> } // result 后模拟迟到非终态消息
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
        if (beh.kind === 'ok' || beh.kind === 'okThenLate') {
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 0, output_tokens: 0 },
          } as SDKMessage
          if (beh.kind === 'okThenLate') {
            await beh.signal
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'late' }] },
              parent_tool_use_id: null,
            } as SDKMessage
          }          live = false
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

  it('官方 API 连接断联不自动重放在飞 prompt，等待用户显式续聊', async () => {
    const r = await runSimple(
      [{ kind: 'crash' }, { kind: 'ok' }],
      {
        apiConnection: {
          channelId: 'official-api',
          baseUrl: 'https://api.example.invalid',
          apiKey: 'not-logged',
        },
      } as never,
    )
    expect(r.calls).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
    expect(r.turnEnds).toBe(0)
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

  it('result 后迟到的非终态消息不会重新上送', async () => {
    let releaseLate!: () => void
    const lateSignal = new Promise<void>((resolve) => {
      releaseLate = resolve
    })
    const { adapter } = createMock([{ kind: 'okThenLate', signal: lateSignal }])
    const rt = new SessionRuntime('s-late', adapter)
    const messages: SDKMessage[] = []
    let turnEnded!: () => void
    const turnEnd = new Promise<void>((resolve) => {
      turnEnded = resolve
    })
    rt.setCallbacks({
      onMessage: (message) => messages.push(message),
      onTurnEnd: () => turnEnded(),
    })
    await rt.sendMessage({ sessionId: 's-late', prompt: 'hello' } as QueryInput)
    await withTimeout(turnEnd)
    expect(messages).toHaveLength(2)
    releaseLate()
    await withTimeout(waitFor(() => !rt.isRunning()))
    expect(messages).toHaveLength(2)
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

describe('SessionRuntime steerMessage', () => {
  it('无 live process 时返回 noop（不静默假装注入）', async () => {
    const { adapter } = createMock([{ kind: 'ok' }])
    const rt = new SessionRuntime('s-steer', adapter)
    // 尚未 sendMessage → 无 loop
    expect(await rt.steerMessage('redirect')).toBe('noop')
  })

  it('有 live process 时走 sendQueuedMessage 返回 live', async () => {
    let queued: unknown
    const { adapter } = createMock([{ kind: 'crashAfterSignal', signal: new Promise(() => {}) }])
    ;(adapter as { sendQueuedMessage: (id: string, m: unknown) => Promise<void> }).sendQueuedMessage =
      async (_id, m) => {
        queued = m
      }
    const rt = new SessionRuntime('s-steer-live', adapter)
    const messages: SDKMessage[] = []
    rt.setCallbacks({ onMessage: (m) => messages.push(m) })
    // crashAfterSignal 永不 resolve → loop 保持 live
    void rt.sendMessage({ sessionId: 's-steer-live', prompt: 'hi' } as QueryInput)
    await waitFor(() => messages.length > 0)
    expect(rt.hasLiveProcess()).toBe(true)
    expect(await rt.steerMessage('nudge')).toBe('live')
    expect(queued).toMatchObject({
      type: 'user',
      session_id: 's-steer-live',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'nudge' },
    })
  })
})

describe('SessionRuntime 引导 flush 竞态（Pi）', () => {
  it('onTurnEnd 里再 send（模拟 pending steer）→ 旧 loop 退出不报「自动恢复失败」', async () => {
    const { adapter, calls } = createMock([{ kind: 'ok' }, { kind: 'ok' }])
    const rt = new SessionRuntime('s-steer-race', adapter)
    const errors: Error[] = []
    let settle!: () => void
    const settled = new Promise<void>((r) => {
      settle = r
    })
    rt.setCallbacks({
      onTurnEnd: () => {
        // 模拟旧 bug：在仍 for-await 内立刻发下一轮（enqueue / 再 startLoop）
        void rt
          .sendMessage(
            { sessionId: 's-steer-race', prompt: 'steer-followup' } as QueryInput,
            {
              type: 'user',
              message: { role: 'user', content: 'steer-followup' },
              parent_tool_use_id: null,
            } as never,
          )
          .catch(() => {})
      },
      onLoopIdle: () => {
        settle()
      },
      onError: (e) => {
        errors.push(e)
        settle()
      },
    })
    await rt.sendMessage({ sessionId: 's-steer-race', prompt: 'hello' } as QueryInput)
    await withTimeout(settled)
    await flush()

    expect(errors.map((e) => e.message).join('\n')).not.toContain('自动恢复失败')
    expect(errors.length).toBe(0)
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('干净 result 后触发 onLoopIdle（供 Pi pending steer flush）', async () => {
    const { adapter } = createMock([{ kind: 'ok' }])
    const rt = new SessionRuntime('s-idle', adapter)
    const idles: number[] = []
    let settle!: () => void
    const settled = new Promise<void>((r) => {
      settle = r
    })
    rt.setCallbacks({
      onTurnEnd: () => {},
      onLoopIdle: () => {
        idles.push(1)
        settle()
      },
      onError: () => settle(),
    })
    await rt.sendMessage({ sessionId: 's-idle', prompt: 'hello' } as QueryInput)
    await withTimeout(settled)
    expect(idles.length).toBe(1)
    expect(rt.isRunning()).toBe(false)
  })
})

describe('SessionRuntime 用户主动 stop', () => {
  it('普通停止尚未完成时立即发送：等中断受理 + 等原生终态，不报「上一轮仍在跑」', async () => {
    let releaseOldLoop!: () => void
    const oldLoopSignal = new Promise<void>((resolve) => {
      releaseOldLoop = resolve
    })
    let releaseInterrupt!: () => void
    const interruptSignal = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const { adapter, calls } = createMock([{ kind: 'crashAfterSignal', signal: oldLoopSignal }], {
      interruptQuery: () => interruptSignal,
    })
    let queued = 0
    adapter.sendQueuedMessage = async () => {
      queued++
    }
    const rt = new SessionRuntime('s-stop-send-race', adapter)
    const messages: SDKMessage[] = []
    rt.setCallbacks({ onMessage: (message) => messages.push(message) })

    await rt.sendMessage({ sessionId: 's-stop-send-race', prompt: 'first' } as QueryInput)
    await waitFor(() => messages.length > 0)

    const stopping = rt.interrupt()
    const sending = rt.sendMessage(
      { sessionId: 's-stop-send-race', prompt: 'second' } as QueryInput,
      {
        type: 'user',
        message: { role: 'user', content: 'second' },
        parent_tool_use_id: null,
      } as never,
    )
    await flush()
    expect(queued).toBe(0) // 中断未受理前不发

    releaseInterrupt()
    await flush()
    // 中断已受理，但旧回合还没产出原生终态 → 仍然不发（等待原生终态，避免两轮并行）
    expect(queued).toBe(0)
    expect(rt.hasUnsettledStop()).toBe(true)

    // 旧回合真正收尾（generator 退出 → 终态被观察到）→ 放行本轮发送
    // （旧进程已退出，本轮走重新 spawn 的 query 路径而不是 enqueue）
    releaseOldLoop()
    await withTimeout(Promise.all([stopping, sending]))
    // 第 2 次 query 即本轮发送（其后可能还有一次崩溃自动恢复，与本断言无关）
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[1]?.prompt).toBe('second')
    expect(rt.hasUnsettledStop()).toBe(false)

    rt.destroy()
    await flush()
  })

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

// ===== ADR-0011 §5 前置：停止受理 ≠ 静默（原生终态闩锁） =====

/**
 * 可闸门适配器：先吐一条 assistant（证明本轮已开跑），然后卡在闸门上，
 * 直到测试显式放行才产出终态（result 或直接结束）。
 * `interruptQuery` 默认「受理即返回」——这正是三内核的真实语义（Claude SDK 控制请求受理 /
 * Pi agent.abort() 置标志 / Codex turn/interrupt 应答），不代表工具与子进程已停。
 */
function createGatedAdapter(opts: {
  terminal?: 'result' | 'end'
  releaseOnInterrupt?: boolean
} = {}): { adapter: AgentProviderAdapter; release: () => void; started: Promise<void> } {
  let releaseGate!: () => void
  const gate = new Promise<void>((r) => {
    releaseGate = r
  })
  let startedResolve!: () => void
  const started = new Promise<void>((r) => {
    startedResolve = r
  })
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    releaseGate()
  }
  const adapter = {
    query: (): AsyncIterable<SDKMessage> =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'working' }] },
          parent_tool_use_id: null,
          session_id: 'sdk-gated-1',
        } as SDKMessage
        startedResolve()
        await gate
        if ((opts.terminal ?? 'result') === 'result') {
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 0, output_tokens: 0 },
          } as SDKMessage
        }
      })(),
    abort: () => {},
    hasActiveChannel: () => true,
    interruptQuery: async () => {
      if (opts.releaseOnInterrupt) {
        release()
        await flush()
      }
    },
    sendQueuedMessage: async () => {},
    dispose: () => {},
  } as unknown as AgentProviderAdapter
  return { adapter, release, started }
}

describe('SessionRuntime 原生终态闩锁（切换静默前提）', () => {
  it('停止受理后原生终态未到 → 闩锁保持，超时 fail-closed；终态到达才解除', async () => {
    const h = createGatedAdapter({ terminal: 'result' })
    const rt = new SessionRuntime('s1', h.adapter)
    rt.setCallbacks({})
    await rt.sendMessage({ sessionId: 's1', prompt: 'hi' } as QueryInput)
    await withTimeout(h.started)
    expect(rt.isTurnInFlight()).toBe(true)
    expect(rt.hasUnsettledStop()).toBe(false)

    // 中断：适配器受理即返回（宿主 turnInFlight 立刻翻转），但本轮原生终态还没来
    await withTimeout(rt.interrupt())
    expect(rt.isTurnInFlight()).toBe(false)
    expect(rt.hasUnsettledStop()).toBe(true) // ← 关键：受理 ≠ 静默

    // 超时 → false：调用方必须 fail-closed 拒绝切换，不能默认放行
    expect(await rt.waitForTurnSettled(50)).toBe(false)
    expect(rt.hasUnsettledStop()).toBe(true)

    // 旧内核终于收尾（原生 result）→ 闩锁解除，等待者被唤醒
    const waiting = rt.waitForTurnSettled(2000)
    h.release()
    expect(await withTimeout(waiting)).toBe(true)
    expect(rt.hasUnsettledStop()).toBe(false)
  })

  it('取消后 generator 直接结束（无 result）也算终态观察到', async () => {
    const h = createGatedAdapter({ terminal: 'end' })
    const rt = new SessionRuntime('s1', h.adapter)
    rt.setCallbacks({})
    await rt.sendMessage({ sessionId: 's1', prompt: 'hi' } as QueryInput)
    await withTimeout(h.started)
    await withTimeout(rt.interrupt())
    expect(rt.hasUnsettledStop()).toBe(true)
    h.release()
    expect(await withTimeout(rt.waitForTurnSettled(2000))).toBe(true)
    expect(rt.hasUnsettledStop()).toBe(false)
  })

  it('中断受理期间原生 result 恰好到达也不漏闩锁（先置位再调适配器）', async () => {
    const h = createGatedAdapter({ terminal: 'result', releaseOnInterrupt: true })
    const rt = new SessionRuntime('s1', h.adapter)
    rt.setCallbacks({})
    await rt.sendMessage({ sessionId: 's1', prompt: 'hi' } as QueryInput)
    await withTimeout(h.started)
    await withTimeout(rt.interrupt())
    expect(await withTimeout(rt.waitForTurnSettled(2000))).toBe(true)
    expect(rt.hasUnsettledStop()).toBe(false)
  })

  it('未在跑的回合调用 interrupt 不产生闩锁（不会误伤静默判定）', async () => {
    const h = createGatedAdapter()
    const rt = new SessionRuntime('s1', h.adapter)
    rt.setCallbacks({})
    expect(rt.hasUnsettledStop()).toBe(false)
    await withTimeout(rt.interrupt())
    expect(rt.hasUnsettledStop()).toBe(false)
    expect(await rt.waitForTurnSettled(50)).toBe(true)
    h.release()
  })

  it('正常回合（无中断）不置闩锁；结果到达后仍无闩锁', async () => {
    const r = await runSimple([{ kind: 'ok' }])
    expect(r.turnEnds).toBe(1)
    expect(r.rt.hasUnsettledStop()).toBe(false)
    expect(await r.rt.waitForTurnSettled(50)).toBe(true)
  })

  it('出错回合（进程崩溃恢复失败）不残留闩锁', async () => {
    const r = await runSimple([{ kind: 'crashNoSessionId' }])
    expect(r.errors.length).toBe(1)
    expect(r.rt.hasUnsettledStop()).toBe(false)
  })
})

// ===== 终态性质判定：onTurnEnd 不是成功专属 =====

describe('classifyTurnTerminal（终态性质判定）', () => {
  it('明确 success 或 Codex completed 才算成功', () => {
    expect(classifyTurnTerminal({ type: 'result', subtype: 'success' })).toBe('success')
    expect(classifyTurnTerminal({ kind: 'result', subtype: 'success' })).toBe('success')
    expect(classifyTurnTerminal({ kind: 'result', subtype: 'completed' })).toBe('success')
  })

  it('error_max_turns / error_during_execution / paused_no_progress / max_tokens 均为非成功', () => {
    for (const subtype of ['error_max_turns', 'error_during_execution', 'paused_no_progress', 'max_tokens']) {
      expect(classifyTurnTerminal({ type: 'result', subtype })).toBe('error')
      expect(classifyTurnTerminal({ kind: 'result', subtype })).toBe('error')
    }
  })

  it('is_error=true 或 errors 非空即使 subtype=success 也判非成功（社区实证 shape）', () => {
    expect(classifyTurnTerminal({ type: 'result', subtype: 'success', is_error: true })).toBe('error')
    expect(classifyTurnTerminal({ type: 'result', subtype: 'success', errors: ['boom'] })).toBe('error')
    expect(classifyTurnTerminal({ kind: 'result', errors: ['boom'] })).toBe('error')
    expect(classifyTurnTerminal({ kind: 'result', subtype: 'completed', is_error: true })).toBe('error')
    expect(classifyTurnTerminal({ kind: 'result', subtype: 'completed', errors: ['boom'] })).toBe('error')
  })

  it('形状不可判定 → unknown（调用方按非成功处理）', () => {
    expect(classifyTurnTerminal({ type: 'result' })).toBe('unknown')
    expect(classifyTurnTerminal({ type: 'assistant' })).toBe('unknown')
    expect(classifyTurnTerminal(undefined)).toBe('unknown')
    expect(classifyTurnTerminal(null)).toBe('unknown')
  })
})

describe('onTurnEnd 携带终态性质（不把错误终态当成功）', () => {
  /** 用自定义终态 result 跑一轮，收集 onTurnEnd 的 info。 */
  async function runWithResult(result: unknown): Promise<Array<TurnTerminalInfo | undefined>> {
    const { adapter } = createMock([])
    const infos: Array<TurnTerminalInfo | undefined> = []
    const rt = new SessionRuntime('s1', adapter)
    rt.setCallbacks({
      onTurnEnd: (info) => {
        infos.push(info)
      },
    })
    // 用 query 覆盖：直接产出 assistant + 自定义 result
    ;(adapter as unknown as { query: unknown }).query = (): AsyncIterable<SDKMessage> =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: 'assistant', message: { content: [] }, parent_tool_use_id: null, session_id: 'sdk-1' } as SDKMessage
        yield result as SDKMessage
      })()
    await rt.sendMessage({ sessionId: 's1', prompt: 'hi' } as QueryInput)
    await waitFor(() => infos.length > 0)
    return infos
  }

  it('成功 result → outcome=success', async () => {
    const infos = await runWithResult({ type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } })
    expect(infos.at(-1)?.outcome).toBe('success')
  })

  it('Codex completed result → outcome=success', async () => {
    const infos = await runWithResult({ kind: 'result', subtype: 'completed' })
    expect(infos.at(-1)?.outcome).toBe('success')
  })

  it('error_max_turns result → 仍调 onTurnEnd，但 outcome=error', async () => {
    const infos = await runWithResult({
      type: 'result',
      subtype: 'error_max_turns',
      errors: ['已达最大工具循环轮次'],
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(infos.length).toBeGreaterThan(0)
    expect(infos.at(-1)?.outcome).toBe('error')
  })

  it('error_during_execution（is_error / errors）→ outcome=error', async () => {
    const infos = await runWithResult({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['stream error'],
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(infos.at(-1)?.outcome).toBe('error')
  })
})

describe('停止闩锁的 epoch 守卫与发送闸门', () => {
  it('旧圈（epoch 不匹配）不得结算新回合的停止闩锁', () => {
    const h = createGatedAdapter()
    const rt = new SessionRuntime('s1', h.adapter)
    rt.setCallbacks({})
    const internals = rt as unknown as {
      loopEpoch: number
      stopSettlementPending: boolean
      markTurnSettled: (epoch?: number) => void
    }
    internals.loopEpoch = 7
    internals.stopSettlementPending = true
    // 旧圈退出（epoch=6）：不得清除闩锁
    internals.markTurnSettled(6)
    expect(rt.hasUnsettledStop()).toBe(true)
    // 当前圈退出（epoch=7）：正常清除
    internals.markTurnSettled(7)
    expect(rt.hasUnsettledStop()).toBe(false)
    h.release()
  })

  it('旧回合未确认停稳时开新回合被拒绝（fail-closed，不并行两轮）', async () => {
    const h = createGatedAdapter()
    const rt = new SessionRuntime('s1', h.adapter)
    rt.setCallbacks({})
    await rt.sendMessage({ sessionId: 's1', prompt: 'A' } as QueryInput)
    await withTimeout(h.started)
    await withTimeout(rt.interrupt()) // 受理即返回；原生终态未到 → 闩锁置位
    expect(rt.hasUnsettledStop()).toBe(true)

    // 让有界等待直接超时（避免真的等 15s），验证闸门本身
    const spy = vi.spyOn(rt, 'waitForTurnSettled').mockResolvedValue(false)
    await expect(rt.sendMessage({ sessionId: 's1', prompt: 'B' } as QueryInput)).rejects.toThrow(
      /尚未确认停稳/,
    )
    spy.mockRestore()

    // 旧回合真正收尾后，同样的发送即可通过
    h.release()
    expect(await withTimeout(rt.waitForTurnSettled(2000))).toBe(true)
    await expect(rt.sendMessage({ sessionId: 's1', prompt: 'B' } as QueryInput)).resolves.toBeUndefined()
  })

  it('等待上限常量为 15s（有界，不无限挂起）', () => {
    expect(TURN_SETTLE_TIMEOUT_MS).toBe(15_000)
  })

  it('配置换核 abort 仅被受理时，旧 generator finally 前不得启动同会话新 loop', async () => {
    let releaseOldResult!: () => void
    const oldResultGate = new Promise<void>((resolve) => {
      releaseOldResult = resolve
    })
    let releaseOldFinally!: () => void
    const oldFinallyGate = new Promise<void>((resolve) => {
      releaseOldFinally = resolve
    })
    let oldLoopStarted!: () => void
    const oldLoopStartedPromise = new Promise<void>((resolve) => {
      oldLoopStarted = resolve
    })
    let oldResultYielded!: () => void
    const oldResultYieldedPromise = new Promise<void>((resolve) => {
      oldResultYielded = resolve
    })
    const calls: string[] = []
    let oldGeneratorFinally = false
    const adapter = {
      query: (input: QueryInput): AsyncIterable<SDKMessage> => {
        calls.push(input.prompt)
        const isOldLoop = calls.length === 1
        return (async function* (): AsyncGenerator<SDKMessage> {
          if (isOldLoop) {
            try {
              yield {
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'old' }] },
                parent_tool_use_id: null,
              } as SDKMessage
              oldLoopStarted()
              await oldResultGate
              // A result alone is not enough for config retirement: a long-lived native
              // channel may still be alive after it has emitted a terminal turn message.
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                usage: { input_tokens: 0, output_tokens: 0 },
              } as SDKMessage
              oldResultYielded()
              await oldFinallyGate
            } finally {
              oldGeneratorFinally = true
            }
          } else {
            expect(oldGeneratorFinally).toBe(true)
            yield {
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 0, output_tokens: 0 },
            } as SDKMessage
          }
        })()
      },
      // Mirrors a real asynchronous native abort: accepted now, but its
      // iterator/process may still be draining when the next SEND arrives.
      abort: vi.fn(),
      hasActiveChannel: () => true,
      interruptQuery: async () => {},
      sendQueuedMessage: async () => {},
      dispose: () => {},
    } as unknown as AgentProviderAdapter
    const rt = new SessionRuntime('s-config-abort-race', adapter)
    rt.setCallbacks({})

    await rt.sendMessage({
      sessionId: 's-config-abort-race',
      prompt: 'old',
      executionMode: 'chat',
    } as QueryInput)
    await withTimeout(oldLoopStartedPromise)

    rt.dropLiveProcessForConfigChange('test')
    expect(rt.hasUnsettledStop()).toBe(true)
    const sending = rt.sendMessage({
      sessionId: 's-config-abort-race',
      prompt: 'new',
      executionMode: 'work',
    } as QueryInput)
    await flush()

    // Fail closed: abort acceptance alone must not spawn a replacement.
    expect(calls).toEqual(['old'])

    releaseOldResult()
    await withTimeout(oldResultYieldedPromise)
    await flush()
    // Nor may a late terminal result release the retirement fence: only the old
    // generator's finally proves its long-lived native channel has gone away.
    expect(calls).toEqual(['old'])

    releaseOldFinally()
    await withTimeout(sending)
    expect(calls).toEqual(['old', 'new'])
    expect(rt.hasUnsettledStop()).toBe(false)
    rt.destroy()
  })

  it('idle 长驻 channel 配置换核后若旧 generator 立即结束，可安全重启', async () => {
    let releaseIdleLoop!: () => void
    const idleLoopGate = new Promise<void>((resolve) => {
      releaseIdleLoop = resolve
    })
    let firstResult!: () => void
    const firstResultPromise = new Promise<void>((resolve) => {
      firstResult = resolve
    })
    const calls: string[] = []
    const abort = vi.fn(() => releaseIdleLoop())
    let oldGeneratorFinally = false
    let secondStartedBeforeOldFinally = false
    const adapter = {
      query: (input: QueryInput): AsyncIterable<SDKMessage> => {
        calls.push(input.prompt)
        const first = calls.length === 1
        return (async function* (): AsyncGenerator<SDKMessage> {
          if (first) {
            try {
              yield {
                type: 'assistant',
                message: { content: [] },
                parent_tool_use_id: null,
              } as SDKMessage
              yield {
                type: 'result',
                subtype: 'success',
                usage: { input_tokens: 0, output_tokens: 0 },
              } as SDKMessage
              firstResult()
              // Model an idle long-lived app-server/SDK channel awaiting its next turn.
              await idleLoopGate
            } finally {
              oldGeneratorFinally = true
            }
          } else {
            secondStartedBeforeOldFinally = !oldGeneratorFinally
            yield {
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 0, output_tokens: 0 },
            } as SDKMessage
          }
        })()
      },
      abort,
      hasActiveChannel: () => true,
      interruptQuery: async () => {},
      sendQueuedMessage: async () => {},
      dispose: () => {},
    } as unknown as AgentProviderAdapter
    const rt = new SessionRuntime('s-config-idle-retire', adapter)
    rt.setCallbacks({})

    await rt.sendMessage({
      sessionId: 's-config-idle-retire',
      prompt: 'idle-old',
      executionMode: 'chat',
    } as QueryInput)
    await withTimeout(firstResultPromise)
    expect(rt.isTurnInFlight()).toBe(false)

    // The next SEND itself detects Chat→Work and retires the idle long-lived loop.
    // It must not start the replacement until the old generator finally has run.
    const switching = rt.sendMessage({
      sessionId: 's-config-idle-retire',
      prompt: 'idle-new',
      executionMode: 'work',
    } as QueryInput)
    await withTimeout(switching)

    expect(abort).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['idle-old', 'idle-new'])
    expect(secondStartedBeforeOldFinally).toBe(false)
    expect(rt.hasUnsettledStop()).toBe(false)
    rt.destroy()
  })

  it('配置换核等待旧 finally 时 destroy，settlement 后不得重新 startLoop', async () => {
    let releaseOldLoop!: () => void
    const oldLoopGate = new Promise<void>((resolve) => {
      releaseOldLoop = resolve
    })
    let firstResult!: () => void
    const firstResultPromise = new Promise<void>((resolve) => {
      firstResult = resolve
    })
    const calls: string[] = []
    const abort = vi.fn()
    const adapter = {
      query: (input: QueryInput): AsyncIterable<SDKMessage> => {
        calls.push(input.prompt)
        return (async function* (): AsyncGenerator<SDKMessage> {
          yield {
            type: 'assistant',
            message: { content: [] },
            parent_tool_use_id: null,
          } as SDKMessage
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 0, output_tokens: 0 },
          } as SDKMessage
          firstResult()
          try {
            await oldLoopGate
          } finally {
            // Reaching this finally is what settles the retirement fence.
          }
        })()
      },
      abort,
      hasActiveChannel: () => true,
      interruptQuery: async () => {},
      sendQueuedMessage: async () => {},
      dispose: () => {},
    } as unknown as AgentProviderAdapter
    const rt = new SessionRuntime('s-config-destroy-during-wait', adapter)
    rt.setCallbacks({})

    await rt.sendMessage({
      sessionId: 's-config-destroy-during-wait',
      prompt: 'old',
      executionMode: 'chat',
    } as QueryInput)
    await withTimeout(firstResultPromise)

    const switching = rt.sendMessage({
      sessionId: 's-config-destroy-during-wait',
      prompt: 'new',
      executionMode: 'work',
    } as QueryInput)
    await flush()
    expect(calls).toEqual(['old'])
    expect(rt.hasUnsettledStop()).toBe(true)

    rt.destroy()
    releaseOldLoop()

    await expect(withTimeout(switching)).rejects.toThrow(/会话已关闭/)
    expect(calls).toEqual(['old'])
    expect(abort).toHaveBeenCalledTimes(2) // config retirement + destroy
  })

  it('配置换核 abort 抛错仍保留 retirement fence，不能误放行新 loop', async () => {
    let releaseOldLoop!: () => void
    const oldLoopGate = new Promise<void>((resolve) => {
      releaseOldLoop = resolve
    })
    let oldLoopStarted!: () => void
    const oldLoopStartedPromise = new Promise<void>((resolve) => {
      oldLoopStarted = resolve
    })
    const calls: string[] = []
    let abortFails = true
    const abort = vi.fn(() => {
      if (abortFails) throw new Error('native abort failed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = {
      query: (input: QueryInput): AsyncIterable<SDKMessage> => {
        calls.push(input.prompt)
        return (async function* (): AsyncGenerator<SDKMessage> {
          try {
            yield {
              type: 'assistant',
              message: { content: [] },
              parent_tool_use_id: null,
            } as SDKMessage
            oldLoopStarted()
            await oldLoopGate
          } finally {
            // Deliberately empty: reaching generator finally is the retirement signal.
          }
        })()
      },
      abort,
      hasActiveChannel: () => true,
      interruptQuery: async () => {},
      sendQueuedMessage: async () => {},
      dispose: () => {},
    } as unknown as AgentProviderAdapter
    const rt = new SessionRuntime('s-config-abort-throw', adapter)
    rt.setCallbacks({})

    await rt.sendMessage({ sessionId: 's-config-abort-throw', prompt: 'old' } as QueryInput)
    await withTimeout(oldLoopStartedPromise)
    rt.dropLiveProcessForConfigChange('abort-throws')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(rt.hasUnsettledStop()).toBe(true)

    // Do not really wait 15 seconds in unit test; the runtime must select its
    // existing fail-closed path rather than spawning a replacement after abort throws.
    const waitForSettlement = vi.spyOn(rt, 'waitForTurnSettled').mockResolvedValue(false)
    await expect(
      rt.sendMessage({ sessionId: 's-config-abort-throw', prompt: 'new' } as QueryInput),
    ).rejects.toThrow(/尚未确认停稳/)
    expect(calls).toEqual(['old'])
    waitForSettlement.mockRestore()

    releaseOldLoop()
    expect(await withTimeout(rt.waitForTurnSettled(2000))).toBe(true)
    abortFails = false
    rt.destroy()
    warn.mockRestore()
  })
})
