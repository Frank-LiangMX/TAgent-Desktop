import { describe, expect, it } from 'vitest'
import {
  appendDiscussionEntry,
  beginNextRound,
  clearDiscussionRunningSummary,
  createMoADiscussionPanel,
  evaluateDiscussionConvergence,
  finalizeMoADiscussion,
  markMoADiscussionCancelled,
  MOA_DISCUSSION_MODERATOR_SPEAKER_ID,
  MOA_DISCUSSION_USER_SPEAKER_ID,
  setMoADiscussionPhase,
  updateDiscussionRunningSummary,
} from './moa-discussion'
import type { MoADiscussionPanel, MoADiscussionSpeaker } from './moa-discussion'

const SEED = {
  discussionId: 'moa-disc-1',
  presetName: '深度圆桌',
  topic: '如何拆分模块？',
  participants: [
    { speakerId: 'p-arch', name: '架构师', modelId: 'glm-5.2' },
    { speakerId: 'p-prag', name: '实战派', modelId: 'kimi-k2.5' },
  ],
  roundLimit: 3,
}

function findSpeaker(panel: MoADiscussionPanel, id: string): MoADiscussionSpeaker | undefined {
  return panel.speakers.find((s) => s.speakerId === id)
}

describe('createMoADiscussionPanel', () => {
  it('组装初始 panel：phase=discussing，currentRound=0，自动追加 user + moderator 席', () => {
    const panel = createMoADiscussionPanel(SEED)
    expect(panel.kind).toBe('moa_discussion')
    expect(panel.discussionId).toBe(SEED.discussionId)
    expect(panel.presetName).toBe(SEED.presetName)
    expect(panel.topic).toBe(SEED.topic)
    expect(panel.phase).toBe('discussing')
    expect(panel.currentRound).toBe(0)
    expect(panel.entries).toHaveLength(0)
    expect(panel.summary).toBeUndefined()
    expect(panel.roundLimit).toBe(SEED.roundLimit)

    // participants 全部保留且 role='participant'
    expect(panel.speakers).toHaveLength(SEED.participants.length + 2)
    const arch = findSpeaker(panel, 'p-arch')
    const prag = findSpeaker(panel, 'p-prag')
    expect(arch?.role).toBe('participant')
    expect(arch?.modelId).toBe('glm-5.2')
    expect(prag?.role).toBe('participant')

    // 自动追加的 user 席
    const userSeat = findSpeaker(panel, MOA_DISCUSSION_USER_SPEAKER_ID)
    expect(userSeat).toBeDefined()
    expect(userSeat?.role).toBe('user')
    expect(userSeat?.name).toBe('你')

    // 自动追加的 moderator（总结人）席
    const modSeat = findSpeaker(panel, MOA_DISCUSSION_MODERATOR_SPEAKER_ID)
    expect(modSeat).toBeDefined()
    expect(modSeat?.role).toBe('moderator')
    expect(modSeat?.name).toBe('总结人')
  })

  it('roundLimit < 1 时归一化为 1；非整数向下取整', () => {
    const p1 = createMoADiscussionPanel({ ...SEED, roundLimit: 0 })
    expect(p1.roundLimit).toBe(1)
    const p2 = createMoADiscussionPanel({ ...SEED, roundLimit: -5 })
    expect(p2.roundLimit).toBe(1)
    const p3 = createMoADiscussionPanel({ ...SEED, roundLimit: 4.9 })
    expect(p3.roundLimit).toBe(4)
  })

  it('空 participants 列表也保证 user + moderator 席存在', () => {
    const panel = createMoADiscussionPanel({ ...SEED, participants: [] })
    expect(panel.speakers).toHaveLength(2)
    expect(findSpeaker(panel, MOA_DISCUSSION_USER_SPEAKER_ID)).toBeDefined()
    expect(findSpeaker(panel, MOA_DISCUSSION_MODERATOR_SPEAKER_ID)).toBeDefined()
  })
})

