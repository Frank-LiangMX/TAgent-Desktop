/**
 * runMoADiscussion 单测：圆桌讨论多轮编排（主进程侧）。
 *
 * 用 mock seatRunner + mock session-store（落盘函数）验证：
 * - 校验失败（预置停用 / 参考不足 / 汇总未启用）→ error
 * - 正常两轮 + 收口：entries 顺序、panel phase 走到 done、final assistant 落盘事件、
 *   moderator 拿到全部讨论、流式正文 + result + turn_end
 * - 轮数上限触发 finalizing（roundLimit=1 仅跑 1 轮即收口）
 * - signal abort → cancelled（保留已发言记录）
 * - 全参与者失败 → error（本轮全员失败即早退）
 *
 * 风格参照同目录 moa-dispatch.test.ts / kscc-soft-reset.guards.test.ts（vitest + vi.mock）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Channel,
  MoAPreset,
  MoADiscussionPanel,
  TAgentDesktopStreamPayload,
} from '@tagent/shared'

// 落盘函数 mock：run-moa-discussion 透传 appendPanelMessages/appendSdkMessages，测试不触真磁盘
vi.mock('./session-store', () => ({
  appendPanelMessages: vi.fn(),
  appendSdkMessages: vi.fn(),
  readPanelMessages: vi.fn(() => []),
  // T8：终态 panel 落盘（moa-discussion.jsonl），mock 记录调用以断言终态触发
  appendMoADiscussionPanelRecord: vi.fn(),
}))

import { runMoADiscussion, type MoADiscussionContext } from './run-moa-discussion'
import {
  appendPanelMessages,
  appendSdkMessages,
  readPanelMessages,
  appendMoADiscussionPanelRecord,
} from './session-store'

// readPanelMessages 被 vi.mock 替换为 vi.fn；用 vi.mocked 取回带 mock API 的类型化引用（同 balance-service.test.ts）
const mockedReadPanelMessages = vi.mocked(readPanelMessages)

// ---- fixtures ----

function makeChannel(enabledModels: string[] = ['glm-5.2', 'kimi-k2.5', 'glm-5.1']): Channel {
  return {
    id: 'kscc-1',
    name: '内网',
    provider: 'kscc-internal',
    baseUrl: 'http://kscc.internal',
    apiKey: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    models: [
      { id: 'glm-5.2', name: 'GLM 5.2', enabled: enabledModels.includes('glm-5.2'), contextWindow: 128_000 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', enabled: enabledModels.includes('kimi-k2.5') },
      { id: 'glm-5.1', name: 'GLM 5.1', enabled: enabledModels.includes('glm-5.1') },
    ],
  } as unknown as Channel
}

function makePreset(opts: Partial<MoAPreset> = {}): MoAPreset {
  return {
    id: 'roundtable',
    name: '深度圆桌',
    enabled: true,
    references: [
      { name: '架构师', modelId: 'glm-5.2' },
      { name: '实战派', modelId: 'kimi-k2.5' },
    ],
    aggregatorModelId: 'glm-5.1',
    timeoutMsPerSeat: 120_000,
    ...opts,
  } as MoAPreset
}

/** 可控 mock seatRunner：按 handler 返回文本或抛错；记录每次调用 args；模拟流式推 delta。 */
function makeSeatRunner(
  handler: (args: { modelId: string; prompt: string; onTextDelta?: (t: string) => void }) => string,
): {
  runner: MoADiscussionContext['seatRunner']
  runSeat: ReturnType<typeof vi.fn>
  calls: { modelId: string; prompt: string }[]
} {
  const calls: { modelId: string; prompt: string }[] = []
  const runSeat = vi.fn(async (args: {
    modelId: string
    prompt: string
    onTextDelta?: (t: string) => void
  }) => {
    calls.push({ modelId: args.modelId, prompt: args.prompt })
    const res = handler(args)
    if (args.onTextDelta && res) args.onTextDelta(res)
    return res
  })
  return { runner: { runSeat } as unknown as MoADiscussionContext['seatRunner'], runSeat, calls }
}

interface CtxOpts {
  runner: MoADiscussionContext['seatRunner']
  preset?: MoAPreset
  channel?: Channel
  roundLimit?: number
  signal?: AbortSignal
  prompt?: string
  /** 用户插话通道（§5.3）；不传则无插话通道（drain 兜底空数组） */
  interjections?: MoADiscussionContext['interjections']
}

function makeCtx(opts: CtxOpts): {
  ctx: MoADiscussionContext
  payloads: TAgentDesktopStreamPayload[]
} {
  const payloads: TAgentDesktopStreamPayload[] = []
  const ctx: MoADiscussionContext = {
    sessionId: 'sess-1',
    prompt: opts.prompt ?? '如何拆分模块？请给方案',
    channel: opts.channel ?? makeChannel(),
    preset: opts.preset ?? makePreset(),
    seatRunner: opts.runner,
    signal: opts.signal ?? new AbortController().signal,
    sendPayload: (p) => {
      payloads.push(p)
    },
    ...(opts.roundLimit != null ? { roundLimit: opts.roundLimit } : {}),
    ...(opts.interjections ? { interjections: opts.interjections } : {}),
  }
  return { ctx, payloads }
}

/** 可控插话通道：pending 队列 + drain（splice 排空，与 session-service 注入的 drain 同形态）。 */
function makeInterjectionChannel(initial: string[] = []): {
  pending: string[]
  interjections: NonNullable<MoADiscussionContext['interjections']>
} {
  const pending = [...initial]
  return { pending, interjections: { drain: () => pending.splice(0) } }
}

