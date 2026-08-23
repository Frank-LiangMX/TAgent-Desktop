import { describe, expect, test } from 'vitest'
import {
  BRIDGE_CHARS_PER_TOKEN,
  ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS,
  ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS,
  SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS,
  SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS,
  SOURCE_EXCERPT_PER_CALL_DEFAULT_TOKENS,
  SOURCE_EXCERPT_PER_CALL_HARD_MAX_TOKENS,
  SOURCE_EXCERPT_PER_TURN_HARD_MAX_TOKENS,
  buildRoomToSessionHandoff,
  buildSessionToRoomBrief,
  clampBridgeText,
  estimateBridgeTokenCount,
  formatRoomToSessionHandoffForPrompt,
  formatSessionToRoomBriefForPrompt,
  tokensToCharBudget,
  validateSourceExcerptBudget,
} from './session-collab-bridge'
import type { RoomToSessionHandoff, SessionToRoomBrief } from './session-collab-bridge'

describe('预算常量（须与 14 规格表 §2 一致）', () => {
  test('字符换算系数与各档默认/硬顶', () => {
    expect(BRIDGE_CHARS_PER_TOKEN).toBe(1.2)
    expect(SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS).toBe(3000)
    expect(SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS).toBe(8000)
    expect(ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS).toBe(2000)
    expect(ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS).toBe(6000)
    expect(SOURCE_EXCERPT_PER_CALL_DEFAULT_TOKENS).toBe(1500)
    expect(SOURCE_EXCERPT_PER_CALL_HARD_MAX_TOKENS).toBe(2000)
    expect(SOURCE_EXCERPT_PER_TURN_HARD_MAX_TOKENS).toBe(4000)
  })
})

describe('tokensToCharBudget / estimateBridgeTokenCount（14 §2 字符近似）', () => {
  test('tokens → 字符硬顶（floor，偏保守）', () => {
    expect(tokensToCharBudget(3000)).toBe(3600)
    expect(tokensToCharBudget(8000)).toBe(9600)
    expect(tokensToCharBudget(2000)).toBe(2400)
    expect(tokensToCharBudget(6000)).toBe(7200)
  })

  test('非正/非有限 → 0', () => {
    expect(tokensToCharBudget(0)).toBe(0)
    expect(tokensToCharBudget(-5)).toBe(0)
    expect(tokensToCharBudget(Number.POSITIVE_INFINITY)).toBe(0)
    expect(tokensToCharBudget(Number.NaN)).toBe(0)
  })

  test('字符 → token 估算（ceil，偏保守）', () => {
    expect(estimateBridgeTokenCount('')).toBe(0)
    expect(estimateBridgeTokenCount('x'.repeat(3600))).toBe(3000)
    expect(estimateBridgeTokenCount('x'.repeat(2400))).toBe(2000)
  })

  test('审计不变式：text.length ≤ tokensToCharBudget(t) ⇒ estimate ≤ t', () => {
    for (const t of [1000, 2000, 3000, 6000, 8000]) {
      const chars = tokensToCharBudget(t)
      expect(estimateBridgeTokenCount('x'.repeat(chars))).toBeLessThanOrEqual(t)
    }
  })
})

describe('clampBridgeText（按字符硬顶裁剪 + 段落边界）', () => {
  test('预算内：原样返回，truncated=false', () => {
    const r = clampBridgeText('hello', 1000)
    expect(r).toEqual({ text: 'hello', tokenEstimate: estimateBridgeTokenCount('hello'), charCount: 5, truncated: false })
  })

  test('超预算且无段落边界：硬切到字符硬顶', () => {
    const r = clampBridgeText('A'.repeat(200), 50)
    expect(r.truncated).toBe(true)
    expect(r.charCount).toBe(tokensToCharBudget(50))
    expect(r.text).toBe('A'.repeat(tokensToCharBudget(50)))
  })

  test('超预算且命中段落边界：截到最近 \\n\\n（保留完整段落）', () => {
    const text = 'A'.repeat(30) + '\n\n' + 'B'.repeat(100)
    const r = clampBridgeText(text, 50) // charBudget=60，切在第二段中
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('A'.repeat(30))
    expect(r.charCount).toBe(30)
  })

  test('空输入：不截断、计数为 0', () => {
    const r = clampBridgeText('', 1000)
    expect(r).toEqual({ text: '', tokenEstimate: 0, charCount: 0, truncated: false })
  })

  test('maxTokens 非正：charBudget=0，截到空', () => {
    const r = clampBridgeText('hello', 0)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('')
    expect(r.charCount).toBe(0)
    expect(clampBridgeText('hello', -5).text).toBe('')
  })
})

