/**
 * moa-history 纯函数单测：
 * - extractMoATurnText：用户 / 助手文本块；忽略 thinking / tool_use；工具结果旁白化。
 * - buildMoAHistoryFromMessages：预算超限从最旧截断（保留近轮）；空输入 → ''。
 * - composeMoaPrompt：historyText 空 → 只返 prompt；否则前缀拼装。
 */
import { describe, expect, it } from 'vitest'
import type { TAgentContentBlock, TAgentMessage } from './tagent-message'
import {
  DEFAULT_MOA_HISTORY_CHAR_BUDGET,
  buildMoAHistoryFromMessages,
  buildResumeHistoryFromPanel,
  composeMoaPrompt,
  extractMoAConclusionFromMessages,
  extractMoATurnText,
  panelMessageToHistoryIR,
} from './moa-history'
// 圆桌讨论共识 uuid 真实格式（moa-disc-agg-<discussionId>），用真函数构造保证格式漂移时测试同步失败
import { moaDiscussionConsensusUuid } from './moa-discussion'

function userMsg(text: string): TAgentMessage {
  return { type: 'user', createdAt: 0, content: [{ type: 'text', text }] }
}

function assistantMsg(text: string, extra: TAgentContentBlock[] = []): TAgentMessage {
  return {
    type: 'assistant',
    createdAt: 0,
    content: [{ type: 'text', text }, ...extra],
  }
}

function assistantWithToolUse(name = 'bash'): TAgentMessage {
  return {
    type: 'assistant',
    createdAt: 0,
    content: [
      { type: 'text', text: '我先查一下' },
      { type: 'tool_use', id: 't1', name, input: { cmd: 'ls' } },
    ],
  }
}

function assistantOnlyToolResult(result: string): TAgentMessage {
  return {
    type: 'user',
    createdAt: 0,
    content: [{ type: 'tool_result', toolUseId: 't1', content: result }],
  }
}

describe('extractMoATurnText', () => {
  it('returns null for empty content / unknown message type', () => {
    expect(
      extractMoATurnText({ type: 'user', createdAt: 0, content: [] }),
    ).toBeNull()
  })

  it('extracts plain user text', () => {
    expect(extractMoATurnText(userMsg('你好'))).toEqual({ role: 'user', text: '你好' })
  })

  it('skips thinking and tool_use; only keeps text block', () => {
    const t = extractMoATurnText(assistantWithToolUse())
    expect(t?.role).toBe('assistant')
    expect(t?.text).toBe('我先查一下')
    expect(t?.text).not.toContain('tool_use')
    expect(t?.text).not.toContain('bash')
  })

  it('promotes tool_result content to user旁白 with prefix', () => {
    const t = extractMoATurnText(assistantOnlyToolResult('file a.ts\nfile b.ts'))
    expect(t?.role).toBe('user')
    expect(t?.text).toBe('[工具结果] file a.ts\nfile b.ts')
  })

  it('clamps very long single turn text by perTurnMaxChars', () => {
    const big = 'a'.repeat(5000)
    const t = extractMoATurnText(userMsg(big), { perTurnMaxChars: 100 })
    expect(t?.text.length).toBeLessThanOrEqual(110) // 100 + "[已截断]\n…"
    expect(t?.text).toContain('[已截断]')
  })
})