// 从 payload 流里抽出讨论卡 panel 序列（按发送顺序）
function panelsOf(payloads: TAgentDesktopStreamPayload[]): MoADiscussionPanel[] {
  const out: MoADiscussionPanel[] = []
  for (const p of payloads) {
    if (p.kind !== 'tagent_event') continue
    if (p.event.type === 'moa_discussion') out.push(p.event.panel as MoADiscussionPanel)
  }
  return out
}

function eventTypes(payloads: TAgentDesktopStreamPayload[], type: string): TAgentDesktopStreamPayload[] {
  return payloads.filter((p) => p.kind === 'tagent_event' && p.event.type === type)
}

/** 取所有 session_error 事件的中文文案（内部窄化到 tagent_event 后读 event.message） */
function errorMessages(payloads: TAgentDesktopStreamPayload[]): string[] {
  const out: string[] = []
  for (const p of payloads) {
    if (p.kind !== 'tagent_event') continue
    if (p.event.type !== 'session_error') continue
    out.push((p.event as { message?: string }).message ?? '')
  }
  return out
}

const AGG = 'glm-5.1'

/** happy runner：participant 按 modelId+轮次回文本；moderator 回共识方案 */
function happyRunner() {
  return makeSeatRunner((args) => {
    if (args.modelId === AGG) return '共识方案：综合各方意见，分两步实施。'
    const m = /第 (\d+) 轮/.exec(args.prompt)
    return `${args.modelId}@第${m?.[1] ?? '?'}轮`
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runMoADiscussion · 运行时校验', () => {
  it('预置停用 → error，不落盘 user、不调 seat', async () => {
    const { runner, runSeat } = happyRunner()
    const { ctx, payloads } = makeCtx({ runner, preset: makePreset({ enabled: false }) })
    const res = await runMoADiscussion(ctx)
    expect(res.outcome).toBe('error')
    expect(res.error).toContain('已停用')
    expect(runSeat).not.toHaveBeenCalled()
    expect(appendPanelMessages).not.toHaveBeenCalled()
    const msgs = errorMessages(payloads)
    expect(msgs.length).toBe(1)
    expect(msgs[0]).toContain('已停用')
    expect(eventTypes(payloads, 'turn_end').length).toBe(1)
  })

  it('参考席不足 2 个 → error', async () => {
    const { runner, runSeat } = happyRunner()
    const { ctx, payloads } = makeCtx({
      runner,
      preset: makePreset({ references: [{ name: '独苗', modelId: 'glm-5.2' }] }),
    })
    const res = await runMoADiscussion(ctx)
    expect(res.outcome).toBe('error')
    expect(res.error).toContain('参考席不足')
    expect(runSeat).not.toHaveBeenCalled()
    expect(panelsOf(payloads).length).toBe(0)
  })

  it('汇总模型在当前渠道未启用 → error', async () => {
    const { runner, runSeat } = happyRunner()
    const { ctx, payloads } = makeCtx({
      runner,
      channel: makeChannel(['glm-5.2', 'kimi-k2.5']), // glm-5.1 关闭
    })
    const res = await runMoADiscussion(ctx)
    expect(res.outcome).toBe('error')
    expect(res.error).toContain('汇总模型')
    expect(runSeat).not.toHaveBeenCalled()
    expect(panelsOf(payloads).length).toBe(0)
  })
})

describe('runMoADiscussion · 正常两轮 + 收口', () => {
  it('roundLimit=2：entries 顺序 / phase=done / moderator 拿到全部讨论 / final assistant 落盘', async () => {
    const { runner, runSeat, calls } = happyRunner()
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 2 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 2 参考席 × 2 轮 + 1 纪要（第 2 轮后） + 1 总结人 = 6 次 runSeat
    expect(runSeat).toHaveBeenCalledTimes(6)

    const panels = panelsOf(payloads)
    // 每次调用席位前都先推进行中状态，渲染层可明确显示当前在等谁。
    expect(panels.some((panel) => panel.activeSpeakerId === 'ref-0' && panel.entries.length === 0)).toBe(true)
    expect(panels.some((panel) => panel.activeSpeakerId === 'ref-1' && panel.entries.length === 1)).toBe(true)
    expect(panels.some((panel) => panel.activeSpeakerId === 'moderator' && panel.phase === 'finalizing')).toBe(true)
    const last = panels.at(-1)!
    expect(last.phase).toBe('done')
    expect(last.activeSpeakerId).toBeUndefined()
    expect(last.summary).toBe('共识方案：综合各方意见，分两步实施。')
    expect(last.entries).toHaveLength(4)
    // 串行 + 轮次顺序：ref-0@1, ref-1@1, ref-0@2, ref-1@2
    expect(last.entries.map((e) => e.speakerId)).toEqual(['ref-0', 'ref-1', 'ref-0', 'ref-1'])
    expect(last.entries.map((e) => e.turn)).toEqual([1, 1, 2, 2])
    expect(last.entries.map((e) => e.text)).toEqual([
      'glm-5.2@第1轮',
      'kimi-k2.5@第1轮',
      'glm-5.2@第2轮',
      'kimi-k2.5@第2轮',
    ])

    // 总结人拿到全部讨论（最后一次 runSeat = moderator，modelId=aggregator）
    const modCall = calls.at(-1)!
    expect(modCall.modelId).toBe(AGG)
    expect(modCall.prompt).toContain('glm-5.2@第1轮')
    expect(modCall.prompt).toContain('kimi-k2.5@第1轮')
    expect(modCall.prompt).toContain('glm-5.2@第2轮')
    expect(modCall.prompt).toContain('kimi-k2.5@第2轮')
    expect(modCall.prompt).toContain('请作为总结人')

    // final assistant 落盘（user + assistant 两次双写）+ 推 sdk_message 事件
    expect(appendPanelMessages).toHaveBeenCalledTimes(2)
    expect(appendSdkMessages).toHaveBeenCalledTimes(2)
    expect(
      payloads.some((p) => p.kind === 'sdk_message' && p.message.type === 'assistant'),
    ).toBe(true)
    expect(payloads.some((p) => p.kind === 'sdk_message' && p.message.type === 'user')).toBe(true)

    // 流式正文 + result + turn_end
    expect(payloads.some((p) => p.kind === 'stream_text_delta')).toBe(true)
    expect(payloads.some((p) => p.kind === 'result')).toBe(true)
    expect(eventTypes(payloads, 'turn_end').length).toBe(1)

    // T8：终态(done)落盘完整 panel 一行（含全部 entries + summary）；中间过程不落盘 → 恰好 1 次
    expect(appendMoADiscussionPanelRecord).toHaveBeenCalledTimes(1)
    expect(appendMoADiscussionPanelRecord).toHaveBeenCalledWith(
      undefined,
      'sess-1',
      expect.objectContaining({
        discussionId: last.discussionId,
        phase: 'done',
        summary: '共识方案：综合各方意见，分两步实施。',
        entries: expect.arrayContaining([expect.objectContaining({ speakerId: 'ref-0' })]),
      }),
    )
  })
})

describe('runMoADiscussion · 防失控', () => {
  it('轮数上限触发 finalizing：roundLimit=1 仅跑 1 轮即收口', async () => {
    const { runner, runSeat } = happyRunner()
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 1 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 2 参考席 × 1 轮 + 1 总结人 = 3 次（而非默认 6 轮的 13 次）→ 证明上限生效
    expect(runSeat).toHaveBeenCalledTimes(3)

    const panels = panelsOf(payloads)
    // 上限到点 → 推过 finalizing 卡，随后收口 done
    expect(panels.some((p) => p.phase === 'finalizing')).toBe(true)
    const last = panels.at(-1)!
    expect(last.phase).toBe('done')
    expect(last.entries).toHaveLength(2)
    expect(last.entries.map((e) => e.turn)).toEqual([1, 1])
  })

  it('全参与者本轮失败 → error（早退，不进收口）', async () => {
    const { runner, runSeat } = makeSeatRunner((args) => {
      if (args.modelId === AGG) return '共识' // 总结人不应被调到
      throw new Error('模型不可用')
    })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 2 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('error')
    expect(res.error).toContain('所有席位')
    // 第 1 轮 2 席均失败 → 立即 error，不进第 2 轮 / 不调总结人
    expect(runSeat).toHaveBeenCalledTimes(2)

    const panels = panelsOf(payloads)
    const last = panels.at(-1)!
    expect(last.phase).toBe('error')
    expect(last.entries).toHaveLength(2)
    expect(last.entries.every((e) => e.text.includes('本席本轮发言失败'))).toBe(true)
    expect(eventTypes(payloads, 'session_error').length).toBe(1)
    expect(eventTypes(payloads, 'turn_end').length).toBe(1)

    // T8：终态(error)落盘 panel 一行（保留失败占位 entries）
    expect(appendMoADiscussionPanelRecord).toHaveBeenCalledTimes(1)
    expect(appendMoADiscussionPanelRecord).toHaveBeenCalledWith(
      undefined,
      'sess-1',
      expect.objectContaining({ phase: 'error', entries: expect.any(Array) }),
    )
  })
})

describe('runMoADiscussion · 取消', () => {
  it('signal abort → cancelled（保留已发言记录，不落 final assistant）', async () => {
    const controller = new AbortController()
    let seatCount = 0
    const { runner, runSeat } = makeSeatRunner(() => {
      seatCount++
      if (seatCount === 1) return '架构师首发言' // 第 1 席成功并落 entry
      controller.abort() // 第 2 席 runSeat 期间 abort
      return '不该被记录的半截发言'
    })
    const { ctx, payloads } = makeCtx({ runner, signal: controller.signal, roundLimit: 6 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('cancelled')
    expect(runSeat).toHaveBeenCalledTimes(2)

    const panels = panelsOf(payloads)
    const last = panels.at(-1)!
    expect(last.phase).toBe('cancelled')
    // 第 1 席发言已落记录；第 2 席被 abort 未落
    expect(last.entries).toHaveLength(1)
    expect(last.entries[0]!.speakerId).toBe('ref-0')
    expect(last.entries[0]!.turn).toBe(1)
    // user 消息已落盘，但未落 final assistant
    expect(appendPanelMessages).toHaveBeenCalledTimes(1)
    expect(payloads.some((p) => p.kind === 'sdk_message' && p.message.type === 'assistant')).toBe(false)
    // 取消不推 result / 不推 turn_end（由调用方 STOP 负责，与 run-moa-turn 一致）
    expect(payloads.some((p) => p.kind === 'result')).toBe(false)

    // T8：终态(cancelled)落盘 panel 一行（保留已发言记录）
    expect(appendMoADiscussionPanelRecord).toHaveBeenCalledTimes(1)
    expect(appendMoADiscussionPanelRecord).toHaveBeenCalledWith(
      undefined,
      'sess-1',
      expect.objectContaining({ phase: 'cancelled', entries: expect.any(Array) }),
    )
  })
})

// ---- 会话历史注入（T5：buildHistoryForTurn 复用 run-moa-turn 同款） ----

/**
 * kscc / MoA 面板落盘形态：SDKMessage（message.content 嵌套），与 persistAndPushUser /
 * persistAndPushFinalAssistant 落盘一致——buildHistoryForTurn 内部用 sdkMessageToIR 转回 IR。
 */
function sdkPanelUserMsg(text: string): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    createdAt: 0,
  }
}
function sdkPanelAssistantMsg(text: string): unknown {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'glm-5.2' },
    parent_tool_use_id: null,
    uuid: 'moa-agg-test',
    createdAt: 0,
    _channelModelId: 'glm-5.2',
  }
}

