/**
 * MoA 圆桌讨论（multi-turn deliberation）纯函数状态机。
 *
 * 与 {@link ./moa-roundtable} 的区别：会诊是「并行交卷 → 汇总」单轮（rounds=1），
 * 圆桌讨论是「席位互相可见、互相引用/反驳」的多轮讨论，由总结人收口成共识方案。
 *
 * 设计依据：docs/plans/multi-runtime/10-session-agent-behavior-orchestration.md §5.2/§5.3/§5.4
 *   - §5.2：多轮讨论 → 总结人收口（moderator 必在场）
 *   - §5.3：用户席（role='user'）可插话/喊停
 *   - §5.4：轮数上限（默认 ≤6 全场轮）到点必收口；席位无工具
 *
 * 主进程（runMoa-turn 或新 runMoa-discussion）用这些函数组装/推进
 * {@link MoADiscussionPanel}，再随 `tagent_event` 推给渲染层；渲染层只负责按 panel 原样渲染。
 * 不在此处做：调度真实模型 / 推 IPC —— 那是主进程职责。
 *
 * 类型风格参照 ./tagent-message.ts 中 MoARoundtablePanel / MoASeatPanel；
 * 本次为新机制，未合并进 tagent-message.ts IR（后续按需迁入）。
 */

/** 圆桌讨论阶段机：讨论中 → 收口汇总 → 完成 / 出错 / 被取消 */
export type MoADiscussionPhase = 'discussing' | 'finalizing' | 'done' | 'error' | 'cancelled'

/** 圆桌讨论单个席位的身份与角色（moderator=总结人，负责收口） */
export interface MoADiscussionSpeaker {
  speakerId: string
  name: string
  modelId: string
  role: 'participant' | 'user' | 'moderator'
}

/** 圆桌讨论中的一条发言 */
export interface MoADiscussionEntry {
  entryId: string
  speakerId: string
  text: string
  turn: number
  createdAt: number
}

/** 圆桌讨论完整状态（推送给渲染层的最小契约） */
export interface MoADiscussionPanel {
  kind: 'moa_discussion'
  /** 本场讨论稳定标识：同一场多张状态卡用此就地 upsert，跨场不串台 */
  discussionId: string
  presetName: string
  topic: string
  speakers: MoADiscussionSpeaker[]
  entries: MoADiscussionEntry[]
  phase: MoADiscussionPhase
  roundLimit: number
  currentRound: number
  /** 总结人收口后的共识方案文本；finalize 时写入 */
  summary?: string
  /**
   * 讨论过程中的**共享纪要**（T11）：每 N 轮由纪要模型把讨论压成结构化纪要，
   * 下一轮参与者读「议题 + 纪要 + 最近一轮发言」而非全部发言堆积。
   *
   * 与 {@link summary} 语义不同：runningSummary 是**过程态**的滚动纪要（讨论室实时可见，
   * 仅供压缩上下文、不替代收口）；summary 是**终态**的共识方案（总结人收口写入）。
   * finalize 时不主动清空 runningSummary（保留便于回看），但渲染层只把 summary 当共识展示。
   */
  runningSummary?: string
}

/** 创建圆桌讨论 panel 的输入：参与者（不含 user / moderator 席，由本函数自动追加） */
export interface MoADiscussionSeedSpeaker {
  speakerId: string
  name: string
  modelId: string
}

export interface MoADiscussionSeed {
  discussionId: string
  presetName: string
  topic: string
  participants: MoADiscussionSeedSpeaker[]
  /** 全场轮数上限（默认 6，见设计文档 §5.4）；<1 视为 1 */
  roundLimit: number
}

/** 约定的固定席 ID（与 createMoADiscussionPanel 内部使用保持一致） */
export const MOA_DISCUSSION_USER_SPEAKER_ID = 'user'
export const MOA_DISCUSSION_MODERATOR_SPEAKER_ID = 'moderator'

/**
 * 圆桌讨论共识 assistant 的落盘 uuid：`moa-disc-agg-<discussionId>`。
 *
 * runMoADiscussion 收口时由 persistAndPushFinalAssistant 用此 uuid 落盘本轮主 assistant
 * （共识方案）。渲染层（Chat.tsx）在重启重放讨论入口卡时，按此 uuid 在历史 items 中定位
 * 该共识 assistant，把入口卡插到其**前面**——与实时运行时「卡先于共识推送」的落点对齐
 * （实时运行时共识 assistant 尚未到达，找不到 → 末尾追加，行为不变）。
 *
 * 集中在此导出避免主进程构造处与渲染层定位处漂移；找不到（cancelled/error 无共识 /
 * 历史损坏）由调用方兜底，不抛错。
 */
export function moaDiscussionConsensusUuid(discussionId: string): string {
  return `moa-disc-agg-${discussionId}`
}

