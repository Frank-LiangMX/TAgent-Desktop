import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, Globe, X } from "@phosphor-icons/react";
import type { BrowserWorkspaceState } from "@tagent/shared";
import { Button } from "@tagent/ui";
import { browserApi } from "../../atoms/browser";

interface KnowledgeBaseBrowserModalProps {
  sessionId: string;
  onClose: () => void;
}

function initialState(sessionId: string): BrowserWorkspaceState {
  return {
    sessionId,
    activeTabId: null,
    tabs: [],
    status: "idle",
  };
}

export function KnowledgeBaseBrowserModal({
  sessionId,
  onClose,
}: KnowledgeBaseBrowserModalProps): JSX.Element {
  const api = useMemo(() => browserApi(), []);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState(() => initialState(sessionId));
  const [address, setAddress] = useState("");

  const applyState = useCallback(
    (next: BrowserWorkspaceState): void => {
      if (next.sessionId !== sessionId) return;
      setState(next);
      const tab = next.tabs.find(
        (candidate) => candidate.id === next.activeTabId,
      );
      if (tab) setAddress(tab.url === "about:blank" ? "" : tab.url);
    },
    [sessionId],
  );

  const reportBounds = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    void api
      .browserSetBounds({
        sessionId,
        bounds: {
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
        },
        visible: true,
      })
      .then(applyState)
      .catch(() => undefined);
  }, [api, applyState, sessionId]);

  useEffect(() => {
    let disposed = false;
    const offState = api.onBrowserStateChanged(applyState);
    void api
      .browserEnsure(sessionId)
      .then((next) => {
        if (!disposed) applyState(next);
        requestAnimationFrame(reportBounds);
      })
      .catch(() => undefined);
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(reportBounds);
    });
    if (viewportRef.current) observer.observe(viewportRef.current);
    requestAnimationFrame(reportBounds);
    return () => {
      disposed = true;
      offState();
      observer.disconnect();
      void api.browserHide(sessionId).catch(() => undefined);
    };
  }, [api, applyState, reportBounds, sessionId]);

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const statusText =
    state.status === "error"
      ? state.error || "网页加载失败"
      : state.status === "loading"
        ? "页面加载中…"
        : "请在此窗口中完成登录或扫码，并打开文档正文";

  const navigate = (): void => {
    const url = address.trim();
    if (!url) return;
    void api.browserNavigate({ sessionId, url }).then(applyState).catch(() => undefined);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]">
      <section className="flex h-[min(820px,calc(100vh-32px))] w-[min(1180px,calc(100vw-32px))] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <Globe size={20} className="text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">内置浏览器</h2>
            <p className="truncate text-xs text-muted-foreground">{statusText}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={17} />
            返回导入
          </Button>
        </header>
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/20 px-3 py-2">
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") navigate();
            }}
            aria-label="网页地址"
            placeholder="当前网页地址"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button variant="outline" size="sm" onClick={navigate} disabled={!address.trim()}>
            打开
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void api.browserReload(sessionId).then(applyState)}
          >
            <ArrowClockwise size={15} />
            刷新
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-8 shrink-0 items-center gap-2 border-b bg-muted/10 px-3 text-xs text-muted-foreground">
            <span className="truncate">{activeTab?.title || "云文档"}</span>
            <span className="ml-auto">登录完成后打开文档正文，再返回导入</span>
          </div>
          <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-white dark:bg-zinc-950">
            {state.status === "error" && (
              <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-destructive/30 bg-background/95 px-3 py-2 text-xs shadow-sm">
                {state.error || "网页加载失败"}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
