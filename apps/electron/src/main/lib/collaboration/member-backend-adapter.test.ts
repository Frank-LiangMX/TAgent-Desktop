/**
 * 成员后端适配器单测（Stage 2）
 *
 * 验证 resolveChannelBackendConfig 的渠道解析策略与 ChannelBackendAdapter.runTurn 的真实调用接线
 * （mock channel-store 凭据 + mock @tagent/pi-core seat runner，不发真实 HTTP）。
 *
 * 覆盖：
 * - 显式外部 channelId → external 配置（带解密 apiKey + baseUrl）
 * - 显式 kscc-internal channelId → kscc 配置（带 ksccPath）
 * - 未绑定 channelId → 优先 kscc（本机可用），否则第一个 enabled 外部渠道
 * - 未绑定 + 无任何可用渠道 → MemberBackendResolveError('NO_CHANNEL_BACKEND')
 * - 渠道已删除 / 未启用 / 无 apiKey / 无模型 → 各自错误码
 * - runTurn：把 systemPrompt/prompt/modelId/signal 透传给 seat runner 并返回正文
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Channel, ChannelModel, MemberTurnInput } from '@tagent/shared'

// ===== mock 状态（vi.hoisted 保证 vi.mock 工厂能引用） =====
const channelState = vi.hoisted(() => ({
  channels: [] as Channel[],
  decrypted: {} as Record<string, string>,
}))
const seatState = vi.hoisted(() => ({
  lastFactoryOpts: null as { provider?: string; apiKey?: string; baseUrl?: string } | null,
  lastRunArgs: null as {
    modelId?: string
    prompt?: string
    systemPrompt?: string
    signal?: AbortSignal
  } | null,
  returnText: 'seat-reply',
  throwErr: null as Error | null,
  /** P1-2b：为 true 时 runSeat 挂起直到 signal abort（模拟进行中 turn），用于 interrupt 取消测试。 */
  hang: false,
}))

const cliState = vi.hoisted(() => ({
  lastInput: null as {
    cwd: string
    sessionId: string
    prompt: string
    signal: AbortSignal
  } | null,
  available: true,
  result: { ok: true, summary: 'cli-reply', durationMs: 17 },
}))
const codexState = vi.hoisted(() => ({
  lastInput: null as Record<string, unknown> | null,
  resumeThreadIds: [] as Array<string | undefined>,
  aborts: [] as string[],
  toolCallResult: null as unknown,
  hang: false,
  rejectHang: null as ((error: Error) => void) | null,
}))
const codexMemberState = vi.hoisted(() => ({
  member: null as Record<string, unknown> | null,
}))
vi.mock('../channel/channel-store', () => ({
  listChannels: () => channelState.channels,
  getChannel: (id: string) => channelState.channels.find((c) => c.id === id),
  getDecryptedApiKey: (id: string) => channelState.decrypted[id] ?? '',
}))

vi.mock('../agent/cli-workers/resolve-backend', () => ({
  resolveTaskSubagentBackend: () =>
    cliState.available
      ? { kind: 'cli', worker: { id: 'worker-test' } }
      : { kind: 'unavailable' },
}))