describe('appendDiscussionEntry', () => {
  it('追加一条发言：不自动推进 round，turn 默认按 currentRound', () => {
    const panel = createMoADiscussionPanel(SEED)
    const t0 = 1_700_000_000_000
    const p1 = appendDiscussionEntry(panel, {
      speakerId: 'p-arch',
      text: '先看边界',
      createdAt: t0,
    })
    expect(p1.entries).toHaveLength(1)
    expect(p1.entries[0]?.speakerId).toBe('p-arch')
    expect(p1.entries[0]?.text).toBe('先看边界')
    expect(p1.entries[0]?.turn).toBe(0) // 当前轮
    expect(p1.entries[0]?.createdAt).toBe(t0)
    expect(p1.entries[0]?.entryId).toBe(`${panel.discussionId}:0`)
    expect(p1.currentRound).toBe(0) // 不推进
    expect(p1.phase).toBe('discussing')
  })

  it('连续追加多条，entryId 单调递增，turn 默认按当时 currentRound', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'A', createdAt: 1 })
    panel = appendDiscussionEntry(panel, { speakerId: 'p-prag', text: 'B', createdAt: 2 })
    panel = appendDiscussionEntry(panel, { speakerId: MOA_DISCUSSION_USER_SPEAKER_ID, text: '我插一句', createdAt: 3 })
    expect(panel.entries.map((e) => e.entryId)).toEqual([
      `${SEED.discussionId}:0`,
      `${SEED.discussionId}:1`,
      `${SEED.discussionId}:2`,
    ])
    expect(panel.entries.map((e) => e.turn)).toEqual([0, 0, 0])
    expect(panel.entries.map((e) => e.speakerId)).toEqual(['p-arch', 'p-prag', 'user'])
  })

  it('显式传 turn 时按入参；不传 createdAt 时取当下时间', () => {
    const panel = createMoADiscussionPanel(SEED)
    const before = Date.now()
    const p1 = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'x', turn: 2 })
    const after = Date.now()
    expect(p1.entries[0]?.turn).toBe(2)
    expect(p1.entries[0]?.createdAt).toBeGreaterThanOrEqual(before)
    expect(p1.entries[0]?.createdAt).toBeLessThanOrEqual(after)
  })

  it('不修改原 panel（不可变）', () => {
    const panel = createMoADiscussionPanel(SEED)
    appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'x', createdAt: 1 })
    expect(panel.entries).toHaveLength(0)
  })
})

describe('beginNextRound 轮次上限触发 finalizing', () => {
  it('roundLimit=3：在 currentRound<3 时正常 +1；超过则进入 finalizing', () => {
    let panel = createMoADiscussionPanel(SEED) // roundLimit=3
    panel = beginNextRound(panel)
    expect(panel.currentRound).toBe(1)
    expect(panel.phase).toBe('discussing')
    panel = beginNextRound(panel)
    expect(panel.currentRound).toBe(2)
    expect(panel.phase).toBe('discussing')
    panel = beginNextRound(panel)
    expect(panel.currentRound).toBe(3)
    expect(panel.phase).toBe('discussing') // 达到上限但仍在「讨论中」（留一轮写）
    const over = beginNextRound(panel)
    expect(over.currentRound).toBe(3) // 不再加
    expect(over.phase).toBe('finalizing')
  })

  it('roundLimit=1：第一步正常 +1 到 currentRound=1，第二次 beginNextRound 才触发 finalizing', () => {
    const panel = createMoADiscussionPanel({ ...SEED, roundLimit: 1 })
    const first = beginNextRound(panel)
    expect(first.currentRound).toBe(1)
    expect(first.phase).toBe('discussing')
    const over = beginNextRound(first)
    expect(over.currentRound).toBe(1) // 不再加
    expect(over.phase).toBe('finalizing')
  })

  it('finalizing 后再 beginNextRound：currentRound 不变，phase 保持 finalizing（不再回退）', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = beginNextRound(panel)
    panel = beginNextRound(panel)
    panel = beginNextRound(panel)
    const finalizing = beginNextRound(panel)
    expect(finalizing.phase).toBe('finalizing')
    const again = beginNextRound(finalizing)
    expect(again.currentRound).toBe(finalizing.currentRound)
    expect(again.phase).toBe('finalizing')
  })
})

describe('setMoADiscussionPhase', () => {
  it('按入参改 phase，不改 entries / summary / roundLimit / currentRound', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'A', createdAt: 1 })
    const frozen = {
      speakers: panel.speakers,
      entries: panel.entries,
      roundLimit: panel.roundLimit,
      currentRound: panel.currentRound,
      summary: panel.summary,
    }
    const err = setMoADiscussionPhase(panel, 'error')
    expect(err.phase).toBe('error')
    expect(err.speakers).toBe(frozen.speakers)
    expect(err.entries).toBe(frozen.entries)
    expect(err.roundLimit).toBe(frozen.roundLimit)
    expect(err.currentRound).toBe(frozen.currentRound)
    expect(err.summary).toBe(frozen.summary)
  })
})

