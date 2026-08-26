import { BrowserWindow, WebContentsView, nativeTheme, type WebContents } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  BROWSER_IPC_CHANNELS,
  type BrowserActionResult,
  type BrowserBounds,
  type BrowserDetachedWindowState,
  type BrowserPageTextResult,
  type BrowserCloseRequest,
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

function browserWindowTitle(pageTitle?: string): string {
  const normalized = pageTitle?.trim()
  return normalized ? `内置浏览器 - ${normalized}` : '内置浏览器'
}

function browserWindowIconPath(): string {
  const fromDist = path.join(__dirname, 'resources')
  const resourcesDir = existsSync(fromDist) ? fromDist : path.join(__dirname, '..', 'resources')
  return path.join(resourcesDir, 'logo', 'appicon', nativeTheme.shouldUseDarkColors ? 'dark.png' : 'light.png')
}

function action(ok: boolean, message?: string): BrowserActionResult {
  return { ok, ...(message ? { message } : {}) }
}

const EXTRACT_PAGE_TEXT_SCRIPT = "(function () {\n  const emojiPattern = /[\\p{Extended_Pictographic}\\uFE0F\\u200D]/gu\n  const hiddenLinePattern = /^(编辑|预览|保存|分享|评论|插入|WPS AI|正文|撤销|重做|设置|搜索|更多|协作|通知)$/\n  const visible = (element) => {\n    if (!(element instanceof Element)) return false\n    const style = getComputedStyle(element)\n    const rect = element.getBoundingClientRect()\n    return style.display !== \"none\" && style.visibility !== \"hidden\" && style.opacity !== \"0\" && rect.width > 0 && rect.height > 0\n  }\n  const clean = (raw, dropUi) => {\n    const lines = String(raw || \"\")\n      .replace(/\\u00a0/g, \" \")\n      .split(/\\r?\\n/)\n      .map((line) => line.replace(/[ \\t]+/g, \" \").trim())\n      .map((line) => {\n        const emojiCount = (line.match(emojiPattern) || []).length\n        const firstEmoji = line.search(emojiPattern)\n        if (emojiCount >= 12 && firstEmoji >= 0) return line.slice(0, firstEmoji).trim()\n        return line\n      })\n      .filter((line) => line && (!dropUi || !hiddenLinePattern.test(line)))\n    return lines.join(\"\\n\").replace(/\\n{3,}/g, \"\\n\\n\").trim()\n  }\n  const render = (node) => {\n    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || \"\"\n    if (node.nodeType !== Node.ELEMENT_NODE) return \"\"\n    const element = node\n    if (!visible(element)) return \"\"\n    const tag = element.tagName.toLowerCase()\n    const className = typeof element.className === \"string\" ? element.className.toLowerCase() : \"\"\n    if (element.getAttribute(\"role\") === \"button\" || /toolbar|sidebar|topbar|navbar|comment-panel|share-panel|modal|dialog/.test(className)) return \"\"\n    if ([\"script\", \"style\", \"noscript\", \"template\", \"svg\", \"nav\", \"header\", \"footer\", \"aside\", \"button\", \"input\", \"textarea\"].includes(tag)) return \"\"\n    if (tag === \"br\") return \"\\n\"\n    if (tag === \"table\") {\n      const rows = Array.from(element.querySelectorAll(\"tr\")).map((row) => Array.from(row.querySelectorAll(\"th,td\")).map((cell) => clean(cell.innerText || cell.textContent || \"\", false).replace(/\\n/g, \" \")))\n      return rows.filter((row) => row.length).map((row, index) => \"| \" + row.join(\" | \") + \" |\" + (index === 0 ? \"\\n| \" + row.map(() => \"---\").join(\" | \") + \" |\" : \"\")).join(\"\\n\") + \"\\n\\n\"\n    }\n    const inner = Array.from(element.childNodes).map(render).join(\"\")\n    if ([\"h1\", \"h2\", \"h3\", \"h4\", \"h5\", \"h6\"].includes(tag)) return \"\\n\\n\" + \"#\".repeat(Number(tag.slice(1))) + \" \" + inner.trim() + \"\\n\\n\"\n    if (tag === \"li\") return \"- \" + inner.trim() + \"\\n\"\n    if (tag === \"a\") { const href = element.href; return inner.trim() && href ? \"[\" + inner.trim() + \"](\" + href + \")\" : inner }\n    if ([\"strong\", \"b\"].includes(tag)) return inner.trim() ? \"**\" + inner.trim() + \"**\" : inner\n    if ([\"em\", \"i\"].includes(tag)) return inner.trim() ? \"*\" + inner.trim() + \"*\" : inner\n    if (tag === \"pre\") return \"\\n\\n~~~\\n\" + (element.innerText || inner).trim() + \"\\n~~~\\n\\n\"\n    if (tag === \"blockquote\") return \"\\n\\n\" + inner.split(\"\\n\").map((line) => line ? \"> \" + line : line).join(\"\\n\") + \"\\n\\n\"\n    if ([\"p\", \"div\", \"section\", \"article\", \"ul\", \"ol\", \"dl\"].includes(tag)) return \"\\n\\n\" + inner.trim() + \"\\n\\n\"\n    return inner\n  }\n  const candidates = []\n  const seen = new Set()\n  const add = (element, priority) => {\n    if (!visible(element) || seen.has(element)) return\n    seen.add(element)\n    const plain = clean(element.innerText || element.textContent || \"\", element === document.body)\n    if (plain.length < 20) return\n    const formatted = clean(render(element), element === document.body)\n    const value = formatted.length >= 20 ? formatted : plain\n    const uiWords = (plain.match(/编辑|预览|保存|分享|评论|插入|WPS AI|协作|通知/g) || []).length\n    const score = Math.min(plain.length, 30000) + priority * 5000 + Math.min(plain.split(\"\\n\").length, 120) * 20 - uiWords * 350\n    candidates.push({ value, score })\n  }\n  add(document.body, 0)\n  const selectors = [\n    [\"[contenteditable=\\\"true\\\"]\", 100],\n    [\"[role=\\\"textbox\\\"]\", 90],\n    [\"main\", 75], [\"article\", 75], [\"[role=\\\"main\\\"]\", 75],\n    [\"[class*=\\\"editor\\\" i]\", 70], [\"[class*=\\\"document\\\" i]\", 70],\n    [\"[class*=\\\"page\\\" i]\", 65], [\"[class*=\\\"content\\\" i]\", 60], [\"[class*=\\\"canvas\\\" i]\", 55],\n  ]\n  for (const [selector, priority] of selectors) {\n    try { document.querySelectorAll(selector).forEach((element) => add(element, priority)) } catch {}\n  }\n  candidates.sort((a, b) => b.score - a.score)\n  const best = candidates[0]\n  return { title: document.title || \"\", text: best?.value || \"\", score: best?.score || 0 }\n})()"
export class BrowserController {
  private readonly workspaces = new Map<string, BrowserWorkspaceRuntime>()
  private nextTabNumber = 1
  private nextRequestId = 1
  private readonly detachedWindows = new Map<string, BrowserWindow>()

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

