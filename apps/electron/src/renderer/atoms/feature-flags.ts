/**
 * 功能开关（Jotai + localStorage 持久化）
 *
 * 用 jotai/utils 的 atomWithStorage：读写自动同步 localStorage，跨会话保留。
 * 放这里集中管理，避免散落各处。
 */
import { atom } from 'jotai'
import { atomWithStorage, type RESET } from 'jotai/utils'

/**
 * 分屏工作台模式（实验）：
 * on → 主区用 Dockview 画布（拖会话 tab 到边缘自动分屏，多 Chat 并存独立流式）；
 * off → 现有 TabBar + SessionRouter 单 tab 路径（默认，零回归）。
 * 两条路径并存，flag 可随时退回。
 */
export const splitDockModeAtom = atomWithStorage<boolean>(
  'tagent:splitDockMode',
  false,
)

/** 便捷 setter（写 atom） */
export const setSplitDockMode = atom(null, (_get, set, value: boolean) => {
  set(splitDockModeAtom, value)
})

// 防止 RESET 类型未被引用的告警（atomWithStorage 内部用到）
export type { RESET }
