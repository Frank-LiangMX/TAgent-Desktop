import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionMeta, SessionRuntimeSwitchInput } from '@tagent/shared'
import {
  createRuntimeSwitchGuard,
  requiresBindingSwitch,
  RUNTIME_SWITCH_BUSY_MESSAGE,
  RUNTIME_SWITCH_PENDING_MESSAGE,
  runRuntimeSwitch,
  type RuntimeSwitchGuard,
} from './runtime-switch-flow'

describe('requiresBindingSwitch', () => {
  const current = { channelId: 'openai', modelId: 'gpt-4o' }

  it('草稿只更新本地选择，首发时再物化', () => {
    expect(requiresBindingSwitch(true, current, { channelId: 'openai-2', modelId: 'gpt-5' })).toBe(false)
  })

  it('已物化会话同内核换渠道或模型也必须走事务切换', () => {
    expect(requiresBindingSwitch(false, current, { channelId: 'openai', modelId: 'gpt-5' })).toBe(true)
    expect(requiresBindingSwitch(false, current, { channelId: 'anthropic', modelId: 'claude' })).toBe(true)
  })

  it('绑定对未变化时不重复发起切换', () => {
    expect(requiresBindingSwitch(false, current, current)).toBe(false)
    expect(requiresBindingSwitch(false, null, current)).toBe(true)
  })
})