describe('buildMoAHistoryFromMessages', () => {
  it('returns empty string for empty input', () => {
    expect(buildMoAHistoryFromMessages([])).toBe('')
  })

  it('wraps with [会话上下文] header + role labels', () => {
    const msgs = [userMsg('你好'), assistantMsg('在的')]
    const out = buildMoAHistoryFromMessages(msgs)
    expect(out.startsWith('[会话上下文]\n')).toBe(true)
    expect(out).toContain('[用户] 你好')
    expect(out).toContain('[助手] 在的')
  })

  it('preserves newest turns when budget is exceeded', () => {
    const msgs: TAgentMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`老问题 ${i} - ${'x'.repeat(200)}`))
      msgs.push(assistantMsg(`老回答 ${i} - ${'y'.repeat(200)}`))
    }
    const out = buildMoAHistoryFromMessages(msgs, { charBudget: 500 })
    expect(out.length).toBeLessThanOrEqual(500)
    // 最新一轮必须在（倒序累加）
    expect(out).toContain('老回答 19')
    // 最早一轮大概率被截掉
    expect(out).not.toContain('老问题 0')
  })

  it('returns empty when charBudget is zero or negative', () => {
    const msgs = [userMsg('hi')]
    expect(buildMoAHistoryFromMessages(msgs, { charBudget: 0 })).toBe('')
    expect(buildMoAHistoryFromMessages(msgs, { charBudget: -1 })).toBe('')
  })

  it('skips messages that yield no text', () => {
    const msgs: TAgentMessage[] = [
      { type: 'assistant', createdAt: 0, content: [{ type: 'thinking', thinking: '...' }] },
      userMsg('真实问题'),
    ]
    const out = buildMoAHistoryFromMessages(msgs)
    expect(out).toContain('[用户] 真实问题')
    // 不应包含 thinking 文本
    expect(out).not.toContain('...')
  })

  it('respects default char budget constant', () => {
    expect(DEFAULT_MOA_HISTORY_CHAR_BUDGET).toBe(12_000)
  })

  it('excludeTrailingTurn=true drops the last message (current-turn user)', () => {
    const msgs = [userMsg('老问题'), assistantMsg('老回答'), userMsg('本轮议题')]
    const out = buildMoAHistoryFromMessages(msgs, { excludeTrailingTurn: true })
    expect(out).toContain('[用户] 老问题')
    expect(out).toContain('[助手] 老回答')
    // 本轮 user 被排除，不进历史（避免与「本轮议题」重复）
    expect(out).not.toContain('本轮议题')
  })

  it('excludeTrailingTurn=true on a fresh session (only current user) → empty history', () => {
    // 新会话首条：persistAndPushUser 后面板仅本轮 user → 排除后历史为空
    expect(buildMoAHistoryFromMessages([userMsg('首条问题')], { excludeTrailingTurn: true })).toBe('')
  })

  it('excludeTrailingTurn defaults to false (keeps all messages, backward-compat)', () => {
    const msgs = [userMsg('老问题'), assistantMsg('老回答'), userMsg('本轮议题')]
    const out = buildMoAHistoryFromMessages(msgs)
    expect(out).toContain('本轮议题')
  })
})

describe('composeMoaPrompt', () => {
  it('returns the prompt unchanged when historyText is empty', () => {
    expect(composeMoaPrompt('讨论一下', '')).toBe('讨论一下')
  })

  it('prefixes history and adds [本轮议题] section when history is present', () => {
    const out = composeMoaPrompt('讨论一下', '[会话上下文]\n[用户] a\n')
    expect(out).toContain('[会话上下文]')
    expect(out).toContain('[本轮议题]')
    expect(out.endsWith('讨论一下')).toBe(true)
  })
})

// ===== 续聊注入（P0 #1 · AUDIT-fresh-session-consult） =====

/** kscc / MoA 面板落盘形态：SDKMessage（message.content 嵌套） */
function sdkUserMsg(text: string, uuid?: string): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    createdAt: 0,
    ...(uuid ? { uuid } : {}),
  }
}
/** MoA 汇总落盘形态：对齐 run-moa-turn.persistAndPushFinalAssistant 的 SDKMessage shape */
function sdkMoAggAssistantMsg(text: string, uuid: string): unknown {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      model: 'glm-5.2',
    },
    parent_tool_use_id: null,
    uuid,
    createdAt: 0,
    _channelModelId: 'glm-5.2',
  }
}

