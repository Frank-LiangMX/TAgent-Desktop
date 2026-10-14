/**
 * ADR-0011 §5 首期手动切换运行内核 —— 纯逻辑单测。
 *
 * 覆盖：
 * - 后端校验（渠道/模型/内核兼容/MoA 虚拟模型/本机运行时不可用/草稿会话）
 * - 静默（quiescence）拒绝：running / stopping / send 在途 / 审批在途
 * - 校验失败不改绑定（meta 原样）
 * - 切换计划：跨内核归档原生绑定 + 清空生效原生 id + 生成待投递交接资料 + revision+1
 * - 不静默改权限/执行形态/工作区
 * - Claude Code → Codex → Pi 的交接资料内容与一次性投递 / 重启语义
 */
import { describe, expect, it } from 'vitest'
import type { AgentSessionMeta, Channel, RuntimeHandoff } from '@tagent/shared'

import {
  activeNativeSessionId,
  adapterKindForRuntime,
  applyRuntimeHandoffToPrompt,
  buildRuntimeHandoffContent,
  channelAcceptsRuntime,
  createKeyedSerialQueue,
  extractRuntimeHandoffMaterial,
  hasPendingHandoff,
  inferRuntimeFromMeta,
  internalBackendForRuntime,
  planHandoffAttempt,
  planHandoffAttemptOutcome,
  planHandoffDelivery,
  planRuntimeSwitch,
  resolveBoundRuntime,
  shouldInjectHandoff,
  validateRuntimeSwitchQuiescence,
  validateRuntimeSwitchTarget,
  type RuntimeSwitchValidation,
} from './runtime-switch'

