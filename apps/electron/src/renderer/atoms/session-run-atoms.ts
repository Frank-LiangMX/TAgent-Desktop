/**
 * 会话运行态（Jotai）—— per-session running / startedAt
 *
 * 为什么不用 Chat 的 local useState：草稿态（NewConversationLanding）与真实 tab 态
 * 是两个不同 React 位置的 <Chat> 实例（App.tsx 草稿分支 vs SessionRouter），切换时草稿
 * 实例卸载、真实实例全新挂载；local state 随卸载丢弃，真实实例 running 恒 false → 计时 /
 * 停止键 / 流式动画全丢。提到 atom 按 sessionId 键（草稿 id === 真实 id，无转换），
 * 跨实例存活；真实实例挂载时对照主进程 getSessionStatus 收养在跑的轮。
 *
 * 模式对齐 session-status-atoms.ts（Record<id, entry> map + 派生工厂，无 atomFamily）。
 * 用 Jotai 默认 store（无需 Provider）。
 */
import { atom } from 'jotai'

/** 单会话运行态条目 */
export interface SessionRunEntry {
  running: boolean
  startedAt: number | null
}

const IDLE_ENTRY: SessionRunEntry = { running: false, startedAt: null }

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
    const map = { ...get(sessionRunMapAtom) }
    map[payload.id] = { running: true, startedAt: payload.startedAt }
    set(sessionRunMapAtom, map)
  },
)

/**
 * 结束一轮（write-only）。turn_end / session_error / 发送失败 / 切到非运行会话时调。
 */
export const stopSessionRunAtom = atom(null, (get, set, id: string) => {
  const map = { ...get(sessionRunMapAtom) }
  map[id] = { running: false, startedAt: null }
  set(sessionRunMapAtom, map)
})

/**
 * 收养在跑的轮（write-only）。真实 Chat 挂载时若主进程 getSessionStatus 说在跑、
 * 但 atom 未记 running（如草稿实例未及 seed / 渲染层刷新中），用之：置 running，
 * startedAt 优先沿用已有值，回退入参（保住草稿时间戳，回退 Date.now()）。
 */
export const adoptSessionRunAtom = atom(
  null,
  (get, set, payload: { id: string; startedAt: number }) => {
    const map = { ...get(sessionRunMapAtom) }
    const prev = map[payload.id]
    map[payload.id] = { running: true, startedAt: prev?.startedAt ?? payload.startedAt }
    set(sessionRunMapAtom, map)
  },
)
