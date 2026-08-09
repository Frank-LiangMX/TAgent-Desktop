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
  extractMoATurnText,
  panelMessageToHistoryIR,
} from './moa-history'

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
})