describe('runMoADiscussion · 会话历史注入', () => {
  it('历史存在时 participant / 总结人 prompt 前置 [会话上下文]，并排除本轮 user', async () => {
    // 模拟 persistAndPushUser 之后读到的面板：[老 user, 老 assistant, 本轮 user（末条）]
    // excludeTrailingTurn=true 会把末条本轮 user 排除，避免与「议题」重复
    mockedReadPanelMessages.mockReturnValueOnce([
      sdkPanelUserMsg('老问题：之前聊过微服务怎么拆'),
      sdkPanelAssistantMsg('老回答：建议按 DDD 限界上下文拆'),
      sdkPanelUserMsg('如何拆分模块？请给方案'), // 本轮 user（面板末条）→ 排除
    ])

    const { runner, runSeat, calls } = happyRunner()
    const { ctx } = makeCtx({ runner, roundLimit: 1 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 2 参考席 × 1 轮 + 1 总结人 = 3 次
    expect(runSeat).toHaveBeenCalledTimes(3)

    // participant 首次发言 prompt 前置会话上下文（[用户]/[助手] 标签）
    const firstCall = calls[0]!
    expect(firstCall.prompt).toContain('[会话上下文]')
    expect(firstCall.prompt).toContain('[用户] 老问题：之前聊过微服务怎么拆')
    expect(firstCall.prompt).toContain('[助手] 老回答：建议按 DDD 限界上下文拆')
    // 本轮 user 被排除：不以 [用户] 标签进历史（议题行仍含本轮 prompt 文本）
    expect(firstCall.prompt).not.toContain('[用户] 如何拆分模块？请给方案')
    // 历史前置后接 [圆桌讨论] 议题段
    expect(firstCall.prompt).toContain('[圆桌讨论]')

    // 总结人 prompt 同样前置历史（收口人也要看到会话前文）
    const modCall = calls.at(-1)!
    expect(modCall.modelId).toBe(AGG)
    expect(modCall.prompt).toContain('[会话上下文]')
    expect(modCall.prompt).toContain('[用户] 老问题：之前聊过微服务怎么拆')
    expect(modCall.prompt).toContain('[助手] 老回答：建议按 DDD 限界上下文拆')
    expect(modCall.prompt).not.toContain('[用户] 如何拆分模块？请给方案')
    // 讨论记录 + 收口指令仍在
    expect(modCall.prompt).toContain('[圆桌讨论全部记录]')
    expect(modCall.prompt).toContain('请作为总结人')
  })

  it('历史为空（新会话首条）→ prompt 不含 [会话上下文]，行为不变', async () => {
    // readPanelMessages 默认 mock 返回 []（见顶部 vi.mock），不覆写
    const { runner, runSeat, calls } = happyRunner()
    const { ctx } = makeCtx({ runner, roundLimit: 1 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    expect(runSeat).toHaveBeenCalledTimes(3)
    const firstCall = calls[0]!
    expect(firstCall.prompt).not.toContain('[会话上下文]')
    expect(firstCall.prompt).toContain('[圆桌讨论]')
    expect(firstCall.prompt).toContain('你是本轮首位发言者')
  })

  it('readPanelMessages 抛错 → 历史降级为空，不阻断讨论', async () => {
    mockedReadPanelMessages.mockImplementationOnce(() => {
      throw new Error('磁盘读失败')
    })
    const { runner, runSeat, calls } = happyRunner()
    const { ctx } = makeCtx({ runner, roundLimit: 1 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    const firstCall = calls[0]!
    expect(firstCall.prompt).not.toContain('[会话上下文]')
    expect(firstCall.prompt).toContain('[圆桌讨论]')
  })
})

// ---- 用户插话（§5.3：interjections.drain 每轮开始前注入） ----

describe('runMoADiscussion · 用户插话', () => {
  it('drain 返回插话 → 本轮参与者 prompt 含 [用户插话]，user 发言在参与者之前', async () => {
    const chan = makeInterjectionChannel(['请重点讨论性能'])
    const { runner, runSeat, calls } = happyRunner()
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 2, interjections: chan.interjections })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 2 参考席 × 2 轮 + 1 纪要（第 2 轮后） + 1 总结人 = 6 次（插话不额外加轮）
    expect(runSeat).toHaveBeenCalledTimes(6)

    // 第 1 轮第 1 个参与者（ref-0）prompt：含 [用户插话] 段 + 指令；无 [已有发言]（先回应用户）
    const firstCall = calls[0]!
    expect(firstCall.prompt).toContain('[用户插话]')
    expect(firstCall.prompt).toContain('- 你：请重点讨论性能')
    expect(firstCall.prompt).toContain('请先回应用户插话')
    expect(firstCall.prompt).not.toContain('[已有发言]')

    // entries：user 发言（turn 1）在本轮参与者发言之前 → user + 4 参与者
    const last = panelsOf(payloads).at(-1)!
    expect(last.entries).toHaveLength(5)
    expect(last.entries[0]!.speakerId).toBe('user')
    expect(last.entries[0]!.turn).toBe(1)
    expect(last.entries[0]!.text).toBe('请重点讨论性能')
    expect(last.entries[1]!.speakerId).toBe('ref-0')
    expect(last.entries[1]!.turn).toBe(1)

    // 总结人 prompt 也含该插话（读最新 panel.entries，全部记录里可见）
    const modCall = calls.at(-1)!
    expect(modCall.modelId).toBe(AGG)
    expect(modCall.prompt).toContain('请重点讨论性能')
  })

  it('drain 为空 → 行为不变（无 [用户插话]、无 user entry、runSeat 次数与无通道一致）', async () => {
    const chan = makeInterjectionChannel() // 空 pending
    const { runner, runSeat, calls } = happyRunner()
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 2, interjections: chan.interjections })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    expect(runSeat).toHaveBeenCalledTimes(6)
    // 无 user 发言；4 条全为参与者
    const last = panelsOf(payloads).at(-1)!
    expect(last.entries).toHaveLength(4)
    expect(last.entries.every((e) => e.speakerId !== 'user')).toBe(true)
    // 任意 runSeat prompt 均不含 [用户插话]
    expect(calls.every((c) => !c.prompt.includes('[用户插话]'))).toBe(true)
    // 首位发言者提示仍在（与无通道一致）
    expect(calls[0]!.prompt).toContain('你是本轮首位发言者')
  })

  it('插话在轮中途入队 → 下一轮开始 drain 注入该轮参与者 prompt', async () => {
    const chan = makeInterjectionChannel()
    let pushed = false
    const { runner, runSeat, calls } = makeSeatRunner((args) => {
      if (args.modelId === AGG) return '共识方案'
      // 第 1 个参与者跑时入队（此时第 1 轮开始 drain 已空排过）→ 留到第 2 轮开始 drain
      if (!pushed) {
        chan.pending.push('第二轮请聚焦成本')
        pushed = true
      }
      const m = /第 (\d+) 轮/.exec(args.prompt)
      return `${args.modelId}@第${m?.[1] ?? '?'}轮`
    })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 2, interjections: chan.interjections })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    expect(runSeat).toHaveBeenCalledTimes(6)
    // 第 1 轮参与者 prompt 不含该插话（入队晚于第 1 轮 drain）
    expect(calls[0]!.prompt).not.toContain('第二轮请聚焦成本')
    // 第 2 轮第 1 个参与者（calls[2] = ref-0@2）prompt 含 [用户插话]
    expect(calls[2]!.prompt).toContain('[用户插话]')
    expect(calls[2]!.prompt).toContain('- 你：第二轮请聚焦成本')
    // entries：ref-0@1, ref-1@1, user@2, ref-0@2, ref-1@2 → user（turn 2）在第 2 轮参与者之前
    const last = panelsOf(payloads).at(-1)!
    expect(last.entries).toHaveLength(5)
    expect(last.entries[2]!.speakerId).toBe('user')
    expect(last.entries[2]!.turn).toBe(2)
    expect(last.entries[3]!.speakerId).toBe('ref-0')
    expect(last.entries[3]!.turn).toBe(2)
  })

  it('最后轮中途入队 → 收口前 drain，总结人 prompt 含该插话（§5.3）', async () => {
    const chan = makeInterjectionChannel()
    let pushed = false
    const { runner, runSeat, calls } = makeSeatRunner((args) => {
      if (args.modelId === AGG) return '共识方案'
      if (!pushed) {
        chan.pending.push('最后请补充风险点')
        pushed = true
      }
      const m = /第 (\d+) 轮/.exec(args.prompt)
      return `${args.modelId}@第${m?.[1] ?? '?'}轮`
    })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 1, interjections: chan.interjections })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 2 参考席 × 1 轮 + 1 总结人 = 3 次
    expect(runSeat).toHaveBeenCalledTimes(3)
    // 第 1 轮参与者未看到该插话（入队晚于第 1 轮 drain，且无第 2 轮 drain）
    expect(calls[0]!.prompt).not.toContain('最后请补充风险点')
    // 收口前 drain 落 user entry → 总结人 prompt（全部记录）含该插话
    const modCall = calls.at(-1)!
    expect(modCall.modelId).toBe(AGG)
    expect(modCall.prompt).toContain('最后请补充风险点')
    // user 发言已落 entries（turn 1，在参与者之后、总结人之前）
    const last = panelsOf(payloads).at(-1)!
    expect(last.entries.some((e) => e.speakerId === 'user' && e.text === '最后请补充风险点')).toBe(true)
  })
})

