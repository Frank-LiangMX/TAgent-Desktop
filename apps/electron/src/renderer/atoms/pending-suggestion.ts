/**
 * welcome 形态点提示词时暂存文本：草稿 Chat 挂载后读它预填输入框并清空。
 * 让「无标签 welcome 形态点提示词 → 进入 compose 形态且输入框已填好」一步到位。
 */
import { atom } from 'jotai'

export const pendingSuggestionAtom = atom<string | null>(null)
