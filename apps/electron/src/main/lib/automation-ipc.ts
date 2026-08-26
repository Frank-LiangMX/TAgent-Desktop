import { ipcMain } from 'electron'
import {
  AUTOMATION_IPC_CHANNELS,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from '@tagent/shared'
import {
  createAutomation,
  deleteAutomation,
  listAutomationEvents,
  listAutomations,
  toggleAutomation,
  updateAutomation,
} from './automation-manager'

/** Automation 的第一版 IPC 面：只负责任务定义和运行事件查询。 */
export function registerAutomationIpc(): void {
  ipcMain.removeHandler(AUTOMATION_IPC_CHANNELS.LIST)
  ipcMain.removeHandler(AUTOMATION_IPC_CHANNELS.CREATE)
  ipcMain.removeHandler(AUTOMATION_IPC_CHANNELS.UPDATE)
  ipcMain.removeHandler(AUTOMATION_IPC_CHANNELS.DELETE)
  ipcMain.removeHandler(AUTOMATION_IPC_CHANNELS.TOGGLE)

  const listEventsChannel = 'automation:list-events'
  ipcMain.removeHandler(listEventsChannel)
  ipcMain.handle(AUTOMATION_IPC_CHANNELS.LIST, () => listAutomations())
  ipcMain.handle(AUTOMATION_IPC_CHANNELS.CREATE, (_event, input: CreateAutomationInput) =>
    createAutomation(input),
  )
  ipcMain.handle(AUTOMATION_IPC_CHANNELS.UPDATE, (_event, input: UpdateAutomationInput) =>
    updateAutomation(input),
  )
  ipcMain.handle(AUTOMATION_IPC_CHANNELS.DELETE, (_event, id: string) => deleteAutomation(id))
  ipcMain.handle(AUTOMATION_IPC_CHANNELS.TOGGLE, (_event, id: string) => toggleAutomation(id))
  ipcMain.handle(listEventsChannel, (_event, automationId?: string) =>
    listAutomationEvents(automationId),
  )
}