describe('finalizeMoADiscussion', () => {
  it('phase=done 且写入 summary', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'A', createdAt: 1 })
    panel = beginNextRound(panel)
    panel = appendDiscussionEntry(panel, { speakerId: 'p-prag', text: 'B', createdAt: 2 })
    const fin = beginNextRound(panel) // 触发 finalizing
    const done = finalizeMoADiscussion(fin, '共识：先抽接口再实现')
    expect(done.phase).toBe('done')
    expect(done.summary).toBe('共识：先抽接口再实现')
    // entries 保留
    expect(done.entries).toHaveLength(2)
  })
})

describe('markMoADiscussionCancelled', () => {
  it('phase=cancelled 且保留 entries 便于回放', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'A', createdAt: 1 })
    panel = appendDiscussionEntry(panel, { speakerId: MOA_DISCUSSION_USER_SPEAKER_ID, text: '停', createdAt: 2 })
    const cancelled = markMoADiscussionCancelled(panel)
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.entries).toHaveLength(2)
    expect(cancelled.summary).toBeUndefined()
  })

  it('终态后再 cancel 仍允许（覆盖 phase）', () => {
    const panel = createMoADiscussionPanel(SEED)
    const done = finalizeMoADiscussion(panel, '共识')
    expect(done.phase).toBe('done')
    const cancelled = markMoADiscussionCancelled(done)
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.summary).toBe('共识') // summary 保留
  })
})

// ---- 共享纪要（T11：updateDiscussionRunningSummary / clearDiscussionRunningSummary）----

describe('updateDiscussionRunningSummary', () => {
  it('写入 runningSummary：trim 后非空则覆盖', () => {
    const panel = createMoADiscussionPanel(SEED)
    const updated = updateDiscussionRunningSummary(panel, '## 当前目标\n- 拆模块\n收敛: 否')
    expect(updated.runningSummary).toBe('## 当前目标\n- 拆模块\n收敛: 否')
    // 原 panel 不变（不可变）
    expect(panel.runningSummary).toBeUndefined()
  })

  it('覆盖既有 runningSummary（滚动更新）', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = updateDiscussionRunningSummary(panel, '第一份纪要')
    expect(panel.runningSummary).toBe('第一份纪要')
    panel = updateDiscussionRunningSummary(panel, '第二份纪要')
    expect(panel.runningSummary).toBe('第二份纪要')
  })

  it('空文本 / 全空白 → 不写入，原样返回 panel（避免空纪要覆盖既有纪要）', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = updateDiscussionRunningSummary(panel, '既有纪要')
    expect(panel.runningSummary).toBe('既有纪要')
    // 空串
    const same1 = updateDiscussionRunningSummary(panel, '')
    expect(same1).toBe(panel) // 原样返回同一引用
    expect(same1.runningSummary).toBe('既有纪要')
    // 全空白
    const same2 = updateDiscussionRunningSummary(panel, '   \n\t  ')
    expect(same2).toBe(panel)
    expect(same2.runningSummary).toBe('既有纪要')
    // 从未设置过 + 空文本 → 仍无 runningSummary
    const fresh = createMoADiscussionPanel(SEED)
    expect(updateDiscussionRunningSummary(fresh, '  ').runningSummary).toBeUndefined()
  })

  it('不改 phase / entries / summary / currentRound / roundLimit（只动 runningSummary）', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'A', createdAt: 1 })
    panel = beginNextRound(panel)
    const frozen = {
      phase: panel.phase,
      entries: panel.entries,
      summary: panel.summary,
      currentRound: panel.currentRound,
      roundLimit: panel.roundLimit,
      speakers: panel.speakers,
    }
    const updated = updateDiscussionRunningSummary(panel, '纪要文本')
    expect(updated.runningSummary).toBe('纪要文本')
    expect(updated.phase).toBe(frozen.phase)
    expect(updated.entries).toBe(frozen.entries)
    expect(updated.summary).toBe(frozen.summary)
    expect(updated.currentRound).toBe(frozen.currentRound)
    expect(updated.roundLimit).toBe(frozen.roundLimit)
    expect(updated.speakers).toBe(frozen.speakers)
  })

  it('trim 写入（首尾空白去除）', () => {
    const panel = createMoADiscussionPanel(SEED)
    const updated = updateDiscussionRunningSummary(panel, '  \n 纪要正文 \n  ')
    expect(updated.runningSummary).toBe('纪要正文')
  })
})