/**
 * 组装初始圆桌讨论 panel：participants + 自动追加 user 席 + moderator（总结人）席。
 *
 * - phase 初始为 'discussing'
 * - currentRound 初始为 0（首条 append 后由编排层主动 beginNextRound）
 * - entries 初始为空
 * - summary 未设
 */
export function createMoADiscussionPanel(seed: MoADiscussionSeed): MoADiscussionPanel {
  const roundLimit = seed.roundLimit < 1 ? 1 : Math.floor(seed.roundLimit)
  const speakers: MoADiscussionSpeaker[] = [
    ...seed.participants.map(
      (p): MoADiscussionSpeaker => ({ ...p, role: 'participant' as const }),
    ),
    {
      speakerId: MOA_DISCUSSION_USER_SPEAKER_ID,
      name: '你',
      modelId: 'human',
      role: 'user',
    },
    {
      speakerId: MOA_DISCUSSION_MODERATOR_SPEAKER_ID,
      name: '总结人',
      modelId: 'moderator',
      role: 'moderator',
    },
  ]
  return {
    kind: 'moa_discussion',
    discussionId: seed.discussionId,
    presetName: seed.presetName,
    topic: seed.topic,
    speakers,
    entries: [],
    phase: 'discussing',
    roundLimit,
    currentRound: 0,
  }
}

/** 追加发言的输入（不含 entryId/createdAt/turn，由函数补齐） */
export interface MoADiscussionEntryInput {
  speakerId: string
  text: string
  /** 不传时按当前 currentRound 取整 */
  turn?: number
  /** 不传时取 Date.now() */
  createdAt?: number
}

/**
 * 追加一条发言到 entries 末尾。
 *
 * - 不自动推进 round（轮次推进由编排层按「一组发言完成」调用 beginNextRound）
 * - turn 缺省时按 panel.currentRound
 * - speakerId 不在 panel.speakers 中时仍允许写入（与 setMoASeatStatus 对未知 ID 原样返回的策略不同；
 *   圆桌讨论的发言来源更开放——可能来自总结后被引入的临时模型；编排层负责校验）
 */
export function appendDiscussionEntry(
  panel: MoADiscussionPanel,
  input: MoADiscussionEntryInput,
): MoADiscussionPanel {
  const entry: MoADiscussionEntry = {
    entryId: `${panel.discussionId}:${panel.entries.length}`,
    speakerId: input.speakerId,
    text: input.text,
    turn: input.turn ?? panel.currentRound,
    createdAt: input.createdAt ?? Date.now(),
  }
  return { ...panel, entries: [...panel.entries, entry] }
}

/**
 * 进入下一轮：currentRound + 1。
 *
 * - 若 newCurrentRound > roundLimit：返回 phase='finalizing' 的 panel（不变 entries，由编排层写总结）
 * - 若 newCurrentRound === roundLimit：仍允许写入下一轮（最后一轮），下一次再触发 finalizing
 */
export function beginNextRound(panel: MoADiscussionPanel): MoADiscussionPanel {
  const nextRound = panel.currentRound + 1
  if (nextRound > panel.roundLimit) {
    return { ...panel, phase: 'finalizing' }
  }
  return { ...panel, currentRound: nextRound }
}

/** 强制置 phase（不改 entries/summary）。用于在 beginNextRound 之外的显式状态迁移。 */
export function setMoADiscussionPhase(
  panel: MoADiscussionPanel,
  phase: MoADiscussionPhase,
): MoADiscussionPanel {
  return { ...panel, phase }
}

/** 总结人收口：phase='done' + 写入 summary。已终态的 panel 仍允许覆盖 summary。 */
export function finalizeMoADiscussion(panel: MoADiscussionPanel, summary: string): MoADiscussionPanel {
  return { ...panel, phase: 'done', summary }
}

/**
 * 更新讨论过程的**共享纪要**（T11）：不可变地写入/覆盖 {@link MoADiscussionPanel.runningSummary}。
 *
 * 由编排层在每 N 轮跑完纪要模型后调用，把结构化纪要文本写回 panel 并随讨论卡 emit（讨论室可见）。
 * 不改 phase / entries / summary / currentRound——纪要是过程态压缩，与终态共识方案 `summary` 解耦。
 * 空 text（含全空白）视作「无有效纪要」：不写入、原样返回 panel（避免纪要模型返回空串覆盖既有纪要）。
 */
export function updateDiscussionRunningSummary(
  panel: MoADiscussionPanel,
  text: string,
): MoADiscussionPanel {
  const trimmed = text?.trim()
  if (!trimmed) return panel
  return { ...panel, runningSummary: trimmed }
}

/**
 * 清空共享纪要（T11，按需）：把 runningSummary 置回 undefined。
 *
 * 正常流程不调用（纪要随讨论滚动累积、finalize 时保留以便回看）；导出以备编排层在
 * 「纪要被污染需重置」或单测显式归零时使用。不改 phase / entries / summary。
 */
export function clearDiscussionRunningSummary(panel: MoADiscussionPanel): MoADiscussionPanel {
  if (panel.runningSummary === undefined) return panel
  const rest: MoADiscussionPanel = { ...panel }
  delete rest.runningSummary
  return rest
}