vi.mock('../agent/cli-workers/run-cli-worker', () => ({
  runCliWorker: async (input: {
    cwd: string
    sessionId: string
    prompt: string
    signal: AbortSignal
  }) => {
    cliState.lastInput = input
    return cliState.result
  },
}))
vi.mock('@tagent/pi-core', () => {
  const runSeat = async (args: { modelId: string; prompt: string; systemPrompt?: string; signal?: AbortSignal }) => {
    seatState.lastRunArgs = args
    if (seatState.hang) {
      // 挂起直到 signal abort，模拟进行中 turn 被 interrupt 取消。
      return new Promise<string>((_, reject) => {
        if (args.signal?.aborted) { reject(new Error('aborted')); return }
        args.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (seatState.throwErr) throw seatState.throwErr
    return seatState.returnText
  }
  return {
    createPiHttpSeatRunner: (opts: { provider: string; apiKey: string; baseUrl?: string }) => {
      seatState.lastFactoryOpts = opts
      return { runSeat }
    },
  }
})
vi.mock('../adapters/codex/codex-app-server-adapter', () => ({
  CodexAppServerAdapter: class {
    async *query(input: {
      sessionId: string
      resumeThreadId?: string
      onThreadId?: (threadId: string) => void
      onServerRequest?: (request: unknown) => unknown | Promise<unknown>
    }) {
      codexState.lastInput = input as unknown as Record<string, unknown>
      codexState.resumeThreadIds.push(input.resumeThreadId)
      input.onThreadId?.('codex-thread-1')
      if (codexState.hang) {
        await new Promise<void>((_, reject) => {
          codexState.rejectHang = reject
        })
      }
      if (input.onServerRequest) {
        codexState.toolCallResult = await input.onServerRequest({
          id: 'request-1',
          method: 'item/tool/call',
          params: {
            threadId: 'codex-thread-1',
            turnId: 'turn-1',
            callId: 'call-1',
            namespace: null,
            tool: 'room_send',
            arguments: {
              toMemberId: 'cm_target',
              message: '来自 Codex',
            },
          },
        })
      }
      yield { kind: 'stream_text_delta', text: 'codex-reply' }
      yield { kind: 'result', subtype: 'completed' }
    }

    abort(sessionId: string): void {
      codexState.aborts.push(sessionId)
      codexState.rejectHang?.(new Error('native aborted'))
      codexState.rejectHang = null
    }
  },
}))
vi.mock('./collaboration-room-repository', () => ({
  getMember: () => codexMemberState.member,
  upsertMember: (member: Record<string, unknown>) => {
    codexMemberState.member = member
  },
}))

import {
  resolveChannelBackendConfig,
  channelSupportsRoomToolBridge,
  ChannelBackendAdapter,
  MemberBackendResolveError,
  resetCodexRoomThreadCacheForTests,
} from './member-backend-adapter'
import { ChannelMemberSessionLifecycleAdapter } from './member-session-lifecycle'

function fakeModel(id: string, enabled = true): ChannelModel {
  return { id, name: id, enabled, contextWindow: 200_000 }
}

function fakeChannel(over: Partial<Channel> & Pick<Channel, 'id' | 'provider'>): Channel {
  return {
    name: over.provider,
    baseUrl: '',
    apiKey: '',
    models: [fakeModel('default-model')],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Channel
}

beforeEach(() => {
  channelState.channels = []
  channelState.decrypted = {}
  seatState.lastFactoryOpts = null
  seatState.lastRunArgs = null
  seatState.returnText = 'seat-reply'
  seatState.throwErr = null
  seatState.hang = false
  cliState.lastInput = null
  cliState.available = true
  cliState.result = { ok: true, summary: 'cli-reply', durationMs: 17 }
  codexState.lastInput = null
  codexState.resumeThreadIds = []
  codexState.aborts = []
  codexState.toolCallResult = null
  codexState.hang = false
  codexState.rejectHang = null
  codexMemberState.member = {
    id: 'cm_codex',
    backend: 'codex',
    logicalSessionId: 'codex-member-session',
    updatedAt: 0,
  }
})

describe('resolveChannelBackendConfig', () => {
  test('显式外部 channelId → external 配置（解密 apiKey + baseUrl + 渠道默认模型）', () => {
    channelState.channels = [
      fakeChannel({
        id: 'ch1',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        models: [fakeModel('claude-x'), fakeModel('claude-y', false)],
        defaultModelId: 'claude-x',
      }),
    ]
    channelState.decrypted = { ch1: 'secret-key' }

    const cfg = resolveChannelBackendConfig({ channelId: 'ch1' })
    expect(cfg.kind).toBe('external')
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.apiKey).toBe('secret-key')
    expect(cfg.baseUrl).toBe('https://api.anthropic.com')
    // defaultModelId（enabled）被选中
    expect(cfg.modelId).toBe('claude-x')
  })

  test('成员显式 modelId 优先于渠道默认', () => {
    channelState.channels = [
      fakeChannel({
        id: 'ch1',
        provider: 'openai',
        models: [fakeModel('gpt-a'), fakeModel('gpt-b')],
        defaultModelId: 'gpt-a',
      }),
    ]
    channelState.decrypted = { ch1: 'k' }
    const cfg = resolveChannelBackendConfig({ channelId: 'ch1', modelId: 'gpt-b' })
    expect(cfg.modelId).toBe('gpt-b')
  })

  test('explicit kscc-internal channelId -> NO_KSCC (legacy kscc CLI path removed)', () => {
    channelState.channels = [fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm-5.2')] })]
    expect(() => resolveChannelBackendConfig({ channelId: 'kscc-internal' })).toThrowError(
      /NO_KSCC|disabled/i,
    )
  })

  test('unbound channelId -> first enabled external channel with apiKey (skips legacy kscc)', () => {
    channelState.channels = [
      fakeChannel({ id: 'disabled', provider: 'openai', enabled: false, models: [fakeModel('m')] }),
      fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm')] }),
      fakeChannel({ id: 'ext1', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', models: [fakeModel('deepseek-chat')] }),
    ]
    channelState.decrypted = { ext1: 'dk-key' }

    const cfg = resolveChannelBackendConfig({})
    expect(cfg.kind).toBe('external')
    expect(cfg.provider).toBe('deepseek')
    expect(cfg.apiKey).toBe('dk-key')
    expect(cfg.modelId).toBe('deepseek-chat')
  })

  test('unbound + only legacy kscc channels -> NO_CHANNEL_BACKEND', () => {
    channelState.channels = [
      fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm-5.2')] }),
    ]
    expect(() => resolveChannelBackendConfig({})).toThrowError(
      /NO_CHANNEL_BACKEND/,
    )
  })

  test('unbound + no usable channel -> NO_CHANNEL_BACKEND', () => {
    channelState.channels = [
      fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm')] }),
      fakeChannel({ id: 'nokey', provider: 'openai', models: [fakeModel('m')] }),
    ]
    channelState.decrypted = {}
    expect(() => resolveChannelBackendConfig({})).toThrowError(
      /NO_CHANNEL_BACKEND/,
    )
  })
  test('渠道已删除 → NO_CHANNEL', () => {
    expect(() => resolveChannelBackendConfig({ channelId: 'gone' })).toThrowError(/NO_CHANNEL/)
  })

  test('渠道未启用 → CHANNEL_DISABLED', () => {
    channelState.channels = [fakeChannel({ id: 'off', provider: 'openai', enabled: false, models: [fakeModel('m')] })]
    expect(() => resolveChannelBackendConfig({ channelId: 'off' })).toThrowError(/CHANNEL_DISABLED/)
  })

  test('外部渠道无 apiKey → NO_API_KEY', () => {
    channelState.channels = [fakeChannel({ id: 'nokey', provider: 'openai', models: [fakeModel('m')] })]
    channelState.decrypted = {}
    expect(() => resolveChannelBackendConfig({ channelId: 'nokey' })).toThrowError(/NO_API_KEY/)
  })

  test('渠道无可用模型 → NO_MODEL', () => {
    channelState.channels = [fakeChannel({ id: 'nomodel', provider: 'openai', models: [fakeModel('m', false)] })]
    channelState.decrypted = { nomodel: 'k' }
    expect(() => resolveChannelBackendConfig({ channelId: 'nomodel' })).toThrowError(/NO_MODEL/)
  })
})

describe('channelSupportsRoomToolBridge', () => {
  test('Anthropic protocol external channels declare support; kscc-internal / OpenAI-completions / google / missing fail closed', () => {
    channelState.channels = [
      fakeChannel({ id: 'kscc', provider: 'kscc-internal' }),
      fakeChannel({ id: 'anthropic-ch', provider: 'anthropic' }),
      fakeChannel({ id: 'deepseek-ch', provider: 'deepseek' }),
      fakeChannel({ id: 'kimi-ch', provider: 'kimi-api' }),
      fakeChannel({ id: 'zhipu-coding-ch', provider: 'zhipu-coding' }),
      fakeChannel({ id: 'qwen-anthropic-ch', provider: 'qwen-anthropic' }),
      fakeChannel({ id: 'openai-ch', provider: 'openai' }),
      fakeChannel({ id: 'zhipu-ch', provider: 'zhipu' }),
      fakeChannel({ id: 'doubao-ch', provider: 'doubao' }),
      fakeChannel({ id: 'qwen-ch', provider: 'qwen' }),
      fakeChannel({ id: 'custom-ch', provider: 'custom' }),
      fakeChannel({ id: 'google-ch', provider: 'google' }),
    ]
    // kscc 走 antml 文本协议桥
    expect(channelSupportsRoomToolBridge('kscc')).toBe(false)
    // Anthropic /v1/messages 协议外部渠道 → 原生 function/tool calling 桥
    expect(channelSupportsRoomToolBridge('anthropic-ch')).toBe(true)
    expect(channelSupportsRoomToolBridge('deepseek-ch')).toBe(true)
    expect(channelSupportsRoomToolBridge('kimi-ch')).toBe(true)
    expect(channelSupportsRoomToolBridge('zhipu-coding-ch')).toBe(true)
    expect(channelSupportsRoomToolBridge('qwen-anthropic-ch')).toBe(true)
    // OpenAI-completions / google / custom：无原生工具桥 → fail closed，保持纯文本
    expect(channelSupportsRoomToolBridge('openai-ch')).toBe(false)
    expect(channelSupportsRoomToolBridge('zhipu-ch')).toBe(false)
    expect(channelSupportsRoomToolBridge('doubao-ch')).toBe(false)
    expect(channelSupportsRoomToolBridge('qwen-ch')).toBe(false)
    expect(channelSupportsRoomToolBridge('custom-ch')).toBe(false)
    expect(channelSupportsRoomToolBridge('google-ch')).toBe(false)
    // 未绑定 / 不存在的渠道 → false
    expect(channelSupportsRoomToolBridge()).toBe(false)
    expect(channelSupportsRoomToolBridge('nope')).toBe(false)
  })
})

function cliInput(over: Partial<MemberTurnInput> = {}): MemberTurnInput {
  return {
    roomId: 'cr_cli',
    memberId: 'cm_cli',
    runId: 'run_cli',
    triggerMessageId: 'msg_cli',
    logicalSessionId: 'room-member-session',
    cliWorkerId: 'worker-test',
    backend: 'cli',
    permissionProfile: 'workspace-write',
    workspaceRoot: 'C:\\room-workspace',
    systemPrompt: '你是代码成员',
    prompt: '检查项目',
    signal: new AbortController().signal,
    ...over,
  }
}

describe('removed native room backends', () => {
  test.each(['cli', 'codex'] as const)('rejects %s before invoking a native runtime', async backend => {
    await expect(new ChannelBackendAdapter().runTurn(cliInput({ backend }))).rejects.toMatchObject({ code: 'PI_HTTP_ONLY' })
    expect(cliState.lastInput).toBeNull()
    expect(codexState.lastInput).toBeNull()
  })
})

describe('ChannelBackendAdapter.runTurn', () => {
  test('external 渠道：透传 systemPrompt/prompt/modelId/signal 给 seat runner，返回正文', async () => {
    channelState.channels = [
      fakeChannel({
        id: 'ch1',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        models: [fakeModel('claude-x')],
        defaultModelId: 'claude-x',
      }),
    ]
    channelState.decrypted = { ch1: 'sk-1' }
    const controller = new AbortController()

    const adapter = new ChannelBackendAdapter()
    const result = await adapter.runTurn({
      roomId: 'cr_1',
      memberId: 'cm_1',
      runId: 'run_1',
      triggerMessageId: 'msg_1',
      channelId: 'ch1',
      systemPrompt: '你是协调者',
      prompt: '你好',
      signal: controller.signal,
    })

    expect(result.text).toBe('seat-reply')
    expect(seatState.lastFactoryOpts).toMatchObject({ provider: 'anthropic', apiKey: 'sk-1', baseUrl: 'https://api.anthropic.com' })
    expect(seatState.lastRunArgs).toMatchObject({ modelId: 'claude-x', prompt: '你好', systemPrompt: '你是协调者' })
    expect(seatState.lastRunArgs?.signal).toBe(controller.signal)
  })

  test('capabilities：S2 全 false（无 resume/工具/实时输入）', () => {
    const caps = new ChannelBackendAdapter().capabilities()
    expect(caps).toEqual({
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    })
  })
})

describe('ChannelBackendAdapter.runTurn — lifecycle interrupt 取消 inflight turn（P1-2b）', () => {
  test('未注入 lifecycle 时透传原 signal（既有行为不变）', async () => {
    channelState.channels = [
      fakeChannel({
        id: 'ch1',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        models: [fakeModel('claude-x')],
        defaultModelId: 'claude-x',
      }),
    ]
    channelState.decrypted = { ch1: 'sk-1' }
    const controller = new AbortController()

    const adapter = new ChannelBackendAdapter() // 未注入 lifecycle
    const result = await adapter.runTurn({
      roomId: 'cr_1',
      memberId: 'cm_1',
      runId: 'run_1',
      triggerMessageId: 'msg_1',
      logicalSessionId: 'ls_1',
      channelId: 'ch1',
      systemPrompt: '你是协调者',
      prompt: '你好',
      signal: controller.signal,
    })
    expect(result.text).toBe('seat-reply')
    // 未注入 lifecycle → 透传原 signal 引用，与既有测试一致
    expect(seatState.lastRunArgs?.signal).toBe(controller.signal)
  })

  test('注入 lifecycle + interruptSession → 组合 signal abort，取消进行中 turn + heartbeat false', async () => {
    channelState.channels = [
      fakeChannel({ id: 'ext-ch', provider: 'anthropic', models: [fakeModel('claude-x')] }),
    ]
    channelState.decrypted = { 'ext-ch': 'k' }
    seatState.hang = true // runSeat 挂起直到 signal abort

    const lifecycle = new ChannelMemberSessionLifecycleAdapter()
    const adapter = new ChannelBackendAdapter(lifecycle)
    const handle = await lifecycle.createSession({
      roomId: 'cr_1',
      memberId: 'cm_1',
      logicalSessionId: 'ls_1',
      channelId: 'ext-ch',
    })

    const caller = new AbortController()
    const turnPromise = adapter.runTurn({
      roomId: 'cr_1',
      memberId: 'cm_1',
      runId: 'run_1',
      triggerMessageId: 'msg_1',
      logicalSessionId: handle.logicalSessionId,
      channelId: 'ext-ch',
      systemPrompt: '你是成员',
      prompt: '请写一篇很长的文章',
      signal: caller.signal,
    })

    // bindTurnAbort 在 runTurn 首个 await 前同步执行；让出一个微任务确保已登记。
    await Promise.resolve()
    await lifecycle.interruptSession({ handle, reason: 'user-cancel' })

    // 组合 signal 随之 abort → 挂起的 runSeat 以 abort 结束 → runTurn reject
    await expect(turnPromise).rejects.toThrow('aborted')
    const beat = await lifecycle.heartbeat(handle)
    expect(beat.alive).toBe(false)
    expect(beat.detail).toBe('interrupted')
  })

  test('注入 lifecycle 但不 interrupt 时正常完成，heartbeat alive', async () => {
    channelState.channels = [
      fakeChannel({ id: 'ext-ch', provider: 'anthropic', models: [fakeModel('claude-x')] }),
    ]
    channelState.decrypted = { 'ext-ch': 'k' }
    seatState.hang = false

    const lifecycle = new ChannelMemberSessionLifecycleAdapter()
    const adapter = new ChannelBackendAdapter(lifecycle)
    const handle = await lifecycle.createSession({
      roomId: 'cr_1',
      memberId: 'cm_1',
      logicalSessionId: 'ls_1',
      channelId: 'ext-ch',
    })

    const caller = new AbortController()
    const result = await adapter.runTurn({
      roomId: 'cr_1',
      memberId: 'cm_1',
      runId: 'run_1',
      triggerMessageId: 'msg_1',
      logicalSessionId: handle.logicalSessionId,
      channelId: 'ext-ch',
      systemPrompt: '你是成员',
      prompt: '一句话',
      signal: caller.signal,
    })
    expect(result.text).toBe('seat-reply')
    // 注入 lifecycle → runTurn 收到的是组合 signal（非 caller.signal 原引用）
    expect(seatState.lastRunArgs?.signal).not.toBe(caller.signal)
    expect(seatState.lastRunArgs?.signal?.aborted).toBe(false)
    const beat = await lifecycle.heartbeat(handle)
    expect(beat.alive).toBe(true)
  })
})
