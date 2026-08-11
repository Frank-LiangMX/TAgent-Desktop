/**
 * 功能开关（Jotai + localStorage 持久化）
 *
 * 用 jotai/utils 的 atomWithStorage：读写自动同步 localStorage，跨会话保留。
 * 放这里集中管理，避免散落各处。
 */
import { atom } from 'jotai'
import { atomWithStorage, type RESET } from 'jotai/utils'

/**
 * 分屏工作台模式：
 * on → 主区用 Dockview 画布（拖会话 tab 到边缘自动分屏，多 Chat 并存独立流式）；
 * off → TabBar + SessionRouter 单 tab 路径。
 * 默认开启（v2 键）；旧 `tagent:splitDockMode=false` 不再读取，避免把新产品默认钉死在关。
 */
export const splitDockModeAtom = atomWithStorage<boolean>(
  'tagent:splitDockMode:v2',
  true,
)

/** 便捷 setter（写 atom） */
export const setSplitDockMode = atom(null, (_get, set, value: boolean) => {
  set(splitDockModeAtom, value)
})

/**
 * 加载动画预览开关（外观页）：
 * on → 外观页「加载动画」预览播放（配色跟随主题色系）；
 * off → 预览暂停 + 变淡。
 * 当前仅作外观预览，不接管应用真实加载场景。
 */
export const loaderAnimationEnabledAtom = atomWithStorage<boolean>(
  'tagent:loaderAnimation',
  true,
)

// 防止 RESET 类型未被引用的告警（atomWithStorage 内部用到）
export type { RESET }
