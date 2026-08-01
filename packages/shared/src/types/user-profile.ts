/**
 * 用户档案（用户名 / 称呼）
 *
 * 存储：~/.tagent[-dev]/user-profile.json（见 config-paths.getUserProfilePath）
 * 用途：Rail 设置入口显示用户名首字、引导页称呼设置、通用设置编辑。
 */

/** 默认用户名（未设置称呼时的兜底） */
export const DEFAULT_USER_NAME = '用户'

/** 用户档案 */
export interface UserProfile {
  /** 用户名 / 称呼（Rail 头像取首字符） */
  userName: string
}

/** 用户档案 IPC 通道 */
export const USER_PROFILE_IPC_CHANNELS = {
  /** 获取用户档案 */
  GET: 'user-profile:get',
  /** 更新用户档案（合并字段） */
  UPDATE: 'user-profile:update',
} as const