describe('clearDiscussionRunningSummary', () => {
  it('清空既有 runningSummary → 置回 undefined', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = updateDiscussionRunningSummary(panel, '纪要')
    expect(panel.runningSummary).toBe('纪要')
    const cleared = clearDiscussionRunningSummary(panel)
    expect(cleared.runningSummary).toBeUndefined()
  })

  it('本就无 runningSummary → 原样返回（不产生多余字段）', () => {
    const panel = createMoADiscussionPanel(SEED)
    expect(panel.runningSummary).toBeUndefined()
    const cleared = clearDiscussionRunningSummary(panel)
    expect(cleared).toBe(panel)
    expect(cleared.runningSummary).toBeUndefined()
  })

  it('不改 phase / entries / summary（只清 runningSummary）', () => {
    let panel = createMoADiscussionPanel(SEED)
    panel = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: 'A', createdAt: 1 })
    panel = updateDiscussionRunningSummary(panel, '纪要')
    panel = finalizeMoADiscussion(panel, '共识方案')
    const cleared = clearDiscussionRunningSummary(panel)
    expect(cleared.phase).toBe('done')
    expect(cleared.summary).toBe('共识方案')
    expect(cleared.entries).toHaveLength(1)
    expect(cleared.runningSummary).toBeUndefined()
  })
})

// ---- 提前收敛（T9：evaluateDiscussionConvergence）----

/**
 * 构造一个推进到 targetRound 的 panel：前序轮填占位发言（不影响判定，只推进轮次），
 * 目标轮填入指定发言（turn 取 targetRound）。便于聚焦测试「本轮」判定。
 */
function buildRoundPanel(
  targetRound: number,
  roundEntries: { speakerId: string; text: string }[],
): MoADiscussionPanel {
  let panel = createMoADiscussionPanel(SEED)
  for (let r = 1; r <= targetRound; r++) {
    panel = beginNextRound(panel) // → currentRound=r
    if (r === targetRound) {
      for (const e of roundEntries) {
        panel = appendDiscussionEntry(panel, { speakerId: e.speakerId, text: e.text, createdAt: r * 100 })
      }
    } else {
      panel = appendDiscussionEntry(panel, { speakerId: 'p-arch', text: `第${r}轮展开`, createdAt: r })
      panel = appendDiscussionEntry(panel, { speakerId: 'p-prag', text: `第${r}轮补充`, createdAt: r })
    }
  }
  return panel
}

// 无信号填充串（9 字，×10=90 字 > 80，命中 0 个信号词），用于把发言撑到「长发言」同时不含信号
const FILLER = '边界条件还需细化。'
const LONG_NO_SIGNAL = FILLER.repeat(10) // 90 字，0 信号