describe('panelMessageToHistoryIR', () => {
  it('passes through IR-form messages (pi 面板，content 顶层)', () => {
    expect(panelMessageToHistoryIR(userMsg('你好'))).toEqual(userMsg('你好'))
    expect(panelMessageToHistoryIR(assistantMsg('在的'))).toEqual(assistantMsg('在的'))
  })

  it('converts SDKMessage-form user to IR (kscc / MoA 面板，message.content 嵌套)', () => {
    const ir = panelMessageToHistoryIR(sdkUserMsg('你好'))
    expect(ir?.type).toBe('user')
    expect(ir?.content).toEqual([{ type: 'text', text: '你好' }])
  })

  it('converts SDKMessage moa-agg assistant to IR preserving text + stop_reason', () => {
    const ir = panelMessageToHistoryIR(sdkMoAggAssistantMsg('汇总结论', 'moa-agg-rt-1'))
    expect(ir?.type).toBe('assistant')
    expect(ir?.content).toEqual([{ type: 'text', text: '汇总结论' }])
  })

  it('returns null for non-user/assistant types and non-objects', () => {
    expect(panelMessageToHistoryIR({ type: 'result', subtype: 'success' })).toBeNull()
    expect(panelMessageToHistoryIR({ type: 'system', subtype: 'init' })).toBeNull()
    expect(panelMessageToHistoryIR(null)).toBeNull()
    expect(panelMessageToHistoryIR('not an object')).toBeNull()
  })
})

describe('buildResumeHistoryFromPanel (P0 #1 续聊注入)', () => {
  const conclusion = '汇总结论：1. 第一要点 2. 第二要点'

  it('SDKMessage 面板有 MoA 轮 → 拼出含会诊结论的历史块，排除本轮 user', () => {
    // 场景（AUDIT）：新会话首条会诊 → 落盘 [user, moa-agg assistant]；随后普通续聊落盘本轮 user
    const panel = [
      sdkUserMsg('研究一下 hermes-studio'),
      sdkMoAggAssistantMsg(conclusion, 'moa-agg-rt-1'),
      sdkUserMsg('刚才结论里第 1 点是什么'), // 本轮 user（面板末条）→ 排除
    ]
    const out = buildResumeHistoryFromPanel(panel)
    expect(out.startsWith('[会话上下文]\n')).toBe(true)
    expect(out).toContain('[用户] 研究一下 hermes-studio')
    expect(out).toContain(`[助手] ${conclusion}`)
    // 本轮 user 被排除（excludeTrailingTurn 默认 true），不进历史
    expect(out).not.toContain('刚才结论里第 1 点')
  })

  it('IR 面板（pi）有 MoA 轮 → 同样拼出结论并排除本轮 user', () => {
    const panel = [
      userMsg('研究一下 hermes-studio'),
      assistantMsg(conclusion),
      userMsg('刚才结论里第 1 点是什么'),
    ]
    const out = buildResumeHistoryFromPanel(panel)
    expect(out).toContain(`[助手] ${conclusion}`)
    expect(out).not.toContain('刚才结论里第 1 点')
  })

  it('混排面板（MoA 落 SDKMessage + pi 普通落 IR）逐条按形态归一', () => {
    // 外部渠会诊（MoA 一律落 SDKMessage）+ pi 普通续聊（落 IR）→ 面板 SDKMessage/IR 混排
    const panel = [
      sdkUserMsg('研究一下 hermes-studio'),
      sdkMoAggAssistantMsg(conclusion, 'moa-agg-rt-1'),
      userMsg('刚才结论里第 1 点是什么'), // IR 形态的本轮 user
    ]
    const out = buildResumeHistoryFromPanel(panel)
    expect(out).toContain('[用户] 研究一下 hermes-studio')
    expect(out).toContain(`[助手] ${conclusion}`)
    expect(out).not.toContain('刚才结论里第 1 点')
  })

  it('空面板 / 新会话首条（仅本轮 user）→ 返回空串（不污染 prompt）', () => {
    expect(buildResumeHistoryFromPanel([])).toBe('')
    expect(buildResumeHistoryFromPanel([sdkUserMsg('首条问题')])).toBe('')
    expect(buildResumeHistoryFromPanel([userMsg('首条问题')])).toBe('')
  })

  it('excludeTrailingTurn=false 保留本轮 user（兼容显式全量历史）', () => {
    const panel = [
      sdkUserMsg('老问题'),
      sdkMoAggAssistantMsg('老回答', 'moa-agg-1'),
      sdkUserMsg('本轮议题'),
    ]
    const out = buildResumeHistoryFromPanel(panel, { excludeTrailingTurn: false })
    expect(out).toContain('本轮议题')
  })

  it('尊重 charBudget：超限从最旧截断，保留含会诊结论的近轮，排除本轮 user', () => {
    const panel = [
      sdkUserMsg('远古问题 - ' + 'x'.repeat(400)),
      sdkMoAggAssistantMsg('远古结论 - ' + 'y'.repeat(400), 'moa-agg-old'),
      sdkUserMsg('近期问题'),
      sdkMoAggAssistantMsg(conclusion, 'moa-agg-new'),
      sdkUserMsg('本轮追问'), // 本轮 user（末条）→ 排除
    ]
    const out = buildResumeHistoryFromPanel(panel, { charBudget: 300 })
    expect(out.length).toBeLessThanOrEqual(300)
    expect(out).toContain(conclusion) // 最新 MoA 结论必留
    expect(out).not.toContain('本轮追问') // 本轮 user 排除
  })

  it('圆桌讨论共识（moa-disc-agg-*）→ 同款 shape 被解析，拼出含共识的历史块，排除本轮 user', () => {
    // 场景：圆桌讨论首条落盘 [user, moa-disc-agg assistant]；续聊落盘本轮 user 为末条。
    // 圆桌讨论共识由 buildMoAFinalAssistantSDKMessage 构造（与会诊 moa-agg 同款 shape），
    // uuid 走 moaDiscussionConsensusUuid（moa-disc-agg-<discussionId>）；解析器只看 type/content
    // shape 不看 uuid 前缀，故会诊/研讨共用 buildResumeHistoryFromPanel 一处注入。
    const discussionId = 'moa-disc-sess-1-0'
    const consensus = '共识方案：分两步实施，先拆模块再定接口。'
    const panel = [
      sdkUserMsg('如何拆分模块？请给方案'),
      sdkMoAggAssistantMsg(consensus, moaDiscussionConsensusUuid(discussionId)),
      sdkUserMsg('第二步具体怎么做'), // 本轮 user（末条）→ 排除
    ]
    const out = buildResumeHistoryFromPanel(panel)
    expect(out.startsWith('[会话上下文]\n')).toBe(true)
    expect(out).toContain('[用户] 如何拆分模块？请给方案')
    expect(out).toContain(`[助手] ${consensus}`)
    // 本轮 user 被排除（excludeTrailingTurn 默认 true），不进历史
    expect(out).not.toContain('第二步具体怎么做')
  })
})