describe('buildSessionToRoomBrief（默认档 / 硬顶 / 空输入 / 优先级裁剪）', () => {
  test('默认档 3000 token：中等内容不裁剪（证默认不是更小档）', () => {
    const brief = buildSessionToRoomBrief({
      goal: 'G'.repeat(3000),
      decisions: ['d'.repeat(400)],
      openQuestions: [],
      todos: [],
      artifacts: [],
      sourceSessionId: 'sess_a',
    })
    expect(brief.goal).toBe('G'.repeat(3000)) // 未截断 ⇒ 预算 ≥ 3000 token
    expect(brief.decisions).toHaveLength(1)
    expect(brief.tokenEstimate).toBeLessThanOrEqual(SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS)
    expect(brief.charCount).toBeLessThanOrEqual(tokensToCharBudget(SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS))
  })

  test('budgetTokens 超过 HARD_MAX 钳到 HARD_MAX（8000）', () => {
    const brief = buildSessionToRoomBrief({
      goal: 'G'.repeat(20000),
      decisions: [],
      openQuestions: [],
      todos: [],
      artifacts: [],
      sourceSessionId: '',
      budgetTokens: 999_999,
    })
    expect(brief.charCount).toBe(tokensToCharBudget(SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS))
    expect(brief.tokenEstimate).toBe(SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS)
    expect(brief.goal.length).toBeLessThan(20000) // 被裁
    expect(brief.sourceSessionId).toBe('') // goal 吃光预算 ⇒ 指针被挤掉
  })

  test('空输入：全字段空、审计为 0', () => {
    const brief = buildSessionToRoomBrief({
      goal: '',
      decisions: [],
      openQuestions: [],
      todos: [],
      artifacts: [],
      sourceSessionId: '',
    })
    expect(brief.goal).toBe('')
    expect(brief.sourceSessionId).toBe('')
    expect(brief.decisions).toEqual([])
    expect(brief.narrative).toBeUndefined()
    expect(brief.charCount).toBe(0)
    expect(brief.tokenEstimate).toBe(0)
    expect(formatSessionToRoomBriefForPrompt(brief)).toBe('')
  })

  test('优先级裁剪：budgetTokens=29 时保 goal/sourceSessionId/decisions，丢 narrative', () => {
    const brief = buildSessionToRoomBrief({
      goal: 'G',
      decisions: ['d'],
      openQuestions: [],
      todos: [],
      artifacts: [],
      sourceSessionId: 's',
      narrative: 'N'.repeat(5000),
      budgetTokens: 29,
    })
    expect(brief.goal).toBe('G')
    expect(brief.sourceSessionId).toBe('s')
    expect(brief.decisions).toEqual(['d'])
    expect(brief.narrative).toBeUndefined()
    const formatted = formatSessionToRoomBriefForPrompt(brief)
    expect(formatted).toContain('## 目标')
    expect(formatted).toContain('## 来源会话')
    expect(formatted).toContain('## 已确认决定')
    expect(formatted).not.toContain('## 补充说明')
    expect(brief.charCount).toBe(formatted.length)
    expect(brief.tokenEstimate).toBeLessThanOrEqual(29)
  })

  test('列表超预算：按完整条目边界裁剪（不截半条）', () => {
    const item = (c: string) => c.repeat(50)
    const brief = buildSessionToRoomBrief({
      goal: 'G',
      decisions: [item('A'), item('B'), item('C')],
      openQuestions: [],
      todos: [],
      artifacts: [],
      sourceSessionId: 's',
      budgetTokens: 125, // charBudget=150，只够前两条
    })
    expect(brief.decisions.length).toBeLessThan(3) // 发生裁剪
    expect(brief.decisions.length).toBeGreaterThanOrEqual(1)
    for (const d of brief.decisions) {
      expect(d.length).toBe(50) // 保留的都是完整条目，非半截
    }
    expect(brief.decisions.some((d) => d.startsWith('C'))).toBe(false) // 第三条整条丢弃
  })
})

