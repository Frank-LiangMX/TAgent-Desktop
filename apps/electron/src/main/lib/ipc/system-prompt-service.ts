/**
 * 系统提示词 IPC：设置页 CRUD
 */
import { ipcMain } from 'electron'
import {
  SYSTEM_PROMPT_IPC_CHANNELS,
  type SystemPrompt,
  type SystemPromptConfig,
  type SystemPromptCreateInput,
  type SystemPromptUpdateInput,
} from '@tagent/shared'
import {
  createSystemPrompt,
  deleteSystemPrompt,
  getSystemPromptConfig,
  setDefaultPrompt,
  updateAppendSetting,
  updateSystemPrompt,
} from '../system-prompt-manager'

export class SystemPromptService {
  static create(): SystemPromptService {
    const svc = new SystemPromptService()
    svc.registerIpc()
    return svc
  }

  private registerIpc(): void {
    ipcMain.handle(
      SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG,
      async (): Promise<SystemPromptConfig> => getSystemPromptConfig(),
    )

    ipcMain.handle(
      SYSTEM_PROMPT_IPC_CHANNELS.CREATE,
      async (_e, input: SystemPromptCreateInput): Promise<SystemPrompt> => createSystemPrompt(input),
    )

    ipcMain.handle(
      SYSTEM_PROMPT_IPC_CHANNELS.UPDATE,
      async (_e, id: string, input: SystemPromptUpdateInput): Promise<SystemPrompt> =>
        updateSystemPrompt(id, input),
    )

    ipcMain.handle(SYSTEM_PROMPT_IPC_CHANNELS.DELETE, async (_e, id: string): Promise<void> => {
      deleteSystemPrompt(id)
    })

    ipcMain.handle(
      SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING,
      async (_e, enabled: boolean): Promise<void> => {
        updateAppendSetting(enabled)
      },
    )

    ipcMain.handle(
      SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT,
      async (_e, id: string | null): Promise<void> => {
        setDefaultPrompt(id)
      },
    )
  }
}