// ===== 续聊注入管线（复刻 session-service.handleSend · P0 #1 / T7） =====
//
// session-service.handleSend 在普通续聊 spawn 路径（isFirst && !meta?.sdkSessionId &&
// !adapter.hasActiveChannel）用 `composeMoaPrompt(prompt, buildResumeHistoryFromPanel(panel))`
// 把面板历史拼进本轮 prompt（见 session-service.ts:1112-1133 P0 #1 续聊注入块）。会诊 moa-agg-*
// 的 shape 已在上方 buildResumeHistoryFromPanel 用例覆盖；此处补 T7 要保护的不变量：
// 「面板有 MoA 历史（会诊 moa-agg-* / 研讨 moa-disc-agg-*）→ 续聊 prompt 含历史，且本轮 user 排除」。
// 用 `injectedPrompt` 复刻该管线（不实例化 SessionService，避免 IPC/adapter/runtime 重依赖）。

describe('续聊注入管线（复刻 session-service.handleSend P0 #1 / T7）', () => {
  // 复刻 handleSend 注入管线：historyText = buildResumeHistoryFromPanel(panel)（末条=本轮 user，excludeTrailingTurn 排除）；
  // prompt = composeMoaPrompt(本轮议题, historyText)（非空历史 → [会话上下文]…\n\n[本轮议题]\n<议题>）。
  function injectedPrompt(panel: unknown[], currentPrompt: string): string {
    return composeMoaPrompt(currentPrompt, buildResumeHistoryFromPanel(panel))
  }

  it('面板有会诊历史 → 续聊 prompt 含会诊结论且排除本轮 user', () => {
    // 场景（AUDIT session-1786259684183）：会诊为首条 → 落盘 [user, moa-agg assistant]；续聊落盘本轮 user
    const panel = [
      sdkUserMsg('研究一下 hermes-studio'),
      sdkMoAggAssistantMsg('汇总结论：1. 第一要点 2. 第二要点', 'moa-agg-moa-rt-sess-1-0'),
      sdkUserMsg('刚才结论里第 1 点是什么'), // 本轮 user（末条）→ 排除
    ]
    const prompt = injectedPrompt(panel, '刚才结论里第 1 点是什么')
    // 历史块进入 prompt
    expect(prompt).toContain('[会话上下文]')
    expect(prompt).toContain('[用户] 研究一下 hermes-studio')
    expect(prompt).toContain('[助手] 汇总结论：1. 第一要点 2. 第二要点')
    // 本轮议题段
    expect(prompt).toContain('[本轮议题]')
    expect(prompt.endsWith('刚才结论里第 1 点是什么')).toBe(true)
    // 本轮 user 不作为历史 [用户] 项重复（仅出现在 [本轮议题]）
    expect(prompt).not.toContain('[用户] 刚才结论里第 1 点是什么')
  })

  it('面板有圆桌讨论历史 → 续聊 prompt 含共识且排除本轮 user', () => {
    const discussionId = 'moa-disc-sess-1-0'
    const consensus = '共识方案：分两步实施。'
    const panel = [
      sdkUserMsg('如何拆分模块？请给方案'),
      sdkMoAggAssistantMsg(consensus, moaDiscussionConsensusUuid(discussionId)),
      sdkUserMsg('第二步具体怎么做'), // 本轮 user（末条）→ 排除
    ]
    const prompt = injectedPrompt(panel, '第二步具体怎么做')
    expect(prompt).toContain('[会话上下文]')
    expect(prompt).toContain('[用户] 如何拆分模块？请给方案')
    expect(prompt).toContain(`[助手] ${consensus}`)
    expect(prompt).toContain('[本轮议题]')
    expect(prompt.endsWith('第二步具体怎么做')).toBe(true)
    expect(prompt).not.toContain('[用户] 第二步具体怎么做')
  })

  it('空面板 / 仅本轮 user → buildResumeHistoryFromPanel 返回空 → prompt 不变（新会话首条无副作用）', () => {
    // 复刻 handleSend：historyText 为空时 composeMoaPrompt 直接返回原 prompt，不改写
    expect(buildResumeHistoryFromPanel([])).toBe('')
    expect(buildResumeHistoryFromPanel([sdkUserMsg('首条问题')])).toBe('')
    expect(injectedPrompt([], '首条问题')).toBe('首条问题')
    expect(injectedPrompt([sdkUserMsg('首条问题')], '首条问题')).toBe('首条问题')
  })

  it('MoA 轮夹在普通轮之间 → 重启后续聊注入全部历史（会诊结论 + 普通轮），排除本轮 user', () => {
    // 场景：会诊 → 普通轮 → [重启 / 进程重建] → 续聊。面板含会诊 + 普通 assistant；
    // 新进程零上文靠注入补全，历史应同时含会诊结论与普通轮（解析器按 shape 不分 moa-agg / 普通 uuid）。
    const panel = [
      sdkUserMsg('会诊议题'),
      sdkMoAggAssistantMsg('会诊结论', 'moa-agg-rt-1'),
      sdkUserMsg('普通追问'),
      sdkMoAggAssistantMsg('普通回答', 'uuid-normal-1'),
      sdkUserMsg('再追问'), // 本轮 user（末条）→ 排除
    ]
    const prompt = injectedPrompt(panel, '再追问')
    expect(prompt).toContain('[助手] 会诊结论')
    expect(prompt).toContain('[用户] 普通追问')
    expect(prompt).toContain('[助手] 普通回答')
    expect(prompt.endsWith('再追问')).toBe(true)
    expect(prompt).not.toContain('[用户] 再追问')
  })
})

