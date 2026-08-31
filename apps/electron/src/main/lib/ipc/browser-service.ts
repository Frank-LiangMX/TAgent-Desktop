import { ipcMain, type BrowserWindow } from 'electron'
import {
  BROWSER_IPC_CHANNELS,
  type BrowserElementActionRequest,
  type BrowserNavigateRequest,
  type BrowserScrollRequest,
  type BrowserSetBoundsRequest,
  type BrowserTabRequest,
  type BrowserTakeoverRequest,
} from '@tagent/shared'
import { BrowserController } from '../browser/browser-controller'

let controller: BrowserController | null = null

export function getBrowserController(): BrowserController {
  if (!controller) throw new Error('浏览器服务尚未初始化')
  return controller
}

export class BrowserService {
  static create(getWindow: () => BrowserWindow | null): BrowserService {
    const service = new BrowserService(new BrowserController(getWindow))
    controller = service.controller
    service.register()
    return service
  }

  private constructor(private readonly controller: BrowserController) {}

  private register(): void {
    const replace = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    replace(BROWSER_IPC_CHANNELS.OPEN, (_event, input: { sessionId: string; url?: string; title?: string }) =>
      this.controller.open(input.sessionId, input.url, input.title),
    )
    replace(BROWSER_IPC_CHANNELS.OPEN_WINDOW, (_event, input: { sessionId: string; url: string; title?: string }) =>
      this.controller.openDetached(input.sessionId, input.url, input.title),
    )
    replace(BROWSER_IPC_CHANNELS.ENSURE, (_event, input: { sessionId: string }) =>
      this.controller.ensure(input.sessionId),
    )
    replace(BROWSER_IPC_CHANNELS.SET_BOUNDS, (_event, input: BrowserSetBoundsRequest) =>
      this.controller.setBounds(input),
    )
    replace(BROWSER_IPC_CHANNELS.HIDE, (_event, sessionId: string) => this.controller.hide(sessionId))
    replace(BROWSER_IPC_CHANNELS.NAVIGATE, (_event, input: BrowserNavigateRequest) =>
      this.controller.navigate(input),
    )
    replace(BROWSER_IPC_CHANNELS.BACK, (_event, sessionId: string) => this.controller.back(sessionId))
    replace(BROWSER_IPC_CHANNELS.FORWARD, (_event, sessionId: string) =>
      this.controller.forward(sessionId),
    )
    replace(BROWSER_IPC_CHANNELS.RELOAD, (_event, sessionId: string) => this.controller.reload(sessionId))
    replace(BROWSER_IPC_CHANNELS.NEW_TAB, (_event, input: BrowserTabRequest) =>
      this.controller.newTab(input),
    )
    replace(BROWSER_IPC_CHANNELS.CLOSE_TAB, (_event, input: BrowserTabRequest) =>
      this.controller.closeTab(input),
    )
    replace(BROWSER_IPC_CHANNELS.SELECT_TAB, (_event, input: BrowserTabRequest) =>
      this.controller.selectTab(input),
    )
    replace(BROWSER_IPC_CHANNELS.OBSERVE, (_event, sessionId: string) =>
      this.controller.observe(sessionId),
    )
    replace(BROWSER_IPC_CHANNELS.EXTRACT_TEXT, (_event, sessionId: string) =>
      this.controller.extractText(sessionId),
    )
    replace(BROWSER_IPC_CHANNELS.EXTRACT_WINDOW_TEXT, (_event, sessionId: string) =>
      this.controller.extractDetachedText(sessionId),
    )
    replace(BROWSER_IPC_CHANNELS.PREPARE_DOWNLOAD, (_event, sessionId: string) =>
      this.controller.prepareDownloadCapture(sessionId),
    )
    replace(BROWSER_IPC_CHANNELS.CLICK, (_event, input: BrowserElementActionRequest) =>
      this.controller.click(input),
    )
    replace(BROWSER_IPC_CHANNELS.TYPE, (_event, input: BrowserElementActionRequest) =>
      this.controller.type(input),
    )
    replace(BROWSER_IPC_CHANNELS.SCROLL, (_event, input: BrowserScrollRequest) =>
      this.controller.scroll(input),
    )
    replace(BROWSER_IPC_CHANNELS.SCREENSHOT, (_event, sessionId: string) =>
      this.controller.screenshot(sessionId),
    )
    replace(BROWSER_IPC_CHANNELS.STOP, (_event, sessionId: string) => this.controller.stop(sessionId))
    replace(BROWSER_IPC_CHANNELS.TAKEOVER, (_event, input: BrowserTakeoverRequest) =>
      this.controller.takeover(input.sessionId, input.reason),
    )
    replace(BROWSER_IPC_CHANNELS.RESUME, (_event, sessionId: string) =>
      this.controller.resume(sessionId),
    )
  }

  dispose(): void {
    this.controller.dispose()
    if (controller === this.controller) controller = null
  }
}
