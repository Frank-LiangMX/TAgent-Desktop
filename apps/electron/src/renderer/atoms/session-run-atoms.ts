/**
 * 会话运行态（Jotai）—— per-session running / startedAt
 *
 * 对齐 TAgent_General：`agentStreamingStatesAtom` + `useSessionRunElapsed` ——
 * 计时起点挂在全局 map，不随 Chat 实例卸载丢失。
 *
 * 为什么不用 Chat 的 local useState：草稿态与真实 tab 是两个 <Chat> 位置，且
 * SessionRouter key=sessionId 切 tab 会卸载实例；local state 随卸载丢，计时 / 停止键 /
 * 流式动画全丢。atom 按 sessionId 键跨实例存活。
 *
 * 写入路径：
 * - Chat startRun：发送瞬间 seed（覆盖思考期无产出）
 * - useGlobalSessionRunSync：任意会话的流式事件 adopt / result·error hard-stop
 * - Chat remount：主进程 running → adopt 保 startedAt；idle/error 且 atom 仍 running/startedAt 残留 → hard stop
 *
 * 软停 vs 硬停：
 * - softStop（turn_end 宽限期）：running=false，**保留 startedAt 记忆**，下一轮 delta adopt 续计时
 * - hardStop（result / error / 用户停止 / 发送失败）：running=false 且清 startedAt
 *
 * 模式对齐 session-status-atoms.ts（Record map + 派生工厂）。Jotai 默认 store。
 */
import { atom } from 'jotai'

/** 单会话运行态条目 */
export interface SessionRunEntry {
  running: boolean
  startedAt: number | null
}

const IDLE_ENTRY: SessionRunEntry = { running: false, startedAt: null }

/**
 * 跨 soft-stop 保留的计时起点（sessionId → ms）。
 * hardStop / 新 start 时覆盖或清除；adopt 优先用它保证工具循环计时连续。
 */
const startedAtMemory = new Map<string, number>()

/** 会话运行态表：sessionId → { running, startedAt } */
export const sessionRunMapAtom = atom<Record<string, SessionRunEntry>>({})

/** 派生：某会话的运行态（未设置时 idle） */
export const sessionRunAtom = (id: string) =>
  atom((get) => get(sessionRunMapAtom)[id] ?? IDLE_ENTRY)

/**
 * 开始一轮（write-only）。发送即调，置 running 并记 startedAt。
 */
export const startSessionRunAtom = atom(
  null,
  (get, set, payload: { id: string; startedAt: number }) => {
    startedAtMemory.set(payload.id, payload.startedAt)
    const map = { ...get(sessionRunMapAtom) }
    map[payload.id] = { running: true, startedAt: payload.startedAt }
    set(sessionRunMapAtom, map)
  },
)

/**
 * 硬停一轮（write-only）：清 running + startedAt + 记忆。
 * result / session_error / 用户停止 / 发送失败 用这个。
 */
export const stopSessionRunAtom = atom(null, (get, set, id: string) => {
  startedAtMemory.delete(id)
  const map = { ...get(sessionRunMapAtom) }
  map[id] = { running: false, startedAt: null }
  set(sessionRunMapAtom, map)
})

/**
 * 软停（write-only）：running=false，**atom 与记忆都保留 startedAt**。
 * turn_end 宽限期到时用：过程区可收起；计时 pill 继续走（startedAt 仍在）；
 * 下一 delta adopt 只恢复 running，不重置起点。
 */
export const softStopSessionRunAtom = atom(null, (get, set, id: string) => {
  const map = { ...get(sessionRunMapAtom) }
  const prev = map[id]
  const startedAt = prev?.startedAt ?? startedAtMemory.get(id) ?? null
  if (startedAt != null) {
    startedAtMemory.set(id, startedAt)
  }
  map[id] = { running: false, startedAt }
  set(sessionRunMapAtom, map)
})

/**
 * 收养在跑的轮（write-only）。
 * startedAt 优先级：已在跑的 atom 值 → 记忆 → 入参。
 * 同 session 持续 running 时幂等，不重置计时（对齐 General transitionRunTimerState）。
 */
export const adoptSessionRunAtom = atom(
  null,
  (get, set, payload: { id: string; startedAt: number }) => {
    const map = { ...get(sessionRunMapAtom) }
    const prev = map[payload.id]
    // 已在跑且有有效起点 → 保持不动
    if (prev?.running && prev.startedAt != null) {
      return
    }
    const startedAt =
      prev?.startedAt ?? startedAtMemory.get(payload.id) ?? payload.startedAt
    startedAtMemory.set(payload.id, startedAt)
    map[payload.id] = { running: true, startedAt }
    set(sessionRunMapAtom, map)
  },
)
