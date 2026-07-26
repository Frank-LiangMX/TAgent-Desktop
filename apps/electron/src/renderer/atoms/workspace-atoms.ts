/**
 * 工作区状态（Jotai）
 *
 * 2.0 核心状态：当前工作区 = 当前项目。
 * 会话数据按 workspaceId 组织存储（~/.tagent/projects/{workspaceId}/）。
 */
import { atom } from 'jotai'
import type { AgentWorkspace } from '@tagent/shared'

/** 工作区列表 */
export const workspacesAtom = atom<AgentWorkspace[]>([])

/** 当前选中的工作区 ID（= sanitizePath(projectPath)） */
export const currentWorkspaceIdAtom = atom<string | null>(null)

/** 当前工作区对象（派生） */
export const currentWorkspaceAtom = atom<AgentWorkspace | undefined>((get) => {
  const id = get(currentWorkspaceIdAtom)
  const list = get(workspacesAtom)
  return id ? list.find((w) => w.id === id) : undefined
})

/** 拉取工作区列表（write-only）；首次加载默认选中第一个 */
export const loadWorkspacesAtom = atom(null, async (get, set) => {
  const list = await window.electronAPI.listWorkspaces()
  set(workspacesAtom, list)
  // 默认选中第一个（最新使用）
  const selected = get(currentWorkspaceIdAtom)
  if (!selected && list.length > 0 && list[0]) {
    set(currentWorkspaceIdAtom, list[0].id)
  }
})