/** 最小渠道工厂（只填校验关心的字段）。 */
function makeChannel(
  id: string,
  provider: string,
  opts: { enabled?: boolean; apiProtocol?: Channel['apiProtocol']; models?: Array<{ id: string; enabled?: boolean }> } = {},
): Channel {
  return {
    id,
    name: `channel-${id}`,
    provider,
    apiProtocol: opts.apiProtocol,
    baseUrl: 'https://example.invalid',
    apiKey: '',
    enabled: opts.enabled ?? true,
    models: (opts.models ?? [{ id: 'm1', enabled: true }]).map((m) => ({
      id: m.id,
      name: m.id,
      enabled: m.enabled ?? true,
    })),
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Channel
}

function makeMeta(patch: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 's1',
    title: '会话',
    channelId: 'cc-1',
    modelId: 'cc-default',
    agentRuntime: 'claude-code',
    internalBackend: 'claude-code',
    sdkSessionId: 'sdk-native-1',
    workspaceId: 'ws-1',
    executionMode: 'work',
    permissionMode: 'bypassPermissions',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

/** 渠道 provider 查询器（模拟 session-service 的 getChannel）。 */
const providerOf = (channels: Channel[]) => (channelId: string) =>
  channels.find((c) => c.id === channelId)?.provider

function expectOk(v: RuntimeSwitchValidation): Extract<RuntimeSwitchValidation, { ok: true }> {
  if (!v.ok) throw new Error(`预期校验通过，实际被拒：${v.code} ${v.message}`)
  return v
}

describe('运行内核 ↔ 渠道/provider 映射', () => {
  it('explicit engines accept only protocol-compatible API channels and preserve legacy native channels', () => {
    expect(adapterKindForRuntime('pi')).toBe('external')
    expect(internalBackendForRuntime('pi')).toBeUndefined()
    for (const runtime of ['pi', 'codex', 'claude-code'] as const) {
      expect(channelAcceptsRuntime({ provider: 'custom', enabled: true }, runtime)).toBe(true)
      expect(channelAcceptsRuntime({ provider: 'kscc-internal', enabled: true }, runtime)).toBe(false)
      expect(channelAcceptsRuntime({ provider: 'codex-internal', enabled: true }, runtime)).toBe(runtime === 'codex')
    }
  })

  it('从 meta 反推当前绑定内核', () => {
    const channels = [
      makeChannel('legacy-kscc', 'kscc-internal'),
      makeChannel('codex-1', 'codex-internal'),
      makeChannel('api-1', 'custom'),
    ]
    const byProvider = providerOf(channels)
    // 历史本机 kscc 渠道已不可运行 → 无法反推内核
    expect(
      resolveBoundRuntime(
        makeMeta({ channelId: 'legacy-kscc', agentRuntime: undefined, internalBackend: undefined, sdkSessionId: undefined }),
        byProvider,
      ),
    ).toBeUndefined()
    expect(
      resolveBoundRuntime(
        makeMeta({ channelId: 'legacy-kscc', agentRuntime: undefined, internalBackend: 'codex-app-server' }),
        byProvider,
      ),
    ).toBe('codex')
    expect(
      resolveBoundRuntime(makeMeta({ channelId: 'codex-1', agentRuntime: undefined, internalBackend: 'codex-app-server' }), byProvider),
    ).toBe('codex')
    expect(
      resolveBoundRuntime(makeMeta({ channelId: 'api-1', agentRuntime: undefined, internalBackend: undefined }), byProvider),
    ).toBe('pi')
    expect(resolveBoundRuntime(makeMeta({ channelId: 'api-1', agentRuntime: 'claude-code' }), byProvider)).toBe('claude-code')
    // 渠道已删 → 无法判断
    expect(resolveBoundRuntime(makeMeta({ channelId: 'gone', agentRuntime: undefined }), byProvider)).toBeUndefined()
    // 无渠道 → 无法判断
    expect(resolveBoundRuntime(makeMeta({ channelId: undefined, agentRuntime: undefined }), byProvider)).toBeUndefined()

    expect(inferRuntimeFromMeta({ internalBackend: undefined, codexThreadId: 't1' })).toBe('codex')
    expect(inferRuntimeFromMeta({ internalBackend: 'claude-code' })).toBe('claude-code')
    // 仅有 sdkSessionId / 无任何线索 → 不可归一（历史 kscc 通路已移除）
    expect(inferRuntimeFromMeta({ internalBackend: undefined, sdkSessionId: 's1' })).toBeUndefined()
    expect(inferRuntimeFromMeta({ internalBackend: undefined })).toBeUndefined()
  })
})

describe('切换目标后端校验', () => {
  const channels = [
    makeChannel('cc-1', 'custom', { apiProtocol: 'anthropic-messages', models: [{ id: 'cc-default' }] }),
    makeChannel('codex-1', 'codex-internal', { models: [{ id: 'gpt-5' }] }),
    makeChannel('api-1', 'custom', { models: [{ id: 'grok-4', enabled: true }, { id: 'old', enabled: false }] }),
    makeChannel('api-off', 'custom', { enabled: false }),
  ]
  const ctx = (channelId: string, meta: AgentSessionMeta | undefined = makeMeta()) => ({
    meta,
    channel: channels.find((c) => c.id === channelId),
    fromRuntime: resolveBoundRuntime(meta, providerOf(channels)),
  })

  it('草稿会话（未持久化）拒绝，走本地选择', () => {
    const v = validateRuntimeSwitchTarget(
      { channelId: 'api-1', modelId: 'grok-4', runtime: 'pi' },
      { meta: undefined, channel: channels[2] },
    )
    expect(v.ok).toBe(false)
    expect(!v.ok && v.code).toBe('session_not_persisted')
  })

  it('MoA 虚拟模型拒绝', () => {
    const v = validateRuntimeSwitchTarget(
      { channelId: 'api-1', modelId: 'moa:preset-1', runtime: 'pi' },
      ctx('api-1'),
    )
    expect(!v.ok && v.code).toBe('moa_model_unsupported')
  })

  it('未知内核 / 缺渠道或模型拒绝（防 renderer 传脏值）', () => {
    const unknown = validateRuntimeSwitchTarget(
      { channelId: 'api-1', modelId: 'grok-4', runtime: 'gpt' as never },
      ctx('api-1'),
    )
    expect(!unknown.ok && unknown.code).toBe('invalid_input')
    const empty = validateRuntimeSwitchTarget(
      { channelId: '', modelId: '', runtime: 'pi' },
      ctx('api-1'),
    )
    expect(!empty.ok && empty.code).toBe('invalid_input')
  })

  it('渠道不存在 / 已禁用拒绝', () => {
    expect(
      !validateRuntimeSwitchTarget({ channelId: 'nope', modelId: 'm', runtime: 'pi' }, ctx('nope')).ok,
    ).toBe(true)
    const disabled = validateRuntimeSwitchTarget(
      { channelId: 'api-off', modelId: 'm1', runtime: 'pi' },
      ctx('api-off'),
    )
    expect(!disabled.ok && disabled.code).toBe('channel_disabled')
  })

  it('内核与渠道不匹配拒绝（Codex 本机渠道仅供 Codex 内核）', () => {
    for (const runtime of ['pi', 'claude-code'] as const) {
      const rejected = validateRuntimeSwitchTarget({ channelId: 'codex-1', modelId: 'gpt-5', runtime }, ctx('codex-1'))
      expect(rejected.ok).toBe(false)
    }
    expect(validateRuntimeSwitchTarget({ channelId: 'codex-1', modelId: 'gpt-5', runtime: 'codex' }, ctx('codex-1')).ok).toBe(true)
  })

  it('本机运行时不可用 → 拒绝且带具体原因（不静默换内核）', () => {
    const v = validateRuntimeSwitchTarget({ channelId: 'api-1', modelId: 'grok-4', runtime: 'pi' },
      { ...ctx('api-1'), runtimeAvailable: false, runtimeUnavailableReason: '不可用' })
    expect(!v.ok && v.code).toBe('runtime_unavailable')
    expect(!v.ok && v.message).toContain('不可用')
  })

  it('模型不存在 / 已停用拒绝', () => {
    const missing = validateRuntimeSwitchTarget(
      { channelId: 'api-1', modelId: 'ghost', runtime: 'pi' },
      ctx('api-1'),
    )
    expect(!missing.ok && missing.code).toBe('model_not_found')
    const disabledModel = validateRuntimeSwitchTarget(
      { channelId: 'api-1', modelId: 'old', runtime: 'pi' },
      ctx('api-1'),
    )
    expect(!disabledModel.ok && disabledModel.code).toBe('model_disabled')
  })

  it('合法目标通过：跨内核标记 + 适配器/后端派生', () => {
    const ok = expectOk(validateRuntimeSwitchTarget({ channelId: 'api-1', modelId: 'grok-4', runtime: 'pi' }, ctx('api-1')))
    expect(ok.adapterKind).toBe('external')
    expect(ok.internalBackend).toBeUndefined()
    expect(ok.crossRuntime).toBe(true)
    expect(ok.fromRuntime).toBe('claude-code')
  })

  it('同内核且同渠道同模型可继续原生上下文', () => {
    const ok = expectOk(validateRuntimeSwitchTarget({ channelId: 'api-1', modelId: 'grok-4', runtime: 'pi' },
      ctx('api-1', makeMeta({ channelId: 'api-1', modelId: 'grok-4', agentRuntime: 'pi', internalBackend: undefined }))))
    expect(ok.crossRuntime).toBe(false)
  })

  it('同内核换模型也重新绑定，禁止把旧原生 ID resume 到新模型配置', () => {
    const meta = makeMeta({ channelId: 'api-1', modelId: 'old', agentRuntime: 'pi', internalBackend: undefined })
    const ok = expectOk(validateRuntimeSwitchTarget({ channelId: 'api-1', modelId: 'grok-4', runtime: 'pi' }, ctx('api-1', meta)))
    expect(ok.crossRuntime).toBe(true)
    const { patch } = planRuntimeSwitch({ meta, target: ok, channelId: 'api-1', modelId: 'grok-4', now: 1, handoffContent: '模型已更换，请继续。' })
    expect(patch.sdkSessionId).toBeUndefined()
    expect(patch.runtimeHandoff?.to).toBe('pi')
  })
})

describe('静默（quiescence）判定', () => {
  const quiet = {
    turnInFlight: false,
    interrupting: false,
    unsettledStop: false,
    sendInFlight: false,
    approvalActive: false,
  }

  it('静默时通过', () => {
    expect(validateRuntimeSwitchQuiescence(quiet).ok).toBe(true)
  })
  it('本轮在跑 / 停止中 / send 在途 / 审批在途一律拒绝', () => {
    const cases: Array<[Partial<typeof quiet>, string]> = [
      [{ turnInFlight: true }, 'busy'],
      [{ interrupting: true }, 'stopping'],
      [{ unsettledStop: true }, 'stopping'],
      [{ sendInFlight: true }, 'send_in_flight'],
      [{ approvalActive: true }, 'approval_active'],
    ]
    for (const [patch, code] of cases) {
      const v = validateRuntimeSwitchQuiescence({ ...quiet, ...patch })
      expect(v.ok).toBe(false)
      expect(!v.ok && v.code).toBe(code)
    }
  })

  it('停止已受理但原生终态未观察 → 仍拒绝（stop ack ≠ 静默）', () => {
    // 关键回归：turnInFlight=false 且 interrupting=false（适配器已受理中断、宿主标志已翻转），
    // 但 unsettledStop=true（旧内核工具可能仍在写同一 workspace）→ 必须 fail-closed
    const v = validateRuntimeSwitchQuiescence({
      ...quiet,
      turnInFlight: false,
      interrupting: false,
      unsettledStop: true,
    })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.code).toBe('stopping')
  })
})

describe('切换计划与绑定归档', () => {
  it('跨内核：归档旧原生绑定、清空生效原生 id、写待投递交接、revision+1', () => {
    const meta = makeMeta({
      runtimeSwitchRevision: 2,
      runtimeBindings: { 'claude-code': { channelId: 'cc-1', modelId: 'cc-default', lastSyncedAt: 1 } },
    })
    const target = expectOk(
      validateRuntimeSwitchTarget(
        { channelId: 'codex-1', modelId: 'gpt-5', runtime: 'pi' },
        { meta, channel: makeChannel('codex-1', 'custom', { models: [{ id: 'gpt-5' }] }), fromRuntime: 'claude-code' },
      ),
    )
    const { patch, handoff } = planRuntimeSwitch({
      meta,
      target,
      channelId: 'codex-1',
      modelId: 'gpt-5',
      now: 1_700_000_000_000,
      handoffContent: '交接正文',
      sourcePanelMessageCount: 7,
    })

    expect(patch.channelId).toBe('codex-1')
    expect(patch.modelId).toBe('gpt-5')
    expect(patch.internalBackend).toBeUndefined()
    expect(patch.runtimeSwitchRevision).toBe(3)
    // 生效原生 id 清空（避免 resume 过期上下文），旧值归档
    expect(patch.sdkSessionId).toBeUndefined()
    expect(patch.codexThreadId).toBeUndefined()
    expect(patch.runtimeBindings?.['claude-code']?.nativeSessionId).toBe('sdk-native-1')
    expect(patch.runtimeBindings?.['claude-code']?.channelId).toBe('cc-1')
    expect(handoff?.from).toBe('claude-code')
    expect(handoff?.to).toBe('pi')
    expect(handoff?.sourcePanelMessageCount).toBe(7)
    // 不静默改权限 / 执行形态 / 工作区
    expect('executionMode' in patch).toBe(false)
    expect('permissionMode' in patch).toBe(false)
    expect('workspaceId' in patch).toBe(false)
  })

  it('同内核：保留生效原生 id，不生成交接资料', () => {
    const meta = makeMeta({
      channelId: 'codex-1',
      modelId: 'gpt-5',
      agentRuntime: 'pi',
      internalBackend: undefined,
      codexThreadId: 'thread-1',
      sdkSessionId: undefined,
    })
    const target = expectOk(
      validateRuntimeSwitchTarget(
        { channelId: 'codex-1', modelId: 'gpt-5', runtime: 'pi' },
        { meta, channel: makeChannel('codex-1', 'custom', { models: [{ id: 'gpt-5' }] }), fromRuntime: 'pi' },
      ),
    )
    const { patch, handoff } = planRuntimeSwitch({
      meta,
      target,
      channelId: 'codex-1',
      modelId: 'gpt-5',
      now: 1,
      handoffContent: '不应写入',
      sourcePanelMessageCount: 3,
    })
    expect(handoff).toBeUndefined()
    expect(patch.runtimeHandoff).toBeUndefined()
    expect('codexThreadId' in patch).toBe(false)
    expect(patch.runtimeBindings?.pi?.nativeSessionId).toBeUndefined()
  })

  it('无可见历史时跨内核不写空交接记录', () => {
    const meta = makeMeta({ sdkSessionId: undefined })
    const target = expectOk(
      validateRuntimeSwitchTarget(
        { channelId: 'api-1', modelId: 'grok-4', runtime: 'pi' },
        { meta, channel: makeChannel('api-1', 'custom', { models: [{ id: 'grok-4' }] }), fromRuntime: 'claude-code' },
      ),
    )
    const { patch, handoff } = planRuntimeSwitch({
      meta,
      target,
      channelId: 'api-1',
      modelId: 'grok-4',
      now: 1,
      handoffContent: '   ',
      sourcePanelMessageCount: 0,
    })
    expect(handoff).toBeUndefined()
    expect(patch.runtimeHandoff).toBeUndefined()
    // 但目标内核仍全新开原生上下文
    expect(patch.sdkSessionId).toBeUndefined()
    expect(patch.codexThreadId).toBeUndefined()
  })
})

describe('校验失败的绑定保持', () => {
  /** 模拟 session-service 事务：校验通过才落盘 patch。 */
  function runSwitch(
    meta: AgentSessionMeta,
    channel: Channel | undefined,
    input: { channelId: string; modelId: string; runtime: 'pi' | 'codex' | 'claude-code' },
    fromRuntime?: 'pi' | 'codex' | 'claude-code',
  ): { meta: AgentSessionMeta; rejected?: string } {
    const v = validateRuntimeSwitchTarget(input, { meta, channel, fromRuntime })
    if (!v.ok) return { meta, rejected: v.code }
    const { patch } = planRuntimeSwitch({ ...input, meta, target: v, now: 1, handoffContent: 'x' })
    return { meta: { ...meta, ...patch } as AgentSessionMeta }
  }

  it('渠道不匹配时原绑定一字未改', () => {
    const meta = makeMeta()
    const before = JSON.stringify(meta)
    // codex-internal 渠道不接受 pi 内核 → mismatch，绑定保持
    const r = runSwitch(meta, makeChannel('codex-1', 'codex-internal', { models: [{ id: 'gpt-5' }] }), {
      channelId: 'codex-1',
      modelId: 'gpt-5',
      runtime: 'pi',
    })
    expect(r.rejected).toBe('channel_runtime_mismatch')
    expect(JSON.stringify(r.meta)).toBe(before)
    expect(r.meta.channelId).toBe('cc-1')
    expect(r.meta.sdkSessionId).toBe('sdk-native-1')
  })

  it('模型已停用时同理（不降级到渠道默认模型）', () => {
    const meta = makeMeta()
    const r = runSwitch(meta, makeChannel('api-1', 'custom', { models: [{ id: 'old', enabled: false }] }), {
      channelId: 'api-1',
      modelId: 'old',
      runtime: 'pi',
    })
    expect(r.rejected).toBe('model_disabled')
    expect(r.meta.modelId).toBe('cc-default')
  })
})

// ===== 交接资料 =====

const ccUser = (text: string) => ({
  type: 'user',
  uuid: `u-${text}`,
  createdAt: 1,
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const ccAssistant = (text: string) => ({
  type: 'assistant',
  uuid: `a-${text}`,
  createdAt: 2,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
const piAssistantWithThinking = (visible: string, hidden: string) => ({
  type: 'assistant',
  uuid: `a-${visible}`,
  createdAt: 3,
  content: [
    { type: 'thinking', thinking: hidden },
    { type: 'text', text: visible },
  ],
})

describe('交接资料生成与投递', () => {
  const panel = [
    ccUser('帮我把报表脚本改成增量跑'),
    ccAssistant('已完成第一版，脚本在 scripts/report.ts'),
    ccUser('再加一个 --since 参数'),
    piAssistantWithThinking('已加好 --since', '这里是不能外泄的隐藏推理'),
  ]

  it('只带可见内容，不含隐藏思考；含目标/最新要求/约束', () => {
    const material = extractRuntimeHandoffMaterial(panel)
    expect(material.historyText).toContain('[用户] 帮我把报表脚本改成增量跑')
    expect(material.historyText).toContain('[助手] 已加好 --since')
    expect(material.historyText).not.toContain('隐藏推理')
    expect(material.initialGoal).toContain('增量跑')
    expect(material.latestAsk).toContain('--since')
    expect(material.sourcePanelMessageCount).toBe(4)

    const content = buildRuntimeHandoffContent({
      from: 'claude-code',
      to: 'codex',
      material,
      constraints: {
        executionMode: 'work',
        permissionMode: 'bypassPermissions',
        workspacePath: 'F:/proj',
        attachedFiles: ['F:/proj/spec.md'],
      },
    })
    expect(content).toContain('来自 Claude Code')
    expect(content).toContain('Work（可动手执行）')
    expect(content).toContain('F:/proj')
    expect(content).toContain('F:/proj/spec.md')
    expect(content).toContain('不会放宽权限')
    expect(content).not.toContain('这里是不能外泄的隐藏推理')
    // 声明省略范围 + 预算上限（不谎称完整上下文迁移）
    expect(content).toContain('12000 字符预算')
    expect(content).toContain('不等同于完整上下文迁移')
    expect(content).toContain('中段的约束细节')
  })

  it('超预算时截断', () => {
    const long = 'x'.repeat(40_000)
    const content = buildRuntimeHandoffContent({
      from: 'claude-code',
      to: 'codex',
      material: { historyText: long, initialGoal: '', latestAsk: '', sourcePanelMessageCount: 1 },
      constraints: {},
    })
    expect(content.length).toBeLessThan(40_000)
    expect(content).toContain('超预算已截断')
  })

  it('一次性投递：无 pending 不注入；投递成功后清除且不再重复注入', () => {
    const handoff: RuntimeHandoff = {
      from: 'claude-code',
      to: 'codex',
      content: '交接正文',
      createdAt: 1,
      sourcePanelMessageCount: 4,
    }
    // 无 pending
    expect(applyRuntimeHandoffToPrompt('本轮问题', undefined)).toBeUndefined()

    const injected = applyRuntimeHandoffToPrompt('本轮问题', handoff)
    expect(injected).toContain('交接正文')
    expect(injected).toContain('本轮问题')

    // 投递成功后消费
    const meta = makeMeta({ channelId: 'codex-1', agentRuntime: 'codex', internalBackend: 'codex-app-server', runtimeHandoff: handoff, codexThreadId: undefined, sdkSessionId: undefined })
    expect(hasPendingHandoff(meta)).toBe(true)
    const patch = planHandoffDelivery({
      meta,
      runtime: 'codex',
      now: 42,
      panelMessageCount: 5,
      nativeSessionId: 'thread-9',
    })
    expect(patch.runtimeHandoff).toBeUndefined()
    expect(patch.runtimeBindings?.codex?.syncedPanelMessageCount).toBe(5)
    expect(patch.runtimeBindings?.codex?.nativeSessionId).toBe('thread-9')

    const after = { ...meta, ...patch } as AgentSessionMeta
    expect(hasPendingHandoff(after)).toBe(false)
    // 下一轮不再注入
    expect(applyRuntimeHandoffToPrompt('第二轮问题', after.runtimeHandoff)).toBeUndefined()
  })

  it('重启语义：落盘的 pending 交接在重开后仍待投递，消费后消失', () => {
    // 模拟落盘 → 重启（只有 JSON 能承载的字段）
    const persisted = JSON.parse(
      JSON.stringify(
        makeMeta({
          channelId: 'codex-1',
          agentRuntime: 'codex',
          internalBackend: 'codex-app-server',
          sdkSessionId: undefined,
          runtimeHandoff: {
            from: 'claude-code',
            to: 'codex',
            content: '重启后仍要带的上下文',
            createdAt: 7,
            sourcePanelMessageCount: 4,
          },
        }),
      ),
    ) as AgentSessionMeta
    expect(hasPendingHandoff(persisted)).toBe(true)
    expect(applyRuntimeHandoffToPrompt('问题', persisted.runtimeHandoff)).toContain('重启后仍要带的上下文')

    const consumed = { ...persisted, ...planHandoffDelivery({ meta: persisted, runtime: 'codex', now: 8, panelMessageCount: 5 }) } as AgentSessionMeta
    const reloaded = JSON.parse(JSON.stringify(consumed)) as AgentSessionMeta
    expect(hasPendingHandoff(reloaded)).toBe(false)
  })

  it('Claude Code → Codex → Pi：切回 Pi 时生效原生 id 为空（全新开），旧 id 留在绑定集合', () => {
    const meta = makeMeta({ channelId: 'old-codex', agentRuntime: 'codex', internalBackend: 'codex-app-server', codexThreadId: 'thread-1', sdkSessionId: undefined })
    const channel = makeChannel('api-1', 'custom', { models: [{ id: 'grok-4' }] })
    const target = expectOk(validateRuntimeSwitchTarget({ channelId: 'api-1', modelId: 'grok-4', runtime: 'pi' }, { meta, channel, fromRuntime: 'codex' }))
    const { patch } = planRuntimeSwitch({ meta, target, channelId: 'api-1', modelId: 'grok-4', now: 20, handoffContent: 'h' })
    expect(patch.runtimeBindings?.codex?.nativeSessionId).toBe('thread-1')
    expect(patch.codexThreadId).toBeUndefined()
    expect(patch.sdkSessionId).toBeUndefined()
    expect(patch.internalBackend).toBeUndefined()
    expect(patch.agentRuntime).toBe('pi')
  })
})

// ===== 并发/竞态：切换事务串行化 + 与发送互斥 =====

describe('切换事务串行化与发送互斥', () => {
  it('同一会话的两次切换串行执行，不并发写绑定', async () => {
    const queue = createKeyedSerialQueue()
    const order: string[] = []
    let running = 0
    let maxConcurrent = 0

    const task = (tag: string) => async () => {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      order.push(`begin:${tag}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end:${tag}`)
      running -= 1
      return tag
    }

    const [a, b] = await Promise.all([
      queue.run('s1', task('A')),
      queue.run('s1', task('B')),
    ])
    expect([a, b]).toEqual(['A', 'B'])
    expect(maxConcurrent).toBe(1)
    expect(order).toEqual(['begin:A', 'end:A', 'begin:B', 'end:B'])
    expect(queue.pendingKeys()).toBe(0)
  })

  it('不同会话的切换互不阻塞', async () => {
    const queue = createKeyedSerialQueue()
    let running = 0
    let maxConcurrent = 0
    const task = async () => {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
    }
    await Promise.all([queue.run('s1', task), queue.run('s2', task)])
    expect(maxConcurrent).toBe(2)
  })

  it('前一个切换抛错不吞掉后一个（失败后仍可再次切换）', async () => {
    const queue = createKeyedSerialQueue()
    await expect(
      queue.run('s1', () => {
        throw new Error('校验失败')
      }),
    ).rejects.toThrow('校验失败')
    await expect(queue.run('s1', () => 'ok')).resolves.toBe('ok')
    expect(queue.pendingKeys()).toBe(0)
  })

  /**
   * 模拟 session-service 的互斥：切换事务在途 → 发送 fail-closed 拒绝；
   * 回合在跑 / 停止中 / send 未走完 → 切换 fail-closed 拒绝。
   */
  it('切换在途时发送被拒；回合在跑时切换被拒（不产生两个执行者）', async () => {
    const switchInFlight = new Set<string>()
    const pendingSend = new Map<string, number>()
    const runtime = { turnInFlight: false, interrupting: false, unsettledStop: false }

    const send = async (sessionId: string): Promise<string> => {
      if (switchInFlight.has(sessionId)) throw new Error('该会话正在切换运行内核，请稍候再发送')
      pendingSend.set(sessionId, (pendingSend.get(sessionId) ?? 0) + 1)
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'sent'
      } finally {
        pendingSend.delete(sessionId)
      }
    }

    const switchRuntime = async (sessionId: string): Promise<string> => {
      switchInFlight.add(sessionId)
      try {
        const q = validateRuntimeSwitchQuiescence({
          turnInFlight: runtime.turnInFlight,
          interrupting: runtime.interrupting,
          unsettledStop: runtime.unsettledStop,
          sendInFlight: (pendingSend.get(sessionId) ?? 0) > 0,
          approvalActive: false,
        })
        await new Promise((resolve) => setTimeout(resolve, 5))
        if (!q.ok) throw new Error(q.code)
        return 'switched'
      } finally {
        switchInFlight.delete(sessionId)
      }
    }

    // ① 切换在途 → 发送被拒
    const switching = switchRuntime('s1')
    await expect(send('s1')).rejects.toThrow('正在切换运行内核')
    await switching

    // ② send 未走完 → 切换被拒（send_in_flight）
    const sending = send('s1')
    await expect(switchRuntime('s1')).rejects.toThrow('send_in_flight')
    await sending

    // ③ 回合在跑 → 切换被拒（busy）
    runtime.turnInFlight = true
    await expect(switchRuntime('s1')).rejects.toThrow('busy')
    runtime.turnInFlight = false

    // ④ 静默 → 切换成功
    await expect(switchRuntime('s1')).resolves.toBe('switched')
  })
})

// ===== 交接尝试生命周期：一次性投递 / 失败保留 / 模糊标记 / revision 守卫 =====

describe('交接尝试生命周期（消费时机与重投规则）', () => {
  const baseHandoff = (patch: Partial<RuntimeHandoff> = {}): RuntimeHandoff => ({
    from: 'claude-code',
    to: 'codex',
    content: '交接正文',
    createdAt: 100,
    sourcePanelMessageCount: 4,
    ...patch,
  })

  function metaWith(patch: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
    return makeMeta({
      channelId: 'codex-1',
      agentRuntime: 'codex',
      internalBackend: 'codex-app-server',
      sdkSessionId: undefined,
      codexThreadId: 'thread-1',
      runtimeSwitchRevision: 1,
      runtimeHandoff: baseHandoff(),
      ...patch,
    })
  }

  it('首次注入才注入；注入后 attempts>0 不再自动重复（避免普通轮次重吃全量上下文）', () => {
    const fresh = metaWith()
    expect(shouldInjectHandoff(fresh)).toBe(true)

    const attemptPatch = planHandoffAttempt({ meta: { runtimeHandoff: fresh.runtimeHandoff }, now: 200 })
    expect(attemptPatch?.runtimeHandoff?.attempts).toBe(1)
    expect(attemptPatch?.runtimeHandoff?.lastOutcome).toBe('pending')

    const afterAttempt = { ...fresh, ...attemptPatch } as AgentSessionMeta
    expect(shouldInjectHandoff(afterAttempt)).toBe(false)
  })

  it('成功终态才消费：清 pending + 推进目标绑定同步游标', () => {
    const meta = metaWith({
      runtimeHandoff: baseHandoff({ attempts: 1, lastAttemptAt: 200, lastOutcome: 'pending' }),
    })
    const patch = planHandoffAttemptOutcome({
      meta,
      attemptRevision: 1,
      outcome: 'success',
      sawNativeOutput: true,
      now: 300,
      nativeSessionId: 'thread-1',
      syncedPanelMessageCount: 9,
    })
    expect(patch?.runtimeHandoff).toBeUndefined()
    expect(patch?.runtimeBindings?.codex?.syncedPanelMessageCount).toBe(9)
    expect(patch?.runtimeBindings?.codex?.nativeSessionId).toBe('thread-1')
    const after = { ...meta, ...patch } as AgentSessionMeta
    expect(hasPendingHandoff(after)).toBe(false)
    expect(shouldInjectHandoff(after)).toBe(false)
  })

  it('目标内核没产出任何原生输出就出错 → 保留 pending 但归零 attempts（用户下次发送可重投）', () => {
    const meta = metaWith({
      runtimeHandoff: baseHandoff({ attempts: 1, lastAttemptAt: 200, lastOutcome: 'pending' }),
    })
    const patch = planHandoffAttemptOutcome({
      meta,
      attemptRevision: 1,
      outcome: 'error',
      sawNativeOutput: false,
      now: 300,
    })
    expect(patch?.runtimeHandoff?.attempts).toBe(0)
    expect(patch?.runtimeHandoff?.lastOutcome).toBe('retryable')
    const after = { ...meta, ...patch } as AgentSessionMeta
    expect(hasPendingHandoff(after)).toBe(true)
    expect(shouldInjectHandoff(after)).toBe(true)
  })

  it('startup-failed（构建 query / spawn 抛错）同「从未送达」处理', () => {
    const meta = metaWith({
      runtimeHandoff: baseHandoff({ attempts: 1, lastOutcome: 'pending' }),
    })
    const patch = planHandoffAttemptOutcome({
      meta,
      attemptRevision: 1,
      outcome: 'startup-failed',
      sawNativeOutput: true, // 即使观察位被误置，startup-failed 一律按未送达
      now: 300,
    })
    expect(patch?.runtimeHandoff?.attempts).toBe(0)
    expect(patch?.runtimeHandoff?.lastOutcome).toBe('retryable')
  })

  it('已产出原生输出后出错/停止 → 标记 ambiguous，保留 attempts（不自动重投）', () => {
    for (const outcome of ['error', 'stopped'] as const) {
      const meta = metaWith({
        runtimeHandoff: baseHandoff({ attempts: 1, lastOutcome: 'pending' }),
      })
      const patch = planHandoffAttemptOutcome({
        meta,
        attemptRevision: 1,
        outcome,
        sawNativeOutput: true,
        now: 300,
      })
      expect(patch?.runtimeHandoff?.attempts).toBe(1)
      expect(patch?.runtimeHandoff?.lastOutcome).toBe('ambiguous')
      const after = { ...meta, ...patch } as AgentSessionMeta
      expect(hasPendingHandoff(after)).toBe(true) // 记录保留（不静默丢弃）
      expect(shouldInjectHandoff(after)).toBe(false) // 但不自动重投
    }
  })

  it('revision 守卫：期间又切换过 → 旧尝试不得动新交接', () => {
    const meta = metaWith({
      runtimeSwitchRevision: 2,
      runtimeHandoff: baseHandoff({ attempts: 1, lastOutcome: 'pending' }),
    })
    expect(
      planHandoffAttemptOutcome({
        meta,
        attemptRevision: 1,
        outcome: 'success',
        sawNativeOutput: true,
        now: 300,
      }),
    ).toBeUndefined()
    expect(
      planHandoffAttemptOutcome({
        meta,
        attemptRevision: 1,
        outcome: 'stopped',
        sawNativeOutput: false,
        now: 300,
      }),
    ).toBeUndefined()
  })

  it('无待投递记录时不产生任何 patch', () => {
    const meta = metaWith({ runtimeHandoff: undefined })
    expect(planHandoffAttempt({ meta: { runtimeHandoff: undefined }, now: 1 })).toBeUndefined()
    expect(
      planHandoffAttemptOutcome({
        meta,
        attemptRevision: 1,
        outcome: 'success',
        sawNativeOutput: true,
        now: 1,
      }),
    ).toBeUndefined()
  })

  it('重启语义：attempts=0 的 pending 记录重开后仍可投递', () => {
    const persisted = JSON.parse(
      JSON.stringify(metaWith({ runtimeHandoff: baseHandoff({ attempts: 0, lastOutcome: 'retryable' }) })),
    ) as AgentSessionMeta
    expect(shouldInjectHandoff(persisted)).toBe(true)
  })
})
