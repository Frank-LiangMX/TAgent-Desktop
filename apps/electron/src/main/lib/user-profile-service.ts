/**
 * 用户档案服务（用户名 / 称呼）
 *
 * 管理用户档案的读写，落盘 ~/.tagent[-dev]/user-profile.json。
 * 对齐 TAgent_General user-profile-service 语义，仅保留用户名（无头像）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DEFAULT_USER_NAME } from '@tagent/shared'
import type { UserProfile } from '@tagent/shared'
import { getUserProfilePath } from './config/config-paths'

/**
 * 获取用户档案
 *
 * 文件不存在或解析失败时返回默认档案（用户名 = '用户'）。
 */
export function getUserProfile(): UserProfile {
  const filePath = getUserProfilePath()

  if (!existsSync(filePath)) {
    return { userName: DEFAULT_USER_NAME }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<UserProfile>
    return {
      userName: data.userName?.trim() ? data.userName.trim() : DEFAULT_USER_NAME,
    }
  } catch (error) {
    console.error('[用户档案] 读取失败:', error)
    return { userName: DEFAULT_USER_NAME }
  }
}

/**
 * 更新用户档案
 *
 * 合并字段后写入文件，返回最新档案。
 */
export function updateUserProfile(updates: Partial<UserProfile>): UserProfile {
  const current = getUserProfile()
  const updated: UserProfile = {
    ...current,
    ...updates,
    userName: updates.userName?.trim() ? updates.userName.trim() : current.userName,
  }

  const filePath = getUserProfilePath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log(`[用户档案] 已更新: ${updated.userName}`)
  } catch (error) {
    console.error('[用户档案] 写入失败:', error)
    throw new Error('写入用户档案失败')
  }

  return updated
}
