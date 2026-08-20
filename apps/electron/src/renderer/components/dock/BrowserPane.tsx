import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Globe2,
  Plus,
  RotateCw,
  Square,
  UserRound,
  X,
} from 'lucide-react'
import type { BrowserWorkspaceState } from '@tagent/shared'
import { browserApi } from '../../atoms/browser'

interface BrowserPaneParams {
  sessionId: string
}

function initialState(sessionId: string): BrowserWorkspaceState {
  return {
    sessionId,
    activeTabId: null,
    tabs: [],
    status: 'idle',
  }
}

export function BrowserPane(props: IDockviewPanelProps<BrowserPaneParams>): JSX.Element {
  const sessionId = props.params?.sessionId
  const api = useMemo(() => browserApi(), [])
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState(() => initialState(sessionId))
  const [address, setAddress] = useState('')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [active, setActive] = useState(() => props.api.isActive)

  const applyState = useCallback((next: BrowserWorkspaceState): void => {
    if (next.sessionId !== sessionId) return
    setState(next)
    const tab = next.tabs.find((candidate) => candidate.id === next.activeTabId)
    if (tab) setAddress(tab.url === 'about:blank' ? '' : tab.url)
  }, [sessionId])

  const reportBounds = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport || !sessionId) return
    const rect = viewport.getBoundingClientRect()
    void api.browserSetBounds({
      sessionId,
      bounds: {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      },
      visible: active,
    }).then(applyState).catch(() => undefined)
  }, [active, api, applyState, sessionId])

  useEffect(() => {
    if (!sessionId) return
    let disposed = false
    void api.browserEnsure(sessionId).then((next) => {
      if (!disposed) applyState(next)
    }).catch(() => undefined)
    const offState = api.onBrowserStateChanged(applyState)
    const activeSubscription = props.api.onDidActiveChange((event) => {
      setActive(event.isActive)
      if (event.isActive) requestAnimationFrame(reportBounds)
      else void api.browserHide(sessionId).catch(() => undefined)
    })
    const observer = new ResizeObserver(() => {
      if (active) requestAnimationFrame(reportBounds)
    })
    if (viewportRef.current) observer.observe(viewportRef.current)
    requestAnimationFrame(reportBounds)
    return () => {
      disposed = true
      offState()
      activeSubscription.dispose()
      observer.disconnect()
      void api.browserHide(sessionId).catch(() => undefined)
    }
  }, [active, api, applyState, props.api, reportBounds, sessionId])

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  const statusText = state.status === 'waiting-user'
    ? state.takeoverReason || '等待你在网页中完成操作'
    : state.status === 'error'
      ? state.error || '网页加载失败，可重试'
      : state.status === 'loading'
        ? '页面加载中…'
        : 'Agent 可观察页面，也可由你直接接管'

  const navigate = (): void => {
    const url = address.trim()
    if (!url) return
    void api.browserNavigate({ sessionId, url }).then(applyState).catch(() => undefined)
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/30 px-2">
        <IconButton label="后退" disabled={!activeTab?.canGoBack} onClick={() => void api.browserBack(sessionId).then(applyState)}>
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <IconButton label="前进" disabled={!activeTab?.canGoForward} onClick={() => void api.browserForward(sessionId).then(applyState)}>
          <ArrowRight className="size-3.5" />
        </IconButton>
        <IconButton label="重新加载" onClick={() => void api.browserReload(sessionId).then(applyState)}>
          <RotateCw className="size-3.5" />
        </IconButton>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border/70 bg-background/80 px-2">
          <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') navigate() }}
            aria-label="网页地址"
            placeholder="输入 http(s) 地址"
            className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <IconButton label="截图" onClick={() => void api.browserScreenshot(sessionId).then((image) => setScreenshot(image.dataUrl)).catch(() => undefined)}>
          <Camera className="size-3.5" />
        </IconButton>
        <IconButton label="停止加载" onClick={() => void api.browserStop(sessionId)}>
          <Square className="size-3.5" />
        </IconButton>
        {state.status === 'waiting-user' ? (
          <IconButton label="恢复 Agent" onClick={() => void api.browserResume(sessionId).then(applyState)}>
            <Check className="size-3.5" />
          </IconButton>
        ) : (
          <IconButton label="人工接管" onClick={() => void api.browserTakeover({ sessionId }).then(applyState)}>
            <UserRound className="size-3.5" />
          </IconButton>
        )}
      </div>

      <div className="flex min-h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 bg-muted/15 px-2">
        {state.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => void api.browserSelectTab({ sessionId, tabId: tab.id }).then(applyState)}
            className="group flex h-7 max-w-52 min-w-24 items-center gap-1 rounded-t-md border border-b-0 border-transparent px-2 text-[11px] text-muted-foreground hover:bg-muted/60 data-[active=true]:border-border/60 data-[active=true]:bg-background data-[active=true]:text-foreground"
            data-active={tab.id === state.activeTabId}
            title={tab.url}
          >
            <span className="min-w-0 flex-1 truncate">{tab.title || '新标签页'}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label="关闭网页标签"
              onClick={(event) => {
                event.stopPropagation()
                void api.browserCloseTab({ sessionId, tabId: tab.id }).then(applyState)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  void api.browserCloseTab({ sessionId, tabId: tab.id }).then(applyState)
                }
              }}
              className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
            >
              <X className="size-3" />
            </span>
          </button>
        ))}
        <button
          type="button"
          aria-label="新建网页标签"
          title="新建网页标签"
          onClick={() => void api.browserNewTab({ sessionId }).then(applyState)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
        <span className="ml-auto truncate px-2 text-[10px] text-muted-foreground/80">{statusText}</span>
      </div>

      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-white dark:bg-zinc-950">
        {state.status === 'error' && (
          <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-destructive/30 bg-background/90 px-3 py-2 text-xs shadow-sm">
            {state.error || '网页加载失败'}
          </div>
        )}
      </div>

      {screenshot && (
        <div className="absolute inset-4 z-30 flex items-center justify-center rounded-lg border border-border bg-background/95 p-3 shadow-2xl">
          <button
            type="button"
            aria-label="关闭截图"
            onClick={() => setScreenshot(null)}
            className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
          <img src={screenshot} alt="当前网页截图" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  )
}

function IconButton(props: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {props.children}
    </button>
  )
}