function meta(patch: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 's1',
    title: 't',
    channelId: 'openai',
    modelId: 'gpt-x',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

const REQUEST = {
  sessionId: 's1',
  channelId: 'openai',
  modelId: 'gpt-x',
  runtime: 'pi' as const,
}

/** 默认用一个全新的闸门；需要断言锁行为时显式传入共享闸门 */
function options(
  overrides: Partial<Parameters<typeof runRuntimeSwitch>[0]> & {
    guard?: RuntimeSwitchGuard
  } = {},
) {
  return {
    request: REQUEST,
    busy: false,
    isDraft: false,
    switchRuntime: vi.fn(() => Promise.resolve(meta())),
    onPendingChange: vi.fn(),
    onAdopt: vi.fn(),
    onRollback: vi.fn(),
    ...overrides,
    guard: overrides.guard ?? createRuntimeSwitchGuard(),
  }
}

describe('runRuntimeSwitch', () => {
  it('拒绝运行中的会话，不发请求（要求先停止本轮）', async () => {
    const switchRuntime = vi.fn()
    const onPendingChange = vi.fn()
    const onAdopt = vi.fn()
    const onRollback = vi.fn()

    const outcome = await runRuntimeSwitch(
      options({ busy: true, switchRuntime, onPendingChange, onAdopt, onRollback }),
    )

    expect(outcome).toMatchObject({ ok: false, blockedByBusy: true })
    expect(outcome.error).toBe(RUNTIME_SWITCH_BUSY_MESSAGE)
    expect(switchRuntime).not.toHaveBeenCalled()
    expect(onPendingChange).not.toHaveBeenCalled()
    expect(onAdopt).not.toHaveBeenCalled()
    expect(onRollback).not.toHaveBeenCalled()
  })

  it('草稿会话只做本地一致选择，不调持久化 API', async () => {
    const switchRuntime = vi.fn()
    const onAdopt = vi.fn()

    const outcome = await runRuntimeSwitch(
      options({ isDraft: true, switchRuntime, onAdopt }),
    )

    expect(outcome.ok).toBe(true)
    expect(switchRuntime).not.toHaveBeenCalled()
    expect(onAdopt).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'openai', modelId: 'gpt-x' }),
      REQUEST,
    )
  })

  it('已物化会话：在途置 pending，成功后采纳主进程 meta 并清 pending', async () => {
    const order: string[] = []
    let release: ((value: AgentSessionMeta) => void) | undefined
    const switchRuntime = vi.fn(
      (input: SessionRuntimeSwitchInput) =>
        new Promise<AgentSessionMeta>((resolve) => {
          order.push(`call:${input.runtime}`)
          release = resolve
        }),
    )
    const onAdopt = vi.fn((adopted: AgentSessionMeta) => {
      order.push('adopt')
      expect(adopted.channelId).toBe('openai')
    })
    const onRollback = vi.fn()

    const pending = runRuntimeSwitch(
      options({
        switchRuntime,
        onAdopt,
        onRollback,
        onPendingChange: (value) => order.push(`pending:${value}`),
      }),
    )

    expect(order).toEqual(['pending:true', 'call:pi'])
    release?.(meta({ internalBackend: undefined }))
    const outcome = await pending

    expect(outcome.ok).toBe(true)
    expect(order).toEqual(['pending:true', 'call:pi', 'adopt', 'pending:false'])
    expect(onRollback).not.toHaveBeenCalled()
  })

  it('失败：回滚本地选择，pending 复位，并把错误抛给调用方展示', async () => {
    const onAdopt = vi.fn()
    const onRollback = vi.fn()
    const pendingValues: boolean[] = []

    const outcome = await runRuntimeSwitch(
      options({
        switchRuntime: () => Promise.reject(new Error('该会话已有运行内核切换在处理中')),
        onAdopt,
        onRollback,
        onPendingChange: (value) => pendingValues.push(value),
      }),
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('该会话已有运行内核切换在处理中')
    expect(onAdopt).not.toHaveBeenCalled()
    expect(onRollback).toHaveBeenCalledTimes(1)
    expect(pendingValues).toEqual([true, false])
  })

  it('采纳主进程回传的绑定（internalBackend / 原生 id 归档不影响选择）', async () => {
    const onAdopt = vi.fn()

    const outcome = await runRuntimeSwitch(
      options({
        request: { ...REQUEST, runtime: 'codex', channelId: 'codex', modelId: 'gpt-5' },
        switchRuntime: () =>
          Promise.resolve(
            meta({
              channelId: 'codex',
              modelId: 'gpt-5',
              internalBackend: 'codex-app-server',
              codexThreadId: 'thread-1',
            }),
          ),
        onAdopt,
      }),
    )

    expect(outcome.ok).toBe(true)
    expect(onAdopt).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'codex',
        internalBackend: 'codex-app-server',
      }),
      expect.objectContaining({ runtime: 'codex' }),
    )
  })

  it('同步闸门：在途时的第二次调用不发第二个请求（不依赖 useState）', async () => {
    const guard = createRuntimeSwitchGuard()
    let release: ((value: AgentSessionMeta) => void) | undefined
    const switchRuntime = vi.fn(
      () =>
        new Promise<AgentSessionMeta>((resolve) => {
          release = resolve
        }),
    )
    const onAdopt = vi.fn()

    // 同一 tick 内连续两次（渲染尚未发生，pending state 还没生效）
    const first = runRuntimeSwitch(options({ guard, switchRuntime, onAdopt }))
    const second = runRuntimeSwitch(options({ guard, switchRuntime, onAdopt }))

    await expect(second).resolves.toMatchObject({
      ok: false,
      blockedByPending: true,
      error: RUNTIME_SWITCH_PENDING_MESSAGE,
    })
    expect(switchRuntime).toHaveBeenCalledTimes(1)

    release?.(meta())
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(onAdopt).toHaveBeenCalledTimes(1)
  })

  it('锁在完成后释放：可以再次切换', async () => {
    const guard = createRuntimeSwitchGuard()
    const switchRuntime = vi.fn(() => Promise.resolve(meta()))

    await runRuntimeSwitch(options({ guard, switchRuntime }))
    expect(guard.locked).toBe(false)
    await runRuntimeSwitch(options({ guard, switchRuntime }))
    expect(switchRuntime).toHaveBeenCalledTimes(2)
  })

  it('会话身份过期：切走会话后的迟到成功不得采纳/回滚', async () => {
    const guard = createRuntimeSwitchGuard()
    let release: ((value: AgentSessionMeta) => void) | undefined
    const onAdopt = vi.fn()
    const onRollback = vi.fn()
    const switchRuntime = vi.fn(
      () =>
        new Promise<AgentSessionMeta>((resolve) => {
          release = resolve
        }),
    )

    const pending = runRuntimeSwitch(
      options({ guard, switchRuntime, onAdopt, onRollback }),
    )
    // 用户切到别的会话 → 闸门作废在途 token
    guard.invalidate()
    release?.(meta({ modelId: 'gpt-y' }))

    await expect(pending).resolves.toMatchObject({ ok: false, stale: true })
    expect(onAdopt).not.toHaveBeenCalled()
    expect(onRollback).not.toHaveBeenCalled()
  })

  it('会话身份过期：迟到的失败也不得回滚本地选择', async () => {
    const guard = createRuntimeSwitchGuard()
    let reject: ((error: Error) => void) | undefined
    const onRollback = vi.fn()
    const switchRuntime = vi.fn(
      () =>
        new Promise<AgentSessionMeta>((_resolve, rej) => {
          reject = rej
        }),
    )

    const pending = runRuntimeSwitch(options({ guard, switchRuntime, onRollback }))
    guard.invalidate()
    reject?.(new Error('目标内核不可用'))

    await expect(pending).resolves.toMatchObject({ ok: false, stale: true })
    expect(onRollback).not.toHaveBeenCalled()
  })

  it('旧请求完成不得解除新会话的 pending 或锁', async () => {
    const guard = createRuntimeSwitchGuard()
    let release: ((value: AgentSessionMeta) => void) | undefined
    const pendingValues: boolean[] = []
    const switchRuntime = vi.fn(
      () =>
        new Promise<AgentSessionMeta>((resolve) => {
          release = resolve
        }),
    )

    const pending = runRuntimeSwitch(
      options({
        guard,
        switchRuntime,
        onPendingChange: (value) => pendingValues.push(value),
      }),
    )
    guard.invalidate()
    // Chat 在切会话时复位旧 pending；新会话随后开始另一次切换。
    pendingValues.push(false)
    let releaseNew: ((value: AgentSessionMeta) => void) | undefined
    const next = runRuntimeSwitch(options({
      guard,
      request: { ...REQUEST, sessionId: 's2' },
      switchRuntime: () => new Promise<AgentSessionMeta>((resolve) => { releaseNew = resolve }),
      onPendingChange: (value) => pendingValues.push(value),
    }))
    release?.(meta())
    await pending

    expect(pendingValues).toEqual([true, false, true])
    expect(guard.locked).toBe(true)
    releaseNew?.(meta({ id: 's2' }))
    await next
    expect(pendingValues).toEqual([true, false, true, false])
    expect(guard.locked).toBe(false)
  })

  it.each([undefined, meta({ id: 'other' }), meta({ channelId: 'other' })])(
    '缺失或错配的 IPC 返回不得伪装为切换成功：%j', async (returned) => {
      const onAdopt = vi.fn()
      const onRollback = vi.fn()
      const outcome = await runRuntimeSwitch(options({
        switchRuntime: async () => returned as AgentSessionMeta,
        onAdopt,
        onRollback,
      }))
      expect(outcome.ok).toBe(false)
      expect(onAdopt).not.toHaveBeenCalled()
      expect(onRollback).toHaveBeenCalledOnce()
    },
  )
})