describe('formatSessionToRoomBriefForPrompt（稳定中文标题模板 + 硬顶 clamp）', () => {
  test('稳定模板：标题顺序与字段一致', () => {
    const brief = buildSessionToRoomBrief({
      goal: 'G',
      decisions: ['d'],
      openQuestions: [],
      todos: [],
      artifacts: [],
      sourceSessionId: 's',
      budgetTokens: 29, // 同上：丢 narrative 的极简 brief
    })
    // 锁定模板格式（中文标题 + 块间 \n\n + 列表 "- "）
    expect(formatSessionToRoomBriefForPrompt(brief)).toBe(
      '## 目标\nG\n\n## 来源会话\ns\n\n## 已确认决定\n- d',
    )
    expect(brief.charCount).toBe(32)
    expect(brief.tokenEstimate).toBe(27)
  })

  test('绕过 build 的巨大 brief：format 再过一次 HARD_MAX clamp', () => {
    const huge: SessionToRoomBrief = {
      goal: 'G'.repeat(20000),
      decisions: [],
      openQuestions: [],
      todos: [],
      artifacts: [],
      sourceSessionId: '',
      narrative: undefined,
      tokenEstimate: 0,
      charCount: 0,
    }
    const out = formatSessionToRoomBriefForPrompt(huge)
    expect(out.length).toBe(tokensToCharBudget(SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS))
    expect(out.startsWith('## 目标')).toBe(true)
  })
})