// ---- 提前收敛（T9：evaluateDiscussionConvergence 接线）----

// 长发言（>80 字）、不含任何收敛信号词：rule a（全短）与 rule b（信号命中）均不成立 → 不收敛
const LONG_NO_SIGNAL_REPLY =
  '这个方案还需要更多细化，特别是边界条件和异常路径目前说得太笼统，建议先把每个模块的输入输出契约列成清单，逐一确认后再进入下一阶段，避免后面返工，同时要约定好错误码和版本兼容策略，另外要把数据流和失败兜底都画清楚。'

describe('runMoADiscussion · 提前收敛', () => {
  it('短发言 → 第 2 轮结束即 finalizing（不等 roundLimit=6）', async () => {
    const { runner, runSeat } = happyRunner() // 参与者回 `${modelId}@第${n}轮`，~12 字 ≤ 80
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 6 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 提前收敛于第 2 轮：2 参考席 × 2 轮 + 1 纪要 + 1 总结人 = 6 次（跑满 6 轮会是 16 次，含 3 次纪要）
    expect(runSeat).toHaveBeenCalledTimes(6)

    const panels = panelsOf(payloads)
    // 收敛触发 → 推过 finalizing 卡，随后收口 done
    expect(panels.some((p) => p.phase === 'finalizing')).toBe(true)
    const last = panels.at(-1)!
    expect(last.phase).toBe('done')
    // 只跑了 2 轮 → 4 条参与者发言，turn 到 2 即止
    expect(last.entries).toHaveLength(4)
    expect(last.entries.map((e) => e.turn)).toEqual([1, 1, 2, 2])
    expect(last.entries.map((e) => e.speakerId)).toEqual(['ref-0', 'ref-1', 'ref-0', 'ref-1'])
  })

  it('长发言无信号 → 不收敛，继续到 roundLimit 上限才收口', async () => {
    const { runner, runSeat } = makeSeatRunner((args) => {
      if (args.modelId === AGG) return '共识方案'
      return LONG_NO_SIGNAL_REPLY // 长 + 无信号 → rule a/b 均不成立
    })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 3 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 跑满 3 轮：2 参考席 × 3 轮 + 1 纪要（第 2 轮后） + 1 总结人 = 8 次（若误于第 2 轮收敛会是 6 次）
    expect(runSeat).toHaveBeenCalledTimes(8)

    const last = panelsOf(payloads).at(-1)!
    expect(last.phase).toBe('done')
    expect(last.entries).toHaveLength(6)
    expect(last.entries.map((e) => e.turn)).toEqual([1, 1, 2, 2, 3, 3])
  })

  it('用户插话不计入收敛：插话为长发言，参与者短发言仍于第 2 轮收敛', async () => {
    const chan = makeInterjectionChannel()
    let pushed = false
    // 长用户插话（>80 字、无信号）：若被误计入 rule a 会让「全短」失败 → 不收敛 → 跑满 6 轮；
    // 正确实现只统计参与者发言 → 参与者短发言 → 第 2 轮收敛。以此验证 user 插话被排除。
    const longUserInterject =
      '这是一段很长的用户插话内容，刻意超过八十个字符以验证它不会干扰参与者发言的判定，因为规则只统计参与者表态，用户插话无论长短都不应改变最终的判定走向，确保讨论节奏不被单条提问带偏，也避免在还有展开空间时过早结束。'
    const { runner, runSeat } = makeSeatRunner((args) => {
      if (args.modelId === AGG) return '共识方案'
      if (!pushed) {
        chan.pending.push(longUserInterject) // 第 1 个参与者跑时入队 → 留到第 2 轮 drain
        pushed = true
      }
      const m = /第 (\d+) 轮/.exec(args.prompt)
      return `${args.modelId}@第${m?.[1] ?? '?'}轮` // 参与者短发言
    })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 6, interjections: chan.interjections })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 参与者短发言 → 第 2 轮收敛；长用户插话不计入 → 6 次（非跑满 6 轮的 16 次）
    expect(runSeat).toHaveBeenCalledTimes(6)

    const last = panelsOf(payloads).at(-1)!
    expect(last.phase).toBe('done')
    // 第 2 轮的长用户插话 entry 存在（turn 2），但未阻止收敛
    const userEntries = last.entries.filter((e) => e.speakerId === 'user')
    expect(userEntries).toHaveLength(1)
    expect(userEntries[0]!.turn).toBe(2)
    expect(userEntries[0]!.text.length).toBeGreaterThan(80)
    expect(userEntries[0]!.text).toBe(longUserInterject)
    // 参与者发言仍只到第 2 轮（4 条短发言）
    const participantEntries = last.entries.filter((e) => e.speakerId !== 'user')
    expect(participantEntries).toHaveLength(4)
    expect(participantEntries.map((e) => e.turn)).toEqual([1, 1, 2, 2])
  })
})

