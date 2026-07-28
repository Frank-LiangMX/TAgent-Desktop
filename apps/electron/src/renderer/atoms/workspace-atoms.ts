/**
 * 工作区状态（Jotai）
 *
 * 会话数据按 workspaceId 组织存储（~/.tagent/projects/{workspaceId}/）。
 */
import { atom } from 'jotai'
import type { AgentWorkspace } from '@tagent/shared'

/** 工作区列表 */
export const workspacesAtom = atom<AgentWorkspace[]>([])

/** 拉取工作区列表（write-only） */
export const loadWorkspacesAtom = atom(null, async (_get, set) => {
  const list = await window.electronAPI.listWorkspaces()
  set(workspacesAtom, list)
})