describe('evaluateDiscussionConvergence', () => {
  it('currentRound < minRounds（默认 2）→ false：即便本轮全是短发言 + 信号词', () => {
    const panel = buildRoundPanel(1, [
      { speakerId: 'p-arch', text: '同意' },
      { speakerId: 'p-prag', text: '赞同' },
    ])
    expect(panel.currentRound).toBe(1)
    expect(evaluateDiscussionConvergence(panel)).toBe(false)
  })

  it('本轮参与者发言全部 ≤ shortTextChars（默认 80）→ true（rule a：无实质展开）', () => {
    const panel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: '好的' }, // 短且无信号 → 只靠 rule a
      { speakerId: 'p-prag', text: '嗯嗯' },
    ])
    expect(evaluateDiscussionConvergence(panel)).toBe(true)
  })

  it('本轮参与者发言命中信号词总次数 ≥ 阈值 → true（rule b：长发言也成立）', () => {
    // 两条长发言（>80 字 → rule a 不成立），各含 1 个信号词 → 总 2 次 = ceil(2×0.6)=2 → true
    const panel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: `${LONG_NO_SIGNAL}我同意这个方向。` }, // 1 hit「同意」
      { speakerId: 'p-prag', text: `${LONG_NO_SIGNAL}我赞同这个方向。` }, // 1 hit「赞同」
    ])
    expect(evaluateDiscussionConvergence(panel)).toBe(true)
  })

  it('本轮长发言且无信号词 → false（rule a/b 均不成立）', () => {
    const panel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: LONG_NO_SIGNAL },
      { speakerId: 'p-prag', text: `${LONG_NO_SIGNAL}还需打磨一轮。` }, // 0 信号
    ])
    expect(evaluateDiscussionConvergence(panel)).toBe(false)
  })

  it('信号词命中次数不足阈值 → false（2 参考席默认阈值 2，命中 1 次）', () => {
    const panel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: `${LONG_NO_SIGNAL}我同意这个方向。` }, // 1 hit
      { speakerId: 'p-prag', text: `${LONG_NO_SIGNAL}还需打磨一轮。` }, // 0 hit
    ])
    expect(evaluateDiscussionConvergence(panel)).toBe(false)
  })

  it('本轮无参与者发言（仅 user 插话）→ false', () => {
    const panel = buildRoundPanel(2, [
      // 目标轮只有 user 插话，无 participant 发言 → roundEntries 空 → false
      { speakerId: MOA_DISCUSSION_USER_SPEAKER_ID, text: '我插一句' },
    ])
    expect(evaluateDiscussionConvergence(panel)).toBe(false)
  })

  it('空 opts / undefined 取默认值，与显式默认等价', () => {
    const shortPanel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: '好的' },
      { speakerId: 'p-prag', text: '嗯嗯' },
    ])
    expect(evaluateDiscussionConvergence(shortPanel)).toBe(true) // undefined
    expect(evaluateDiscussionConvergence(shortPanel, {})).toBe(true) // 空 opts
    expect(
      evaluateDiscussionConvergence(shortPanel, { minRounds: 2, shortTextChars: 80, signalRatio: 0.6 }),
    ).toBe(true) // 显式默认
  })

  it('自定义 opts 可改变判定（minRounds / shortTextChars / signalRatio）', () => {
    const shortPanel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: '好的' }, // 2 字
      { speakerId: 'p-prag', text: '嗯嗯' },
    ])
    // minRounds=3：currentRound=2 < 3 → false（即便短发言）
    expect(evaluateDiscussionConvergence(shortPanel, { minRounds: 3 })).toBe(false)
    // shortTextChars=3：5 字发言 > 3 → rule a 失败；无信号 → rule b 失败 → false
    // （默认 80 时同样发言会因 rule a 收敛，故自定义阈值改变了判定）
    const fiveCharPanel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: '还要再想想' }, // 5 字，无信号
      { speakerId: 'p-prag', text: '还需再打磨' }, // 5 字，无信号
    ])
    expect(evaluateDiscussionConvergence(fiveCharPanel, { shortTextChars: 3 })).toBe(false)
    expect(evaluateDiscussionConvergence(fiveCharPanel)).toBe(true) // 默认 80 → rule a 成立

    // signalRatio：默认阈值 ceil(2×0.6)=2，命中 1 次 → false；ratio=0.4 阈值 ceil(0.8)=1 → true
    const oneHitPanel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: `${LONG_NO_SIGNAL}我同意这个方向。` }, // 1 hit
      { speakerId: 'p-prag', text: `${LONG_NO_SIGNAL}还需打磨一轮。` }, // 0 hit
    ])
    expect(evaluateDiscussionConvergence(oneHitPanel)).toBe(false) // 默认阈值 2，1 hit
    expect(evaluateDiscussionConvergence(oneHitPanel, { signalRatio: 0.4 })).toBe(true) // 阈值 1，1 hit
  })

  it('不修改原 panel（纯函数、无副作用）', () => {
    const panel = buildRoundPanel(2, [
      { speakerId: 'p-arch', text: '好的' },
      { speakerId: 'p-prag', text: '嗯嗯' },
    ])
    const snapshot = {
      entries: [...panel.entries],
      currentRound: panel.currentRound,
      phase: panel.phase,
      speakers: [...panel.speakers],
    }
    evaluateDiscussionConvergence(panel)
    expect(panel.entries).toEqual(snapshot.entries)
    expect(panel.currentRound).toBe(snapshot.currentRound)
    expect(panel.phase).toBe(snapshot.phase)
    expect(panel.speakers).toEqual(snapshot.speakers)
  })
})