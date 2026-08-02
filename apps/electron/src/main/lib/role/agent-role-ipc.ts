/**
 * 角色库 IPC 注册
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'

import {
  AGENT_ROLE_IPC_CHANNELS,
  type DeleteAgentRoleInput,
  type SaveAgentRoleInput,
} from '@tagent/shared'

import {
  deleteRole,
  deleteRoles,
  findSimilarRoles,
  getRoleById,
  importRoleFromMd,
  loadRoles,
  resetDefaultRoles,
  saveRole,
} from './agent-role-service'
import { installStoreRole, loadRoleStoreCatalog } from './role-store-service'

export function registerAgentRoleIpcHandlers(): void {
  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.LIST, async () => loadRoles())

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.GET, async (_e, roleId: string) => getRoleById(roleId))

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.SAVE, async (_e, input: SaveAgentRoleInput) => {
    if (!input?.role) throw new Error('missing role')
    return saveRole(input.role)
  })

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.DELETE, async (_e, input: DeleteAgentRoleInput) => {
    if (!input?.roleId) throw new Error('missing roleId')
    return deleteRole(input.roleId)
  })

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.RESET_DEFAULT, async () => resetDefaultRoles())

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.STORE_LIST, async () => loadRoleStoreCatalog())

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.STORE_INSTALL, async (_e, roleId: string) =>
    installStoreRole(roleId),
  )

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.IMPORT_MD, async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!win) return { role: null, imported: false, reason: '无可用窗口' }

    const result = await dialog.showOpenDialog(win, {
      title: '导入角色 .md 文件',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { role: null, imported: false, reason: '已取消' }
    }
    return importRoleFromMd(result.filePaths[0]!)
  })

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.FIND_SIMILAR, async (_e, displayName: string) =>
    findSimilarRoles(displayName),
  )

  ipcMain.handle(AGENT_ROLE_IPC_CHANNELS.DELETE_BATCH, async (_e, roleIds: string[]) =>
    deleteRoles(Array.isArray(roleIds) ? roleIds : []),
  )

  // 启动时 seed，避免首次 list 才写盘
  try {
    loadRoles()
  } catch (err) {
    console.warn('[角色库] 启动 seed 失败:', err)
  }

  console.log('[角色库] IPC 已注册')
}
