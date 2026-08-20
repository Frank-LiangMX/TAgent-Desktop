import { atom } from 'jotai'
import type {
  BrowserOpenRequest,
  BrowserWorkspaceState,
} from '@tagent/shared'

export const browserOpenRequestAtom = atom<BrowserOpenRequest | null>(null)
export const browserStateAtom = atom<Record<string, BrowserWorkspaceState>>({})

export type BrowserRendererApi = {
  browserEnsure: (sessionId: string) => Promise<BrowserWorkspaceState>
  browserSetBounds: (input: { sessionId: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }) => Promise<BrowserWorkspaceState>
  browserHide: (sessionId: string) => Promise<{ ok: boolean }>
  browserNavigate: (input: { sessionId: string; url: string }) => Promise<BrowserWorkspaceState>
  browserBack: (sessionId: string) => Promise<BrowserWorkspaceState>
  browserForward: (sessionId: string) => Promise<BrowserWorkspaceState>
  browserReload: (sessionId: string) => Promise<BrowserWorkspaceState>
  browserNewTab: (input: { sessionId: string; url?: string }) => Promise<BrowserWorkspaceState>
  browserCloseTab: (input: { sessionId: string; tabId?: string }) => Promise<BrowserWorkspaceState>
  browserSelectTab: (input: { sessionId: string; tabId: string }) => Promise<BrowserWorkspaceState>
  browserObserve: (sessionId: string) => Promise<unknown>
  browserScreenshot: (sessionId: string) => Promise<{ dataUrl: string }>
  browserStop: (sessionId: string) => Promise<{ ok: boolean; message?: string }>
  browserTakeover: (input: { sessionId: string; reason?: string }) => Promise<BrowserWorkspaceState>
  browserResume: (sessionId: string) => Promise<BrowserWorkspaceState>
  onBrowserStateChanged: (cb: (state: BrowserWorkspaceState) => void) => () => void
  onBrowserOpenRequest: (cb: (request: BrowserOpenRequest) => void) => () => void
}

export function browserApi(): BrowserRendererApi {
  return window.electronAPI as unknown as BrowserRendererApi
}
