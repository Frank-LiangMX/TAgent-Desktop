/** TAgent managed browser contract. */
export interface BrowserBounds { x: number; y: number; width: number; height: number }
export type BrowserWorkspaceStatus = 'idle' | 'loading' | 'ready' | 'waiting-user' | 'error'
export interface BrowserTabState { id: string; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
export interface BrowserWorkspaceState { sessionId: string; activeTabId: string | null; tabs: BrowserTabState[]; status: BrowserWorkspaceStatus; error?: string; takeoverReason?: string }
export interface BrowserOpenRequest { sessionId: string; title?: string; requestId: number }
export interface BrowserCloseRequest { sessionId: string }
export interface BrowserEnsureRequest { sessionId: string }
export interface BrowserSetBoundsRequest { sessionId: string; bounds: BrowserBounds; visible: boolean }
export interface BrowserNavigateRequest { sessionId: string; url: string }
export interface BrowserTabRequest { sessionId: string; tabId?: string; url?: string }
export interface BrowserElementActionRequest { sessionId: string; ref: string; text?: string; pressEnter?: boolean }
export interface BrowserScrollRequest { sessionId: string; deltaX?: number; deltaY?: number }
export interface BrowserTakeoverRequest { sessionId: string; reason?: string }
export interface BrowserScreenshotResult { sessionId: string; tabId: string; dataUrl: string; width: number; height: number }
export interface BrowserElementRef { ref: string; role: string; name: string; tagName: string; editable: boolean }
export interface BrowserObserveResult { sessionId: string; tabId: string; url: string; title: string; generation: number; elements: BrowserElementRef[] }
export interface BrowserPageTextResult { sessionId: string; tabId: string; url: string; title: string; text: string }
export interface BrowserDetachedWindowState { sessionId: string; url: string; title: string }
export interface BrowserActionResult { ok: boolean; message?: string; state?: BrowserWorkspaceState }
export const BROWSER_IPC_CHANNELS = {
  OPEN: 'browser:open', OPEN_WINDOW: 'browser:open-window',ENSURE: 'browser:ensure', SET_BOUNDS: 'browser:set-bounds', HIDE: 'browser:hide', NAVIGATE: 'browser:navigate',
  BACK: 'browser:back', FORWARD: 'browser:forward', RELOAD: 'browser:reload', NEW_TAB: 'browser:new-tab',
  CLOSE_TAB: 'browser:close-tab', SELECT_TAB: 'browser:select-tab', OBSERVE: 'browser:observe', EXTRACT_TEXT: 'browser:extract-text', EXTRACT_WINDOW_TEXT: 'browser:extract-window-text', CLICK: 'browser:click',
  TYPE: 'browser:type', SCROLL: 'browser:scroll', SCREENSHOT: 'browser:screenshot', STOP: 'browser:stop',
  TAKEOVER: 'browser:takeover', RESUME: 'browser:resume', STATE_CHANGED: 'browser:state-changed', OPEN_REQUEST: 'browser:open-request', CLOSE_REQUEST: 'browser:close-request',
} as const
