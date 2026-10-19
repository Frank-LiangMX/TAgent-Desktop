import { ipcMain, type BrowserWindow } from 'electron'
import {
  downloadWhisperModel,
  downloadWhisperRuntime,
  getWhisperModelStatus,
  setWhisperModel,
  type WhisperModelId,
} from './video-model-manager'

export const VIDEO_MODEL_IPC = {
  STATUS: 'video-model:status',
  DOWNLOAD: 'video-model:download',
  RUNTIME_DOWNLOAD: 'video-model:runtime-download',
  SELECT: 'video-model:select',
  PROGRESS: 'video-model:progress',
  RUNTIME_PROGRESS: 'video-model:runtime-progress',
} as const

let downloading = false
let downloadingRuntime = false

export function registerVideoModelIpc(getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(VIDEO_MODEL_IPC.STATUS, () => getWhisperModelStatus())
  ipcMain.handle(VIDEO_MODEL_IPC.SELECT, async (_event, id: WhisperModelId) => {
    setWhisperModel(id)
    return getWhisperModelStatus()
  })
  ipcMain.handle(VIDEO_MODEL_IPC.DOWNLOAD, async (_event, id: WhisperModelId) => {
    if (downloading) throw new Error('已有 Whisper 模型正在下载')
    downloading = true
    try {
      await downloadWhisperModel(id, (progress) => getWindow()?.webContents.send(VIDEO_MODEL_IPC.PROGRESS, progress))
      return getWhisperModelStatus()
    } finally {
      downloading = false
    }
  })
  ipcMain.handle(VIDEO_MODEL_IPC.RUNTIME_DOWNLOAD, async () => {
    if (downloadingRuntime) throw new Error('语音引擎正在下载')
    downloadingRuntime = true
    try {
      await downloadWhisperRuntime((progress) => getWindow()?.webContents.send(VIDEO_MODEL_IPC.RUNTIME_PROGRESS, progress))
      return getWhisperModelStatus()
    } finally { downloadingRuntime = false }
  })
}