  private async extractFromContents(contents: WebContents, sessionId: string, tabId: string): Promise<BrowserPageTextResult> {
    const frames = [contents.mainFrame, ...contents.mainFrame.frames]
    const results: Array<{ text: string; score: number; title?: string }> = []
    for (const frame of frames) {
      try {
        const result = (await frame.executeJavaScript(EXTRACT_PAGE_TEXT_SCRIPT)) as { text?: string; score?: number; title?: string }
        if (result?.text?.trim()) results.push({ text: result.text, score: result.score || 0, title: result.title })
      } catch {
        // 跨域或已销毁 frame 无法读取时跳过。
      }
    }
    results.sort((a, b) => b.score - a.score)
    const best = results[0]
    return {
      sessionId,
      tabId,
      url: contents.getURL(),
      title: contents.getTitle() || best?.title || '',
      text: best?.text || '',
    }
  }

  async openDetached(sessionId: string, url: string, title?: string): Promise<BrowserDetachedWindowState> {
    const normalizedUrl = normalizeBrowserUrl(url)
    let detached = this.detachedWindows.get(sessionId)
    if (!detached || detached.isDestroyed()) {
      detached = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 900,
        minHeight: 640,
        show: false,
        parent: this.window(),
        title: browserWindowTitle(title),
        ...(existsSync(browserWindowIconPath()) ? { icon: browserWindowIconPath() } : {}),
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          partition: 'persist:tagent-browser-' + safeId(sessionId),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      })
      detached.setMenuBarVisibility(false)
      detached.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      detached.webContents.session.setPermissionCheckHandler(() => false)
      detached.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
        if (!isAllowedBrowserUrl(nextUrl)) return { action: 'deny' }
        void detached?.loadURL(nextUrl).catch(() => undefined)
        return { action: 'deny' }
      })
      detached.on('closed', () => {
        if (this.detachedWindows.get(sessionId) === detached) this.detachedWindows.delete(sessionId)
      })
      this.detachedWindows.set(sessionId, detached)
    } else {
      detached.setTitle(browserWindowTitle(title))
    }
    const updateDetachedTitle = (_event: unknown, pageTitle: string): void => {
      if (!detached || detached.isDestroyed()) return
      detached.setTitle(browserWindowTitle(pageTitle))
    }
    detached.webContents.removeAllListeners("page-title-updated")
    detached.webContents.on("page-title-updated", updateDetachedTitle)
    try {
      await detached.loadURL(normalizedUrl)
    } catch {
      // 即使页面加载失败也显示窗口，让用户看到浏览器错误页或重试。
    }
    if (!detached.isDestroyed()) {
      detached.show()
      detached.focus()
    }
    return {
      sessionId,
      url: detached.isDestroyed() ? normalizedUrl : detached.webContents.getURL() || normalizedUrl,
      title: detached.isDestroyed() ? browserWindowTitle(title) : detached.getTitle() || browserWindowTitle(title),
    }
  }

  async extractDetachedText(sessionId: string): Promise<BrowserPageTextResult> {
    const detached = this.detachedWindows.get(sessionId)
    if (!detached || detached.isDestroyed()) throw new Error('独立浏览器窗口已关闭，请重新打开云文档')
    return this.extractFromContents(detached.webContents, sessionId, 'detached-window')
  }

  async extractText(sessionId: string): Promise<BrowserPageTextResult> {
    const tab = this.activeTab(sessionId)
    return this.extractFromContents(tab.view.webContents, sessionId, tab.id)
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
  private requestClose(sessionId: string): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    const request: BrowserCloseRequest = { sessionId }
    win.webContents.send(BROWSER_IPC_CHANNELS.CLOSE_REQUEST, request)
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

  /**
   * 清理一个会话的浏览器工作区。
   *
   * hide() 只负责把视图藏起来，不能释放 WebContentsView 及其页面进程；
   * Agent 一轮结束后需要走这里，避免每次网页调用都把标签页留在主窗口里。
   */
  disposeSession(sessionId: string): void {
    const workspace = this.workspaces.get(sessionId)
    if (!workspace) return

    const tabs = [...workspace.tabs.values()]
    workspace.tabs.clear()
    workspace.activeTabId = null
    workspace.status = 'idle'
    workspace.error = undefined
    workspace.takeoverReason = undefined
    workspace.bounds = undefined
    this.publish(workspace)
    this.workspaces.delete(sessionId)
    this.requestClose(sessionId)

    for (const tab of tabs) {
      try {
        const win = this.getWindow()
        if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view)
      } catch {
        /* window may be closing */
      }
      try {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      } catch {
        /* web contents may already be closed */
      }
    }
  }

  /**
   * Agent 轮次结束后的清理。
   * 人工接管是唯一需要跨轮保留浏览器的状态，等用户点击恢复后再清理。
   */
  cleanupAfterAgent(sessionId: string): void {
    const workspace = this.workspaces.get(sessionId)
    if (!workspace || workspace.status === 'waiting-user') return
    this.disposeSession(sessionId)
  }

  dispose(): void {
    for (const sessionId of [...this.workspaces.keys()]) this.disposeSession(sessionId)
    for (const detached of this.detachedWindows.values()) {
      try {
        if (!detached.isDestroyed()) detached.close()
      } catch {
        /* window may be closing */
      }
    }
    this.detachedWindows.clear()
  }
}
