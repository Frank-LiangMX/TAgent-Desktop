/**
 * MoA 圆桌卡纯函数状态机（无副作用，便于单测）。
 *
 * 主进程 runMoaTurn 用这些函数组装/推进 {@link MoARoundtablePanel}，再随 `tagent_event`
 * 推给渲染层；渲染层只负责按 panel 原样渲染。状态迁移规则集中在此处：
 *
 * - references 阶段：参考席逐个 pending→running→ok/failed；任一 ok 即 fail-open。
 * - 全部参考席终态且至少一个 ok → aggregating（汇总席 running→ok/failed）。
 * - 全部参考席失败 → error（不再汇总）。
 * - 汇总席 ok → done；汇总席 failed → error。
 * - 取消：未完成席（pending/running）置 cancelled，phase=cancelled；已完成席保留原状态。
 *
 * 不在此处做的：调度真实模型 / 推 IPC —— 那是主进程 runMoa-turn.ts 的职责。
 */
import type { MoARoundtablePanel, MoASeatPanel, MoASeatStatus } from './tagent-message'

/** 创建圆桌卡的输入（席位仅含标识，状态由函数置为 pending） */
export interface MoARoundtableSeedSeat {
  seatId: string
  name: string
  modelId: string
}

export interface MoARoundtableSeed {
  roundtableId: string
  presetId: string
  presetName: string
  topic: string
  references: MoARoundtableSeedSeat[]
  aggregator: MoARoundtableSeedSeat
}

/** 组装初始圆桌卡：所有席位 pending，phase=references。 */
export function createMoARoundtablePanel(seed: MoARoundtableSeed): MoARoundtablePanel {
  return {
    kind: 'moa_roundtable',
    roundtableId: seed.roundtableId,
    presetId: seed.presetId,
    presetName: seed.presetName,
    topic: seed.topic,
    seats: [
      ...seed.references.map((r) => ({ ...r, role: 'reference' as const, status: 'pending' as MoASeatStatus })),
      { ...seed.aggregator, role: 'aggregator' as const, status: 'pending' as MoASeatStatus },
    ],
    phase: 'references',
  }
}

/**
 * 由席位状态派生卡 phase（纯函数）。
 *
 * - 有参考席未到终态 → references
 * - 参考席全终态但无一 ok → error（全失败）
 * - 参考席全终态且有 ok：汇总席 ok→done，failed→error，否则 aggregating
 */
export function deriveMoAPhase(seats: MoASeatPanel[]): MoARoundtablePanel['phase'] {
  const refs = seats.filter((s) => s.role === 'reference')
  const agg = seats.find((s) => s.role === 'aggregator')
  if (refs.length === 0) return 'error'
  const isRefDone = (s: MoASeatPanel): boolean =>
    s.status === 'ok' || s.status === 'failed' || s.status === 'cancelled'
  if (!refs.every(isRefDone)) return 'references'
  if (!refs.some((s) => s.status === 'ok')) return 'error'
  if (agg?.status === 'ok') return 'done'
  if (agg?.status === 'failed') return 'error'
  return 'aggregating'
}

/** 席位补丁（更新时附带文本/错误/耗时等） */
export interface MoASeatPatch {
  text?: string
  error?: string
  latencyMs?: number
}

/** 更新某席位状态并重算 phase。席位不存在时原样返回（防御坏数据）。 */
export function setMoASeatStatus(
  panel: MoARoundtablePanel,
  seatId: string,
  status: MoASeatStatus,
  patch?: MoASeatPatch,
): MoARoundtablePanel {
  let touched = false
  const seats = panel.seats.map((s) => {
    if (s.seatId !== seatId) return s
    touched = true
    return { ...s, status, ...(patch ?? {}) }
  })
  if (!touched) return panel
  return { ...panel, seats, phase: deriveMoAPhase(seats) }
}

/** 取消：未完成席（pending/running）置 cancelled，phase=cancelled；已完成席保留。 */
export function markMoAPanelCancelled(panel: MoARoundtablePanel): MoARoundtablePanel {
  const seats = panel.seats.map((s) =>
    s.status === 'pending' || s.status === 'running' ? { ...s, status: 'cancelled' as MoASeatStatus } : s,
  )
  return { ...panel, seats, phase: 'cancelled' }
}

/** 强制置终态 phase（error/取消之外的显式收口，如汇总前预置失败）。不改席位状态。 */
export function setMoAPanelPhase(
  panel: MoARoundtablePanel,
  phase: MoARoundtablePanel['phase'],
): MoARoundtablePanel {
  return { ...panel, phase }
}
