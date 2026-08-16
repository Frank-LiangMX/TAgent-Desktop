/**
 * System Prompt Atoms — Chat 模式系统提示词状态
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  BUILTIN_DEFAULT_ID,
  BUILTIN_DEFAULT_PROMPT,
  type SystemPrompt,
  type SystemPromptConfig,
} from '@tagent/shared'
import { userProfileAtom } from './user-profile'

/** 完整提示词配置（从主进程加载） */
export const promptConfigAtom = atom<SystemPromptConfig>({
  prompts: [BUILTIN_DEFAULT_PROMPT],
  defaultPromptId: BUILTIN_DEFAULT_ID,
  appendDateTimeAndUserName: true,
})

/** 设置页当前选中的提示词 ID（持久化） */
export const selectedPromptIdAtom = atomWithStorage<string>(
  'tagent-selected-system-prompt-id',
  BUILTIN_DEFAULT_ID,
)

/** 默认提示词 ID（派生） */
export const defaultPromptIdAtom = atom(
  (get) => get(promptConfigAtom).defaultPromptId ?? BUILTIN_DEFAULT_ID,
)

/** 当前选中的提示词对象（派生） */
export const selectedPromptAtom = atom<SystemPrompt | undefined>((get) => {
  const config = get(promptConfigAtom)
  const selectedId = get(selectedPromptIdAtom)
  return config.prompts.find((p) => p.id === selectedId)
})

/** 解析最终 systemMessage（派生；设置页预览用） */
export const resolvedSystemMessageAtom = atom<string | undefined>((get) => {
  const selectedPrompt = get(selectedPromptAtom)
  if (!selectedPrompt) return undefined
  let message = selectedPrompt.content
  const config = get(promptConfigAtom)
  if (config.appendDateTimeAndUserName) {
    const userProfile = get(userProfileAtom)
    const dateTimeStr = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
    })
    message += `\n\n---\n当前时间: ${dateTimeStr}\n用户名: ${userProfile.userName || '用户'}`
  }
  return message
})