describe('buildRoomToSessionHandoff / format（对称、默认更紧 2000）', () => {
  test('默认档 2000 token：小内容全保留', () => {
    const handoff = buildRoomToSessionHandoff({
      outcomes: ['o1'],
      changes: ['c1'],
      risks: ['r1'],
      roomId: 'room_1',
      sourceSessionId: 'sess_1',
    })
    expect(handoff.outcomes).toEqual(['o1'])
    expect(handoff.changes).toEqual(['c1'])
    expect(handoff.risks).toEqual(['r1'])
    expect(handoff.roomId).toBe('room_1')
    expect(handoff.sourceSessionId).toBe('sess_1')
    expect(handoff.tokenEstimate).toBeLessThanOrEqual(ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS)
    expect(handoff.charCount).toBeLessThanOrEqual(tokensToCharBudget(ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS))
  })

  test('默认更紧：3×1000 条 outcomes 在 2000 档下只保前 2 条', () => {
    const handoff = buildRoomToSessionHandoff({
      outcomes: ['O'.repeat(1000), 'O'.repeat(1000), 'O'.repeat(1000)],
      changes: [],
      risks: [],
      roomId: '',
      sourceSessionId: '',
    })
    expect(handoff.outcomes.length).toBe(2) // 2000 档（2400 字符）⇒ 截掉第 3 条
    expect(handoff.charCount).toBeLessThanOrEqual(tokensToCharBudget(ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS))
  })

  test('budgetTokens 超过 HARD_MAX 钳到 6000：outcomes 被裁、charCount ≤ 7200', () => {
    const handoff = buildRoomToSessionHandoff({
      outcomes: Array.from({ length: 10 }, () => 'O'.repeat(2000)),
      changes: [],
      risks: [],
      roomId: '',
      sourceSessionId: '',
      budgetTokens: 999_999,
    })
    expect(handoff.outcomes.length).toBe(3) // 6000 档（7200 字符）⇒ 保 3 条；若误用 8000 档会保 4 条
    expect(handoff.charCount).toBeLessThanOrEqual(tokensToCharBudget(ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS))
  })

  test('优先级裁剪：保 outcomes/roomId/sourceSessionId，丢 narrative', () => {
    const handoff = buildRoomToSessionHandoff({
      outcomes: ['o'],
      changes: [],
      risks: [],
      roomId: 'r',
      sourceSessionId: 's',
      narrative: 'N'.repeat(5000),
      budgetTokens: 34, // charBudget=40，够前三块不够 narrative
    })
    expect(handoff.outcomes).toEqual(['o'])
    expect(handoff.roomId).toBe('r')
    expect(handoff.sourceSessionId).toBe('s')
    expect(handoff.narrative).toBeUndefined()
    const formatted = formatRoomToSessionHandoffForPrompt(handoff)
    expect(formatted).toContain('## 协作结论')
    expect(formatted).toContain('## 来源房间')
    expect(formatted).toContain('## 来源会话')
    expect(formatted).not.toContain('## 补充说明')
  })

  test('format 稳定标题 + 巨大 handoff 走 HARD_MAX clamp', () => {
    const full = buildRoomToSessionHandoff({
      outcomes: ['o1'],
      changes: ['c1'],
      risks: ['r1'],
      roomId: 'room_1',
      sourceSessionId: 'sess_1',
    })
    const out = formatRoomToSessionHandoffForPrompt(full)
    expect(out).toContain('## 协作结论')
    expect(out).toContain('## 来源房间')
    expect(out).toContain('## 来源会话')
    expect(out).toContain('## 变更')
    expect(out).toContain('## 风险与未完')

    const huge: RoomToSessionHandoff = {
      outcomes: ['O'.repeat(20000)],
      changes: [],
      risks: [],
      roomId: '',
      sourceSessionId: '',
      narrative: undefined,
      tokenEstimate: 0,
      charCount: 0,
    }
    const clamped = formatRoomToSessionHandoffForPrompt(huge)
    expect(clamped.length).toBe(tokensToCharBudget(ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS))
    expect(clamped.startsWith('## 协作结论')).toBe(true)
  })
})

describe('validateSourceExcerptBudget（单次/单轮硬顶校验）', () => {
  test('缺省请求 → PER_CALL 默认 1500，ok', () => {
    expect(validateSourceExcerptBudget(undefined, 0)).toEqual({ ok: true, allowedTokens: 1500 })
  })

  test('请求超过 PER_CALL hard → 钳到 2000，仍 ok', () => {
    expect(validateSourceExcerptBudget(5000, 0)).toEqual({ ok: true, allowedTokens: 2000 })
    expect(validateSourceExcerptBudget(2000, 0)).toEqual({ ok: true, allowedTokens: 2000 })
  })

  test('单轮剩余 < 请求 → 按剩余给量', () => {
    expect(validateSourceExcerptBudget(1000, 3500)).toEqual({ ok: true, allowedTokens: 500 })
    expect(validateSourceExcerptBudget(200, 3900)).toEqual({ ok: true, allowedTokens: 100 })
    expect(validateSourceExcerptBudget(1500, 2600)).toEqual({ ok: true, allowedTokens: 1400 })
  })

  test('单轮累计已耗尽 → ok:false per-turn-budget-exhausted', () => {
    expect(validateSourceExcerptBudget(1000, 4000)).toEqual({
      ok: false,
      reason: 'per-turn-budget-exhausted',
    })
    expect(validateSourceExcerptBudget(500, 5000)).toEqual({
      ok: false,
      reason: 'per-turn-budget-exhausted',
    })
  })

  test('请求非正 → ok:false requested-non-positive', () => {
    expect(validateSourceExcerptBudget(0, 0)).toEqual({ ok: false, reason: 'requested-non-positive' })
    expect(validateSourceExcerptBudget(-10, 0)).toEqual({ ok: false, reason: 'requested-non-positive' })
  })
})
