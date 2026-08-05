/**
 * 工作区状态（Jotai）
 *
 * 会话数据按 workspaceId 组织存储（~/.tagent/projects/{workspaceId}/）。
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentWorkspace } from '@tagent/shared'

/** 工作区列表 */
export const workspacesAtom = atom<AgentWorkspace[]>([])

/**
 * 最近激活的工作区。
 *
 * 工作区列表的返回顺序不代表活跃时间，不能用 workspaces[0] 猜测。
 * 该值由打开会话、草稿切换工作区和创建项目等用户动作更新。
 */
export const lastActiveWorkspaceIdAtom = atomWithStorage<string | null>(
  'tagent:lastActiveWorkspaceId',
  null,
)

/** 拉取工作区列表（write-only） */
export const loadWorkspacesAtom = atom(null, async (_get, set) => {
  const list = await window.electronAPI.listWorkspaces()
  set(workspacesAtom, list)
})