// ===== T7 · extractMoAConclusionFromMessages（圆桌结论提取纯函数） =====
//
// T7 夹中场景「普通轮 → 圆桌（快速/研讨）→ 续聊」：长驻进程内存上下文不含 MoA bare 轮共识，
// 续聊时需从面板 IR 提取上一轮圆桌结论前置进 prompt。纯函数只认 assistant + uuid 前缀
// （moa-agg-* 会诊 / moa-disc-agg-* 研讨），普通 assistant 不混入。

describe('extractMoAConclusionFromMessages (T7)', () => {
  /** IR assistant（带 uuid，模拟 sdkMessageToIR 透传后的形态） */
  function irAssistant(text: string, uuid?: string): TAgentMessage {
    return {
      type: 'assistant',
      createdAt: 0,
      uuid,
      content: [{ type: 'text', text }],
    }
  }

  it('提取会诊共识（moa-agg-* uuid）', () => {
    const irs = [
      userMsg('研究一下 hermes-studio'),
      irAssistant('汇总结论：1. 要点A 2. 要点B', 'moa-agg-moa-rt-sess-1-0'),
    ]
    const out = extractMoAConclusionFromMessages(irs)
    expect(out).toContain('【上一轮圆桌结论】')
    expect(out).toContain('- 汇总结论：1. 要点A 2. 要点B')
  })

  it('提取研讨共识（moa-disc-agg-* uuid）', () => {
    const irs = [
      userMsg('如何拆分模块'),
      irAssistant('共识方案：分两步实施', 'moa-disc-agg-moa-disc-sess-1-0'),
    ]
    const out = extractMoAConclusionFromMessages(irs)
    expect(out).toContain('【上一轮圆桌结论】')
    expect(out).toContain('- 共识方案：分两步实施')
  })

  it('普通 assistant（无 moa-agg / moa-disc-agg uuid）不提取', () => {
    const irs = [
      userMsg('普通问题'),
      irAssistant('普通回答', 'uuid-normal-1'),
      irAssistant('无 uuid 的回答'), // 无 uuid
    ]
    expect(extractMoAConclusionFromMessages(irs)).toBe('')
  })

  it('空输入 / 仅 user → 返回空串（不污染 prompt）', () => {
    expect(extractMoAConclusionFromMessages([])).toBe('')
    expect(extractMoAConclusionFromMessages([userMsg('只有 user')])).toBe('')
  })

  it('多条 MoA 结论按面板顺序各成一段', () => {
    const irs = [
      userMsg('议题1'),
      irAssistant('结论1', 'moa-agg-rt-1'),
      userMsg('议题2'),
      irAssistant('结论2', 'moa-disc-agg-disc-2'),
    ]
    const out = extractMoAConclusionFromMessages(irs)
    expect(out).toContain('- 结论1')
    expect(out).toContain('- 结论2')
    expect(out.indexOf('- 结论1')).toBeLessThan(out.indexOf('- 结论2'))
  })

  it('user 消息不匹配（即使 uuid 巧合 moa 前缀也不当结论提取）—— 排除本轮刚落盘的 user', () => {
    const irs: TAgentMessage[] = [
      {
        type: 'user',
        createdAt: 0,
        uuid: 'moa-agg-fake',
        content: [{ type: 'text', text: '不该被当结论提取' }],
      },
    ]
    expect(extractMoAConclusionFromMessages(irs)).toBe('')
  })
})