/** 用户喊停 / 编排异常退出：phase='cancelled'。保留 entries 便于回放。 */
export function markMoADiscussionCancelled(panel: MoADiscussionPanel): MoADiscussionPanel {
  return { ...panel, phase: 'cancelled' }
}

/**
 * 收敛信号词（中文）：参与者发言命中这些词视为「表达同意 / 无补充 / 倾向收口」。
 *
 * 列表为短词，按子串命中计次（中文无词边界）。同一发言命中多个信号词会累计总次数；
 * 个别信号词存在字符重叠（如「就按 / 按这个」共享「按」），偶发的双重计数不削弱收敛语义，
 * 反而强化「已倾向收口」的判定——编排层最终仍由总结人收口，不会误伤未结束的讨论。
 */
export const DISCUSSION_CONVERGENCE_SIGNALS: string[] = [
  '同意',
  '赞同',
  '认同',
  '支持',
  '没意见',
  '没有补充',
  '无补充',
  '一致',
  '就按',
  '按这个',
  '结论',
  '收口',
  '认可',
  '赞成',
]

/** evaluateDiscussionConvergence 的可选阈值（全缺省时取内置默认）。 */
export interface DiscussionConvergenceOpts {
  /** 至少聊满几轮才判定（给讨论展开机会），默认 2。 */
  minRounds?: number
  /** 短发言阈值（字数）：本轮参与者发言「全部」≤ 此值视为无实质展开 → 收敛，默认 80。 */
  shortTextChars?: number
  /** 信号词命中占比：本轮命中总次数 ≥ ceil(参与者数 × ratio) 视为多数同意 → 收敛，默认 0.6。 */
  signalRatio?: number
}

/** 计算 needle 在 haystack 中非重叠出现次数（中文按子串计数；空 needle 返回 0）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

/**
 * 评估「本轮」是否已收敛，供编排层在每轮参与者循环结束后、进入下一轮前判定是否提前收口。
 *
 * 纯函数、无副作用；只读 {@link MoADiscussionPanel.entries / speakers / currentRound}，不改 panel。
 * 空 opts 取内置默认。判定规则（满足任一即收敛 → true）：
 *
 *   前置：`currentRound < minRounds`（默认 2）→ 直接 false（至少聊满 2 轮，给讨论展开机会）。
 *   a) 本轮参与者发言「全部」≤ `shortTextChars`（默认 80 字）→ 无实质展开 → true。
 *   b) 本轮参与者发言命中 {@link DISCUSSION_CONVERGENCE_SIGNALS} 的总次数
 *      ≥ `ceil(参与者数 × signalRatio)`（默认 0.6）→ 多数人表达同意/无补充 → true。
 *
 * 只统计「本轮」（`entry.turn === panel.currentRound`）且 `role='participant'` 的发言；
 * user / moderator 插话不计入——用户插话应视为有实质内容，但收敛信号以参与者表态为准
 * （用户插话不改变收敛判定，避免「用户一发问就把讨论强行收口」）。本轮无参与者发言
 * （如仅 user/moderator 插话，或全失败已被编排层 error 路径拦截）→ 返回 false，交回编排层
 * 走既有失败/继续处理（不在此替它收口）。
 */
export function evaluateDiscussionConvergence(
  panel: MoADiscussionPanel,
  opts?: DiscussionConvergenceOpts,
): boolean {
  const minRounds = opts?.minRounds ?? 2
  const shortTextChars = opts?.shortTextChars ?? 80
  const signalRatio = opts?.signalRatio ?? 0.6

  // 前置：未聊满 minRounds 轮 → 不判定（给讨论展开机会）
  if (panel.currentRound < minRounds) return false

  const participantSpeakerIds = new Set(
    panel.speakers.filter((s) => s.role === 'participant').map((s) => s.speakerId),
  )
  // 只统计本轮（turn === currentRound）的 participant 发言；user/moderator 插话不计入
  const roundEntries = panel.entries.filter(
    (e) => e.turn === panel.currentRound && participantSpeakerIds.has(e.speakerId),
  )
  // 本轮无参与者发言 → 不替编排层收口（走既有失败/继续处理）
  if (roundEntries.length === 0) return false

  // a) 本轮参与者发言全部 ≤ shortTextChars → 无实质展开 → 收敛
  if (roundEntries.every((e) => e.text.length <= shortTextChars)) return true

  // b) 命中收敛信号词的总次数 ≥ ceil(参与者数 × signalRatio) → 多数同意 → 收敛
  const participantCount = participantSpeakerIds.size
  const threshold = Math.ceil(participantCount * signalRatio)
  let signalHits = 0
  for (const e of roundEntries) {
    for (const sig of DISCUSSION_CONVERGENCE_SIGNALS) {
      signalHits += countOccurrences(e.text, sig)
    }
  }
  return signalHits >= threshold
}