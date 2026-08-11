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
import type { Channel, ChannelModel } from '@tagent/shared'

// ===== mock 状态（vi.hoisted 保证 vi.mock 工厂能引用） =====
const channelState = vi.hoisted(() => ({
  channels: [] as Channel[],
  decrypted: {} as Record<string, string>,
}))
const ksccState = vi.hoisted(() => ({ path: '/fake/kscc' as string | undefined }))
const seatState = vi.hoisted(() => ({
  lastFactoryOpts: null as { provider?: string; apiKey?: string; baseUrl?: string } | null,
  lastKsccOpts: null as { ksccPath?: string } | null,
  lastRunArgs: null as {
    modelId?: string
    prompt?: string
    systemPrompt?: string
    signal?: AbortSignal
  } | null,
  returnText: 'seat-reply',
  throwErr: null as Error | null,
}))

vi.mock('../channel/channel-store', () => ({
  listChannels: () => channelState.channels,
  getChannel: (id: string) => channelState.channels.find((c) => c.id === id),
  getDecryptedApiKey: (id: string) => channelState.decrypted[id] ?? '',
}))

vi.mock('../adapters/claude/kscc-path', () => ({
  resolveKsccPath: () => ksccState.path,
}))

vi.mock('@tagent/pi-core', () => ({
  createPiHttpSeatRunner: (opts: { provider: string; apiKey: string; baseUrl?: string }) => {
    seatState.lastFactoryOpts = opts
    return {
      runSeat: async (args: { modelId: string; prompt: string; systemPrompt?: string; signal?: AbortSignal }) => {
        seatState.lastRunArgs = args
        if (seatState.throwErr) throw seatState.throwErr
        return seatState.returnText
      },
    }
  },
  createKsccSeatRunner: (opts: { ksccPath?: string }) => {
    seatState.lastKsccOpts = opts
    return {
      runSeat: async (args: { modelId: string; prompt: string; systemPrompt?: string; signal?: AbortSignal }) => {
        seatState.lastRunArgs = args
        if (seatState.throwErr) throw seatState.throwErr
        return seatState.returnText
      },
    }
  },
}))

import {
  resolveChannelBackendConfig,
  ChannelBackendAdapter,
  MemberBackendResolveError,
} from './member-backend-adapter'

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
  ksccState.path = '/fake/kscc'
  seatState.lastFactoryOpts = null
  seatState.lastKsccOpts = null
  seatState.lastRunArgs = null
  seatState.returnText = 'seat-reply'
  seatState.throwErr = null
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

  test('显式 kscc-internal channelId → kscc 配置（ksccPath，无 apiKey）', () => {
    channelState.channels = [fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm-5.2')] })]
    const cfg = resolveChannelBackendConfig({ channelId: 'kscc-internal' })
    expect(cfg.kind).toBe('kscc')
    expect(cfg.ksccPath).toBe('/fake/kscc')
    expect(cfg.apiKey).toBeUndefined()
    expect(cfg.modelId).toBe('glm-5.2')
  })

  test('kscc-internal 但未安装 kscc → NO_KSCC', () => {
    channelState.channels = [fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm-5.2')] })]
    ksccState.path = undefined
    expect(() => resolveChannelBackendConfig({ channelId: 'kscc-internal' })).toThrowError(
      /NO_KSCC|未检测到 kscc/,
    )
  })

  test('未绑定 channelId → 优先 enabled 且本机可用的 kscc', () => {
    channelState.channels = [
      fakeChannel({ id: 'disabled', provider: 'openai', enabled: false, models: [fakeModel('m')] }),
      fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm')] }),
      fakeChannel({ id: 'ext1', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', models: [fakeModel('deepseek-chat')] }),
    ]
    channelState.decrypted = { ext1: 'dk-key' }
    ksccState.path = '/fake/kscc'

    const cfg = resolveChannelBackendConfig({})
    expect(cfg.kind).toBe('kscc')
    expect(cfg.ksccPath).toBe('/fake/kscc')
    expect(cfg.modelId).toBe('glm')
  })

  test('未绑定 + kscc 不可用 → 回落第一个 enabled 外部渠道', () => {
    channelState.channels = [
      fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm')] }),
      fakeChannel({ id: 'ext1', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', models: [fakeModel('deepseek-chat')] }),
    ]
    channelState.decrypted = { ext1: 'dk-key' }
    ksccState.path = undefined

    const cfg = resolveChannelBackendConfig({})
    expect(cfg.kind).toBe('external')
    expect(cfg.provider).toBe('deepseek')
    expect(cfg.apiKey).toBe('dk-key')
  })

  test('未绑定 + 仅 kscc 且本机可用 → kscc（不必外部渠道）', () => {
    channelState.channels = [
      fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm-5.2')] }),
    ]
    ksccState.path = '/usr/bin/kscc'
    const cfg = resolveChannelBackendConfig({})
    expect(cfg.kind).toBe('kscc')
    expect(cfg.modelId).toBe('glm-5.2')
  })

  test('未绑定 + 无任何可用渠道 → NO_CHANNEL_BACKEND', () => {
    channelState.channels = [
      fakeChannel({ id: 'kscc-internal', provider: 'kscc-internal', models: [fakeModel('glm')] }),
      fakeChannel({ id: 'nokey', provider: 'openai', models: [fakeModel('m')] }),
    ]
    // kscc 未装 + 外部无 apiKey
    ksccState.path = undefined
    channelState.decrypted = {}
    expect(() => resolveChannelBackendConfig({})).toThrowError(
      /NO_CHANNEL_BACKEND|没有可用的渠道/,
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
