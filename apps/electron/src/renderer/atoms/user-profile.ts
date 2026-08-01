/**
 * 用户档案 Atom — 用户名 / 称呼
 *
 * 通过 IPC 从主进程 ~/.tagent[-dev]/user-profile.json 加载/保存。
 * Rail 设置头像首字、引导页称呼设置、通用设置共用此状态。
 */
import { atom } from 'jotai'
import { DEFAULT_USER_NAME } from '@tagent/shared'
import type { UserProfile } from '@tagent/shared'

/** 用户档案（初始为默认称呼） */
export const userProfileAtom = atom<UserProfile>({
  userName: DEFAULT_USER_NAME,
})

/** 从主进程加载用户档案（App 启动时调用一次） */
export const loadUserProfileAtom = atom(null, async (_get, set): Promise<UserProfile> => {
  try {
    const profile = await window.electronAPI.getUserProfile()
    set(userProfileAtom, profile)
    return profile
  } catch (error) {
    console.error('[user-profile] 加载失败:', error)
    return { userName: DEFAULT_USER_NAME }
  }
})

/** 更新用户档案（写主进程 + 同步本地 atom） */
export const saveUserProfileAtom = atom(
  null,
  async (_get, set, updates: Partial<UserProfile>): Promise<UserProfile> => {
    const updated = await window.electronAPI.updateUserProfile(updates)
    set(userProfileAtom, updated)
    return updated
  },
)
