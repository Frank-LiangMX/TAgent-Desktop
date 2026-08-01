/**
 * 用户档案服务：注册 USER_PROFILE 相关 IPC handler
 *
 * 使用 @tagent/shared 的 USER_PROFILE_IPC_CHANNELS。
 * - GET：获取用户档案（用户名 / 称呼）
 * - UPDATE：更新用户档案（合并字段）
 *
 * 见 shared/types/user-profile.ts。
 */
import { ipcMain } from 'electron'
import { USER_PROFILE_IPC_CHANNELS } from '@tagent/shared'
import type { UserProfile } from '@tagent/shared'
import { getUserProfile, updateUserProfile } from '../user-profile-service'

export class UserProfileService {
  static create(): UserProfileService {
    const svc = new UserProfileService()
    svc.registerIpc()
    return svc
  }

  /** 注册 IPC handler */
  private registerIpc(): void {
    // 获取用户档案
    ipcMain.handle(USER_PROFILE_IPC_CHANNELS.GET, async (): Promise<UserProfile> => {
      return getUserProfile()
    })

    // 更新用户档案
    ipcMain.handle(
      USER_PROFILE_IPC_CHANNELS.UPDATE,
      async (_e, updates: Partial<UserProfile>): Promise<UserProfile> => {
        return updateUserProfile(updates)
      },
    )
  }
}