// ===== T7 · 夹中场景注入管线（复刻 session-service.handleSend LIVE/RESTART 分支） =====
//
// 复刻 handleSend T7 注入分支（session-service.ts:1112-1151）：
//   - hasMoAConclusion = extractMoAConclusionFromMessages(IR) !== ''
//   - LIVE（hasMoAConclusion && hasActiveChannel）→ 仅前置 conclusionText，不注入全量历史、不抑制 resume
//   - RESTART/无进程（hasMoAConclusion && !hasActiveChannel）→ composeMoaPrompt(historyText) + suppressResume
//   - 无 MoA → 原 P0#1（isFirst && !sdkSessionId && !hasActiveChannel → 注入 historyText），其余保持现状
// 不实例化 SessionService（避免 IPC/adapter/runtime 重依赖），只断言 prompt 改写 + suppressResume。

describe('T7 夹中场景注入（复刻 session-service.handleSend LIVE/RESTART 分支）', () => {
  function t7Inject(
    panel: unknown[],
    currentPrompt: string,
    opts: { hasActiveChannel: boolean; isFirst: boolean; sdkSessionId?: string },
  ): { prompt: string; suppressResume: boolean } {
    const irs: TAgentMessage[] = []
    for (const raw of panel) {
      const ir = panelMessageToHistoryIR(raw)
      if (ir) irs.push(ir)
    }
    const conclusionText = extractMoAConclusionFromMessages(irs)
    const historyText = buildResumeHistoryFromPanel(panel)
    const hasMoAConclusion = conclusionText !== ''
    let prompt = currentPrompt
    let suppressResume = false
    if (hasMoAConclusion) {
      if (opts.hasActiveChannel) {
        prompt = `${conclusionText}\n\n${prompt}`
      } else if (historyText) {
        prompt = composeMoaPrompt(prompt, historyText)
        suppressResume = true
      }
    } else if (opts.isFirst && !opts.sdkSessionId && !opts.hasActiveChannel) {
      if (historyText) {
        prompt = composeMoaPrompt(prompt, historyText)
      }
    }
    return { prompt, suppressResume }
  }

  it('① LIVE 有 MoA → prompt 仅前置结论片段（不注入全量历史、不抑制 resume）', () => {
    // 场景：会诊为首条 → 随后普通续聊，kscc live 进程已在跑（hasActiveChannel=true，isFirst=false enqueue）
    const panel = [
      sdkUserMsg('研究一下 hermes-studio'),
      sdkMoAggAssistantMsg('汇总结论：1. 第一要点 2. 第二要点', 'moa-agg-moa-rt-sess-1-0'),
      sdkUserMsg('刚才结论里第 1 点是什么'), // 本轮 user（末条）
    ]
    const { prompt, suppressResume } = t7Inject(panel, '刚才结论里第 1 点是什么', {
      hasActiveChannel: true,
      isFirst: false,
    })
    // 前置了结论片段
    expect(prompt).toContain('【上一轮圆桌结论】')
    expect(prompt).toContain('- 汇总结论：1. 第一要点 2. 第二要点')
    // 本轮议题保留在末尾
    expect(prompt.endsWith('刚才结论里第 1 点是什么')).toBe(true)
    // LIVE 不注入全量历史（不含 [会话上下文] / [本轮议题] 段）
    expect(prompt).not.toContain('[会话上下文]')
    expect(prompt).not.toContain('[本轮议题]')
    // LIVE 不抑制 resume
    expect(suppressResume).toBe(false)
  })

  it('① LIVE 研讨共识（moa-disc-agg-*）同样仅前置结论', () => {
    const discussionId = 'moa-disc-sess-1-0'
    const panel = [
      sdkUserMsg('如何拆分模块？请给方案'),
      sdkMoAggAssistantMsg('共识方案：分两步实施。', moaDiscussionConsensusUuid(discussionId)),
      sdkUserMsg('第二步具体怎么做'), // 本轮 user（末条）
    ]
    const { prompt, suppressResume } = t7Inject(panel, '第二步具体怎么做', {
      hasActiveChannel: true,
      isFirst: false,
    })
    expect(prompt).toContain('【上一轮圆桌结论】')
    expect(prompt).toContain('- 共识方案：分两步实施。')
    expect(prompt.endsWith('第二步具体怎么做')).toBe(true)
    expect(prompt).not.toContain('[会话上下文]')
    expect(suppressResume).toBe(false)
  })

  it('② RESTART 有 MoA → 走注入路径（全量历史），即使有 sdkSessionId 也抑制 resume', () => {
    // 场景：会诊 → [重启 / 进程重建] → 续聊。无活跃进程（hasActiveChannel=false，isFirst=true spawn），
    // 有 sdkSessionId（kscc 重启可 resume）但 resume 文件只含普通轮、不含 MoA → 忽略 resume 走注入。
    const panel = [
      sdkUserMsg('研究一下 hermes-studio'),
      sdkMoAggAssistantMsg('汇总结论：1. 第一要点', 'moa-agg-moa-rt-sess-1-0'),
      sdkUserMsg('刚才结论里第 1 点是什么'), // 本轮 user（末条）
    ]
    const { prompt, suppressResume } = t7Inject(panel, '刚才结论里第 1 点是什么', {
      hasActiveChannel: false,
      isFirst: true,
      sdkSessionId: 'kscc-sess-123',
    })
    // 走注入路径：含全量历史块（[会话上下文] + 会诊结论 + [本轮议题]）
    expect(prompt).toContain('[会话上下文]')
    expect(prompt).toContain('[助手] 汇总结论：1. 第一要点')
    expect(prompt).toContain('[本轮议题]')
    expect(prompt.endsWith('刚才结论里第 1 点是什么')).toBe(true)
    // 本轮 user 排除（不作为历史 [用户] 项）
    expect(prompt).not.toContain('[用户] 刚才结论里第 1 点是什么')
    // RESTART 抑制 resume（即便有 sdkSessionId）
    expect(suppressResume).toBe(true)
  })

  it('② RESTART 无 MoA 但有 sdkSessionId → 保持现状走 resume（不注入、不抑制）', () => {
    // 无 MoA：面板仅普通轮，有 sdkSessionId → resume 读普通轮即可，无需注入
    const panel = [
      sdkUserMsg('普通问题'),
      sdkMoAggAssistantMsg('普通回答', 'uuid-normal-1'),
      sdkUserMsg('再追问'), // 本轮 user（末条）
    ]
    const { prompt, suppressResume } = t7Inject(panel, '再追问', {
      hasActiveChannel: false,
      isFirst: true,
      sdkSessionId: 'kscc-sess-456',
    })
    // 有 sdkSessionId 且无 MoA → 不注入（保持现状走 resume）
    expect(prompt).toBe('再追问')
    expect(suppressResume).toBe(false)
  })

  it('③ 无 MoA 且无 sdkSessionId 无活跃进程 → 原 P0#1 注入（行为不变、不抑制 resume）', () => {
    const panel = [
      sdkUserMsg('普通问题'),
      sdkMoAggAssistantMsg('普通回答', 'uuid-normal-1'),
      sdkUserMsg('再追问'), // 本轮 user（末条）
    ]
    const { prompt, suppressResume } = t7Inject(panel, '再追问', {
      hasActiveChannel: false,
      isFirst: true,
      // 无 sdkSessionId
    })
    // 原 P0#1：注入全量历史
    expect(prompt).toContain('[会话上下文]')
    expect(prompt).toContain('[助手] 普通回答')
    expect(prompt.endsWith('再追问')).toBe(true)
    // 无 MoA → 不抑制 resume
    expect(suppressResume).toBe(false)
  })

  it('③ 无 MoA 且有活跃进程 → 不注入（内存已有普通轮上下文）', () => {
    const panel = [
      sdkUserMsg('普通问题'),
      sdkMoAggAssistantMsg('普通回答', 'uuid-normal-1'),
      sdkUserMsg('再追问'),
    ]
    const { prompt, suppressResume } = t7Inject(panel, '再追问', {
      hasActiveChannel: true,
      isFirst: false,
    })
    // 活跃进程 + 无 MoA → 不注入（内存已有上文）
    expect(prompt).toBe('再追问')
    expect(suppressResume).toBe(false)
  })

  it('夹中场景（普通轮 → 会诊 → 续聊）LIVE：仅会诊结论被前置，普通轮不重复进 prompt', () => {
    // 完整夹中：普通轮 → 会诊 → 续聊（live）。live 进程内存已有普通轮，LIVE 只补会诊结论。
    const panel = [
      sdkUserMsg('先聊个普通问题'),
      sdkMoAggAssistantMsg('普通回答', 'uuid-normal-0'),
      sdkUserMsg('发起会诊'),
      sdkMoAggAssistantMsg('会诊结论：方案 A', 'moa-agg-moa-rt-sess-9-0'),
      sdkUserMsg('按方案 A 第 1 步怎么做'), // 本轮 user（末条）
    ]
    const { prompt, suppressResume } = t7Inject(panel, '按方案 A 第 1 步怎么做', {
      hasActiveChannel: true,
      isFirst: false,
    })
    // 会诊结论被前置
    expect(prompt).toContain('【上一轮圆桌结论】')
    expect(prompt).toContain('- 会诊结论：方案 A')
    // 普通轮不进 LIVE prompt（避免与 live 进程内存普通轮重复）
    expect(prompt).not.toContain('[会话上下文]')
    expect(prompt).not.toContain('普通回答')
    expect(prompt.endsWith('按方案 A 第 1 步怎么做')).toBe(true)
    expect(suppressResume).toBe(false)
  })
})