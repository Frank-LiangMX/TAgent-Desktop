import { WebContentsView, type BrowserWindow } from 'electron'
import {
  BROWSER_IPC_CHANNELS,
  type BrowserActionResult,
  type BrowserBounds,
  type BrowserElementActionRequest,
  type BrowserElementRef,
  type BrowserNavigateRequest,
  type BrowserObserveResult,
  type BrowserScreenshotResult,
  type BrowserScrollRequest,
  type BrowserSetBoundsRequest,
  type BrowserTabRequest,
  type BrowserWorkspaceState,
  type BrowserWorkspaceStatus,
} from '@tagent/shared'
import { isAllowedBrowserUrl, normalizeBrowserUrl } from './browser-policy'

interface BrowserTabRuntime {
  id: string
  view: WebContentsView
  title: string
  url: string
  loading: boolean
  generation: number
}

interface BrowserWorkspaceRuntime {
  sessionId: string
  tabs: Map<string, BrowserTabRuntime>
  activeTabId: string | null
  status: BrowserWorkspaceStatus
  error?: string
  takeoverReason?: string
  bounds?: BrowserBounds
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 72) || 'session'
}

function action(ok: boolean, message?: string): BrowserActionResult {
  return { ok, ...(message ? { message } : {}) }
}

export class BrowserController {
  private readonly workspaces = new Map<string, BrowserWorkspaceRuntime>()
  private nextTabNumber = 1
  private nextRequestId = 1

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private window(): BrowserWindow {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) throw new Error('主窗口尚未就绪')
    return win
  }

  private workspace(sessionId: string): BrowserWorkspaceRuntime {
    let workspace = this.workspaces.get(sessionId)
    if (!workspace) {
      workspace = { sessionId, tabs: new Map(), activeTabId: null, status: 'idle' }
      this.workspaces.set(sessionId, workspace)
    }
    return workspace
  }

  private activeTab(sessionId: string): BrowserTabRuntime {
    const workspace = this.workspace(sessionId)
    const tab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : undefined
    if (!tab) throw new Error('浏览器没有活动标签')
    return tab
  }

  private publish(workspace: BrowserWorkspaceRuntime): BrowserWorkspaceState {
    const state: BrowserWorkspaceState = {
      sessionId: workspace.sessionId,
      activeTabId: workspace.activeTabId,
      tabs: [...workspace.tabs.values()].map((tab) => {
        let url = tab.url
        let canGoBack = false
        let canGoForward = false
        try {
          url = tab.view.webContents.getURL() || url
          canGoBack = tab.view.webContents.canGoBack()
          canGoForward = tab.view.webContents.canGoForward()
        } catch {
          /* renderer is shutting down */
        }
        return {
          id: tab.id,
          title: tab.title || url || '新标签页',
          url,
          loading: tab.loading,
          canGoBack,
          canGoForward,
        }
      }),
      status: workspace.status,
      ...(workspace.error ? { error: workspace.error } : {}),
      ...(workspace.takeoverReason ? { takeoverReason: workspace.takeoverReason } : {}),
    }
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(BROWSER_IPC_CHANNELS.STATE_CHANGED, state)
    return state
  }

  private attachTab(workspace: BrowserWorkspaceRuntime, tab: BrowserTabRuntime): void {
    const wc = tab.view.webContents
    wc.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    wc.session.setPermissionCheckHandler(() => false)

    const updateUrl = (): void => {
      try {
        tab.url = wc.getURL() || tab.url
      } catch {
        /* ignore */
      }
      this.publish(workspace)
    }

    wc.on('did-start-loading', () => {
      tab.loading = true
      workspace.status = 'loading'
      workspace.error = undefined
      this.publish(workspace)
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      if (workspace.status === 'loading') workspace.status = 'ready'
      updateUrl()
    })
    wc.on('did-navigate', () => {
      tab.generation += 1
      updateUrl()
    })
    wc.on('did-navigate-in-page', () => {
      tab.generation += 1
      updateUrl()
    })
    wc.on('page-title-updated', (_event, title) => {
      tab.title = title || tab.title
      this.publish(workspace)
    })
    wc.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.loading = false
      workspace.status = 'error'
      workspace.error = errorDescription || '页面加载失败'
      this.publish(workspace)
    })
    wc.on('render-process-gone', (_event, details) => {
      workspace.status = 'error'
      workspace.error = '网页进程已退出：' + details.reason
      this.publish(workspace)
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (!isAllowedBrowserUrl(url)) return { action: 'deny' }
      void this.newTab({ sessionId: workspace.sessionId, url })
      return { action: 'deny' }
    })
  }

  private addTab(workspace: BrowserWorkspaceRuntime, inputUrl = 'about:blank'): BrowserTabRuntime {
    const url = normalizeBrowserUrl(inputUrl)
    const win = this.window()
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:tagent-browser-' + safeId(workspace.sessionId),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    const tab: BrowserTabRuntime = {
      id: 'browser-tab-' + this.nextTabNumber++,
      view,
      title: url === 'about:blank' ? '新标签页' : url,
      url,
      loading: false,
      generation: 0,
    }
    for (const oldTab of workspace.tabs.values()) oldTab.view.setVisible(false)
    workspace.tabs.set(tab.id, tab)
    workspace.activeTabId = tab.id
    win.contentView.addChildView(view)
    if (workspace.bounds) {
      view.setBounds({
        x: Math.max(0, Math.round(workspace.bounds.x)),
        y: Math.max(0, Math.round(workspace.bounds.y)),
        width: Math.max(1, Math.round(workspace.bounds.width)),
        height: Math.max(1, Math.round(workspace.bounds.height)),
      })
      view.setVisible(true)
    } else {
      view.setVisible(false)
    }
    this.attachTab(workspace, tab)
    void view.webContents.loadURL(url).catch((error: unknown) => {
      workspace.status = 'error'
      workspace.error = error instanceof Error ? error.message : String(error)
      this.publish(workspace)
    })
    return tab
  }

  async ensure(sessionId: string): Promise<BrowserWorkspaceState> {
    const workspace = this.workspace(sessionId)
    if (workspace.tabs.size === 0) this.addTab(workspace)
    return this.publish(workspace)
  }

  async open(sessionId: string, url?: string, title?: string): Promise<BrowserWorkspaceState> {
    const workspace = this.workspace(sessionId)
    if (workspace.tabs.size === 0) this.addTab(workspace, url || 'about:blank')
    else if (url) await this.navigate({ sessionId, url })
    this.requestOpen(sessionId, title)
    return this.publish(workspace)
  }

  requestOpen(sessionId: string, title?: string): void {
    const win = this.window()
    win.webContents.send(BROWSER_IPC_CHANNELS.OPEN_REQUEST, {
      sessionId,
      ...(title ? { title } : {}),
      requestId: this.nextRequestId++,
    })
  }

  getState(sessionId: string): BrowserWorkspaceState {
    return this.publish(this.workspace(sessionId))
  }

  setBounds(input: BrowserSetBoundsRequest): BrowserWorkspaceState {
    const workspace = this.workspace(input.sessionId)
    const tab = this.activeTab(input.sessionId)
    workspace.bounds = input.bounds
    tab.view.setBounds({
      x: Math.max(0, Math.round(input.bounds.x)),
      y: Math.max(0, Math.round(input.bounds.y)),
      width: Math.max(1, Math.round(input.bounds.width)),
      height: Math.max(1, Math.round(input.bounds.height)),
    })
    tab.view.setVisible(input.visible)
    return this.publish(workspace)
  }

  hide(sessionId: string): BrowserActionResult {
    for (const tab of this.workspace(sessionId).tabs.values()) tab.view.setVisible(false)
    return action(true)
  }

  async navigate(input: BrowserNavigateRequest): Promise<BrowserWorkspaceState> {
    const workspace = this.workspace(input.sessionId)
    const tab = this.activeTab(input.sessionId)
    const url = normalizeBrowserUrl(input.url)
    workspace.status = 'loading'
    workspace.error = undefined
    tab.url = url
    await tab.view.webContents.loadURL(url)
    return this.publish(workspace)
  }

  back(sessionId: string): BrowserWorkspaceState {
    const tab = this.activeTab(sessionId)
    if (tab.view.webContents.canGoBack()) tab.view.webContents.goBack()
    return this.getState(sessionId)
  }

  forward(sessionId: string): BrowserWorkspaceState {
    const tab = this.activeTab(sessionId)
    if (tab.view.webContents.canGoForward()) tab.view.webContents.goForward()
    return this.getState(sessionId)
  }

  reload(sessionId: string): BrowserWorkspaceState {
    const workspace = this.workspace(sessionId)
    workspace.status = 'loading'
    this.activeTab(sessionId).view.webContents.reload()
    return this.publish(workspace)
  }

  async newTab(input: BrowserTabRequest): Promise<BrowserWorkspaceState> {
    this.addTab(this.workspace(input.sessionId), input.url || 'about:blank')
    return this.getState(input.sessionId)
  }

  closeTab(input: BrowserTabRequest): BrowserWorkspaceState {
    const workspace = this.workspace(input.sessionId)
    const tabId = input.tabId || workspace.activeTabId
    const tab = tabId ? workspace.tabs.get(tabId) : undefined
    if (!tab) return this.publish(workspace)
    const wasActive = workspace.activeTabId === tab.id
    workspace.tabs.delete(tab.id)
    try {
      this.window().contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    } catch {
      /* window may be closing */
    }
    if (wasActive) {
      const next = [...workspace.tabs.values()].at(-1)
      workspace.activeTabId = next?.id || null
      next?.view.setVisible(Boolean(workspace.bounds))
    }
    if (workspace.tabs.size === 0) this.addTab(workspace)
    return this.publish(workspace)
  }

  selectTab(input: BrowserTabRequest): BrowserWorkspaceState {
    const workspace = this.workspace(input.sessionId)
    const tab = input.tabId ? workspace.tabs.get(input.tabId) : undefined
    if (!tab) return this.publish(workspace)
    for (const candidate of workspace.tabs.values()) candidate.view.setVisible(false)
    workspace.activeTabId = tab.id
    tab.view.setVisible(Boolean(workspace.bounds))
    return this.publish(workspace)
  }

  async observe(sessionId: string): Promise<BrowserObserveResult> {
    const workspace = this.workspace(sessionId)
    const tab = this.activeTab(sessionId)
    const generation = ++tab.generation
    const script = [
      '(function () {',
      'const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=\\"button\\"],[contenteditable=\\"true\\"]"));',
      'return nodes.filter((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).slice(0, 80).map((node, index) => {',
      'const ref = "b-" + ' + String(generation) + ' + "-" + index;',
      'node.setAttribute("data-tagent-ref", ref);',
      'const tag = node.tagName.toLowerCase();',
      'const editable = tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable;',
      'const role = node.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : editable ? "textbox" : tag);',
      'const name = (node.getAttribute("aria-label") || node.innerText || node.value || node.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 160);',
      'return { ref, role, name, tagName: tag, editable };',
      '});',
      '})()',
    ].join('\n')
    const elements = (await tab.view.webContents.executeJavaScript(script)) as BrowserElementRef[]
    let url = tab.url
    let title = tab.title
    try {
      url = tab.view.webContents.getURL() || url
      title = tab.view.webContents.getTitle() || title
    } catch {
      /* ignore */
    }
    return { sessionId, tabId: tab.id, url, title, generation, elements: Array.isArray(elements) ? elements : [] }
  }

  private validateRef(tab: BrowserTabRuntime, ref: string): void {
    const match = /^b-(\d+)-\d+$/.exec(ref)
    if (!match || Number(match[1]) !== tab.generation) {
      throw new Error('页面元素引用已过期，请先重新 browser_observe')
    }
  }

  async click(input: BrowserElementActionRequest): Promise<BrowserActionResult> {
    const tab = this.activeTab(input.sessionId)
    this.validateRef(tab, input.ref)
    const script = '(function () { const node = document.querySelector("[data-tagent-ref=" + ' + JSON.stringify(input.ref) + ' + "]"); if (!node) return false; node.scrollIntoView({ block: "center", inline: "nearest" }); node.click(); return true; })()'
    const clicked = await tab.view.webContents.executeJavaScript(script)
    return clicked ? action(true, '已点击页面元素') : action(false, '找不到页面元素，请重新观察页面')
  }

  async type(input: BrowserElementActionRequest): Promise<BrowserActionResult> {
    const tab = this.activeTab(input.sessionId)
    this.validateRef(tab, input.ref)
    const text = String(input.text ?? '')
    const enter = input.pressEnter
      ? ' node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));'
      : ''
    const script = '(function () { const node = document.querySelector("[data-tagent-ref=" + ' + JSON.stringify(input.ref) + ' + "]"); if (!node) return false; node.focus(); const value = ' + JSON.stringify(text) + '; if (node.isContentEditable) node.textContent = value; else { const setter = Object.getOwnPropertyDescriptor(node.__proto__, "value")?.set; if (setter) setter.call(node, value); else node.value = value; } node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true }));' + enter + ' return true; })()'
    const typed = await tab.view.webContents.executeJavaScript(script)
    return typed ? action(true, '已填写页面元素') : action(false, '找不到可填写元素，请重新观察页面')
  }

  async scroll(input: BrowserScrollRequest): Promise<BrowserActionResult> {
    const tab = this.activeTab(input.sessionId)
    const deltaX = Math.max(-5000, Math.min(5000, Number(input.deltaX ?? 0)))
    const deltaY = Math.max(-5000, Math.min(5000, Number(input.deltaY ?? 700)))
    await tab.view.webContents.executeJavaScript('window.scrollBy(' + JSON.stringify(deltaX) + ', ' + JSON.stringify(deltaY) + ')')
    return action(true, '已滚动页面')
  }

  async screenshot(sessionId: string): Promise<BrowserScreenshotResult> {
    const tab = this.activeTab(sessionId)
    const image = await tab.view.webContents.capturePage()
    const size = image.getSize()
    const scale = Math.min(1, 1280 / Math.max(size.width, 1), 900 / Math.max(size.height, 1))
    const output = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)) }) : image
    const outputSize = output.getSize()
    return { sessionId, tabId: tab.id, dataUrl: output.toDataURL(), width: outputSize.width, height: outputSize.height }
  }

  stop(sessionId: string): BrowserActionResult {
    this.activeTab(sessionId).view.webContents.stop()
    return action(true, '已停止页面加载')
  }

  takeover(sessionId: string, reason?: string): BrowserWorkspaceState {
    const workspace = this.workspace(sessionId)
    workspace.status = 'waiting-user'
    workspace.takeoverReason = reason || '请在浏览器标签中完成登录、验证码或其他人工步骤'
    return this.publish(workspace)
  }

  resume(sessionId: string): BrowserWorkspaceState {
    const workspace = this.workspace(sessionId)
    workspace.status = 'ready'
    workspace.takeoverReason = undefined
    workspace.error = undefined
    return this.publish(workspace)
  }

  dispose(): void {
    for (const workspace of this.workspaces.values()) {
      for (const tab of workspace.tabs.values()) {
        try {
          this.window().contentView.removeChildView(tab.view)
          tab.view.webContents.close()
        } catch {
          /* ignore */
        }
      }
    }
    this.workspaces.clear()
  }
}
