/**
 * 顶层模式 atom（Desktop 仅 general；满足 General 记忆组件的 import 契约）
 */

import { atom } from 'jotai'

export type TopLevelMode = 'general' | 'ta'

/** Desktop 固定 general；接口与 General 一致，避免改记忆页源码 */
export const topLevelModeAtom = atom<TopLevelMode>('general')