// ---- roundLimit 取值链路（T10：ctx.roundLimit > preset.roundLimit > 3）----

describe('runMoADiscussion · roundLimit 取值链路', () => {
  // 长 + 无信号发言：rule a（全短）/ rule b（信号）均不成立 → 不提前收敛，跑满上限才收口。
  // 用它来精确计数轮数，排除 T9 提前收敛的干扰。
  function longNoSignalRunner() {
    return makeSeatRunner((args) => {
      if (args.modelId === AGG) return '共识方案'
      return LONG_NO_SIGNAL_REPLY
    })
  }

  it('ctx 无 roundLimit → 用 preset.roundLimit', async () => {
    const { runner, runSeat } = longNoSignalRunner()
    const { ctx, payloads } = makeCtx({ runner, preset: makePreset({ roundLimit: 2 }) }) // 不传 ctx.roundLimit
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // preset.roundLimit=2 → 2 参考席 × 2 轮 + 1 纪要 + 1 总结人 = 6 次（非默认 3 轮的 8 次）
    expect(runSeat).toHaveBeenCalledTimes(6)
    const last = panelsOf(payloads).at(-1)!
    expect(last.phase).toBe('done')
    // 跑满 2 轮：4 条参与者发言，turn 到 2 即止
    expect(last.entries.filter((e) => e.speakerId !== 'user')).toHaveLength(4)
    expect(last.entries.filter((e) => e.speakerId !== 'user').map((e) => e.turn)).toEqual([1, 1, 2, 2])
  })

  it('ctx 与 preset 均无 roundLimit → 默认 3', async () => {
    const { runner, runSeat } = longNoSignalRunner()
    const { ctx } = makeCtx({ runner }) // 不传 roundLimit；preset 也不带 roundLimit
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 默认 3 轮：2 参考席 × 3 轮 + 1 纪要（第 2 轮后） + 1 总结人 = 8 次
    expect(runSeat).toHaveBeenCalledTimes(8)
  })

  it('ctx.roundLimit 优先于 preset.roundLimit', async () => {
    const { runner, runSeat } = longNoSignalRunner()
    const { ctx } = makeCtx({ runner, preset: makePreset({ roundLimit: 5 }), roundLimit: 1 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // ctx.roundLimit=1 胜出：2 参考席 × 1 轮 + 1 总结人 = 3 次（非 preset 的 5 轮 13 次，含 2 次纪要）
    expect(runSeat).toHaveBeenCalledTimes(3)
  })
})

// ---- 共享纪要（T11：每 N 轮压缩成纪要，下一轮读纪要而非全部发言） ----

/**
 * T11 专用 runner：按 prompt 标记区分「纪要 / 收口 / 参与者」三类调用。
 * - prompt 含 `[圆桌纪要]` → 纪要模型调用，返回 summaryText（或按 throws 抛错）
 * - 否则 modelId===AGG → moderator 收口，返回共识方案
 * - 否则 → 参与者发言，返回「第N轮-modelId：」+ 长无信号正文（>80 字、0 信号词 → T9 不收敛）
 *   用长无信号正文是为了排除 T9 提前收敛的干扰，让纪要触发/未触发成为唯一变量。
 */
function longRoundReply(round: number, modelId: string): string {
  return `第${round}轮-${modelId}：${LONG_NO_SIGNAL_REPLY}`
}

function makeT11Runner(opts: {
  summaryText: string
  summaryThrows?: boolean
}): {
  runner: MoADiscussionContext['seatRunner']
  runSeat: ReturnType<typeof vi.fn>
  calls: { modelId: string; prompt: string }[]
} {
  const calls: { modelId: string; prompt: string }[] = []
  const runSeat = vi.fn(async (args: {
    modelId: string
    prompt: string
    onTextDelta?: (t: string) => void
  }) => {
    calls.push({ modelId: args.modelId, prompt: args.prompt })
    if (args.prompt.includes('[圆桌纪要]')) {
      if (opts.summaryThrows) throw new Error('纪要模型不可用')
      if (args.onTextDelta) args.onTextDelta(opts.summaryText)
      return opts.summaryText
    }
    if (args.modelId === AGG) {
      const consensus = '共识方案：综合各方意见，分两步实施。'
      if (args.onTextDelta) args.onTextDelta(consensus)
      return consensus
    }
    const m = /现在是第 (\d+) 轮/.exec(args.prompt)
    const text = longRoundReply(Number(m?.[1] ?? 0), args.modelId)
    if (args.onTextDelta) args.onTextDelta(text)
    return text
  })
  return { runner: { runSeat } as unknown as MoADiscussionContext['seatRunner'], runSeat, calls }
}

const SUMMARY_NO_CONVERGE = [
  '## 当前目标',
  '- 拆分模块，明确边界',
  '## 已确认决定',
  '- 暂无',
  '## 未决事项',
  '- 接口契约未定',
  '收敛: 否',
].join('\n')

const SUMMARY_CONVERGE = [
  '## 当前目标',
  '- 拆分模块，明确边界',
  '## 已确认决定',
  '- 先抽接口再实现',
  '## 未决事项',
  '- 暂无',
  '收敛: 是',
].join('\n')

describe('runMoADiscussion · 共享纪要（T11）', () => {
  it('①每 2 轮生成纪要；第 3 轮参与者 prompt 含 [共享纪要] 而非全部发言', async () => {
    const { runner, runSeat, calls } = makeT11Runner({ summaryText: SUMMARY_NO_CONVERGE })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 4 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 2 参考席 × 4 轮 + 2 纪要（第 2、4 轮后） + 1 总结人 = 11 次
    expect(runSeat).toHaveBeenCalledTimes(11)

    // 纪要调用：prompt 含 [圆桌纪要] → 恰 2 次（第 2、4 轮后）
    const summaryCalls = calls.filter((c) => c.prompt.includes('[圆桌纪要]'))
    expect(summaryCalls).toHaveLength(2)
    // 收口调用：prompt 含 [圆桌讨论全部记录] → 1 次
    expect(calls.filter((c) => c.prompt.includes('[圆桌讨论全部记录]'))).toHaveLength(1)

    // 调用顺序：ref0@1, ref1@1, ref0@2, ref1@2, 纪要(4), ref0@3(5), ref1@3(6), ref0@4(7), ref1@4(8), 纪要(9), 收口(10)
    expect(calls[4]!.prompt).toContain('[圆桌纪要]') // 第 1 次纪要（第 2 轮后）
    expect(calls[5]!.prompt).not.toContain('[圆桌纪要]') // ref0@3 是参与者
    // 第 2 轮参与者（calls[2]=ref0@2）：纪要尚未生成 → [已有发言] 含第 1 轮全文，无 [共享纪要]
    expect(calls[2]!.prompt).toContain('[已有发言]')
    expect(calls[2]!.prompt).toContain('第1轮-glm-5.2')
    expect(calls[2]!.prompt).not.toContain('[共享纪要]')
    // 第 3 轮首个参与者（calls[5]=ref0@3）：纪要已生成 → [共享纪要]，不再堆积第 1/2 轮全文
    expect(calls[5]!.prompt).toContain('[共享纪要]')
    expect(calls[5]!.prompt).toContain('拆分模块，明确边界') // 纪要内容可见
    expect(calls[5]!.prompt).not.toContain('第1轮-glm-5.2') // 第 1 轮全文已被压缩进纪要
    expect(calls[5]!.prompt).not.toContain('第2轮-glm-5.2') // 第 2 轮全文同理
    // 第 3 轮第二个参与者（calls[6]=ref1@3）：[最近发言] 含本轮已发言者（第 3 轮），仍无旧轮全文
    expect(calls[6]!.prompt).toContain('[最近发言]')
    expect(calls[6]!.prompt).toContain('第3轮-glm-5.2') // 本轮已发言者可见
    expect(calls[6]!.prompt).not.toContain('第1轮-glm-5.2')

    // 终态 panel：runningSummary 已写入（过程纪要），summary 为收口共识（二者语义不同）
    const last = panelsOf(payloads).at(-1)!
    expect(last.phase).toBe('done')
    expect(last.runningSummary).toBe(SUMMARY_NO_CONVERGE)
    expect(last.summary).toBe('共识方案：综合各方意见，分两步实施。')
    expect(last.entries).toHaveLength(8) // 2 席 × 4 轮，纪要不增加 entries
    // 收口 prompt 同时含 [讨论纪要]（TL;DR）与全部 8 条发言全文（兜底）
    const modCall = calls.at(-1)!
    expect(modCall.prompt).toContain('[讨论纪要]')
    expect(modCall.prompt).toContain('第1轮-glm-5.2')
    expect(modCall.prompt).toContain('第4轮-kimi-k2.5')
  })

  it('②纪要返回「收敛: 是」→ 第 2 轮后提前 finalizing（T9 长无信号不收敛，故此为 T11 触发）', async () => {
    // 参与者用长无信号正文 → T9 evaluateDiscussionConvergence 必返回 false；
    // 故第 2 轮即 finalizing 只能来自纪要的「收敛: 是」判定，隔离验证 T11 收敛升级。
    const { runner, runSeat, calls } = makeT11Runner({ summaryText: SUMMARY_CONVERGE })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 6 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 第 2 轮后纪要返回「收敛: 是」→ finalizing：2×2 + 1 纪要 + 1 总结人 = 6 次（非跑满 6 轮的 16 次）
    expect(runSeat).toHaveBeenCalledTimes(6)

    const panels = panelsOf(payloads)
    expect(panels.some((p) => p.phase === 'finalizing')).toBe(true)
    const last = panels.at(-1)!
    expect(last.phase).toBe('done')
    // 只跑了 2 轮 → 4 条参与者发言，turn 到 2 即止（纪要不增 entries）
    expect(last.entries).toHaveLength(4)
    expect(last.entries.map((e) => e.turn)).toEqual([1, 1, 2, 2])
    // 纪要已写入（含「收敛: 是」），收口共识照常落 summary
    expect(last.runningSummary).toBe(SUMMARY_CONVERGE)
    expect(last.summary).toBe('共识方案：综合各方意见，分两步实施。')
    // 纪要调用确实返回了「收敛: 是」
    const summaryCall = calls.find((c) => c.prompt.includes('[圆桌纪要]'))!
    expect(summaryCall).toBeDefined()
  })

  it('③纪要失败 → 降级沿用旧纪要、参与者 prompt 无 [共享纪要]、讨论不中断', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runner, runSeat, calls } = makeT11Runner({
      summaryText: SUMMARY_NO_CONVERGE,
      summaryThrows: true,
    })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 4 })
    const res = await runMoADiscussion(ctx)

    // 降级：纪要两次均抛错被 catch → 不写 runningSummary、不阻断，讨论跑满 4 轮再收口
    expect(res.outcome).toBe('done')
    // 2×4 + 2 纪要（均抛错但仍计数） + 1 总结人 = 11 次
    expect(runSeat).toHaveBeenCalledTimes(11)
    // 两次降级 warn
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('纪要更新失败'))).toBe(true)
    warnSpy.mockRestore()

    // 终态 panel：runningSummary 始终未写入（降级沿用空纪要）
    const last = panelsOf(payloads).at(-1)!
    expect(last.phase).toBe('done')
    expect(last.runningSummary).toBeUndefined()
    expect(last.entries).toHaveLength(8) // 讨论未中断，4 轮全部发言
    expect(last.summary).toBe('共识方案：综合各方意见，分两步实施。')

    // 第 3 轮参与者 prompt：无纪要 → 回退 [已有发言]（全部席位发言），不含 [共享纪要]
    expect(calls[6]!.prompt).toContain('[已有发言]')
    expect(calls[6]!.prompt).toContain('第1轮-glm-5.2') // 旧轮全文仍在（未被压缩）
    expect(calls[6]!.prompt).not.toContain('[共享纪要]')
    expect(calls[6]!.prompt).not.toContain('[最近发言]')
    // 收口 prompt 无 [讨论纪要]（runningSummary 缺失），仍含全部发言全文
    const modCall = calls.at(-1)!
    expect(modCall.prompt).not.toContain('[讨论纪要]')
    expect(modCall.prompt).toContain('第1轮-glm-5.2')
  })

  it('④纪要在场时 moderator 收口正常：prompt 含 [讨论纪要] + 全部发言，落共识方案', async () => {
    // roundLimit=2：第 2 轮后生成纪要（收敛:否 → 不提前收口），T9 长无信号也不收敛，
    // 故 finalizing 由轮数上限触发（第 3 轮 beginNextRound > 2）→ moderator 收口，验证收口与纪要并存。
    const { runner, runSeat, calls } = makeT11Runner({ summaryText: SUMMARY_NO_CONVERGE })
    const { ctx, payloads } = makeCtx({ runner, roundLimit: 2 })
    const res = await runMoADiscussion(ctx)

    expect(res.outcome).toBe('done')
    // 2×2 + 1 纪要 + 1 总结人 = 6 次
    expect(runSeat).toHaveBeenCalledTimes(6)

    const last = panelsOf(payloads).at(-1)!
    expect(last.phase).toBe('done')
    expect(last.runningSummary).toBe(SUMMARY_NO_CONVERGE)
    expect(last.summary).toBe('共识方案：综合各方意见，分两步实施。')
    expect(last.entries).toHaveLength(4)

    // 收口 prompt：[讨论纪要]（TL;DR）+ [圆桌讨论全部记录] 全部 4 条发言 + 收口指令
    const modCall = calls.at(-1)!
    expect(modCall.modelId).toBe(AGG)
    expect(modCall.prompt).toContain('[圆桌讨论全部记录]')
    expect(modCall.prompt).toContain('[讨论纪要]')
    expect(modCall.prompt).toContain('拆分模块，明确边界') // 纪要内容
    expect(modCall.prompt).toContain('第1轮-glm-5.2')
    expect(modCall.prompt).toContain('第2轮-kimi-k2.5')
    expect(modCall.prompt).toContain('请作为总结人')
  })
})
