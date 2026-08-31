/**
 * AppShell — 全局浮岛布局壳
 * 侧栏开合：原样使用 General NavIsland（morph 照抄）。
 * 顶栏中央 StatusTicker：滚动状态通知，少占主内容区。
 */
import type { ReactNode } from "react";
import { WindowControls } from "./WindowControls";
import { NavIsland, type PanelPresence } from "./NavIsland";
import { StatusTicker } from "./StatusTicker";
import { UpdateBanner } from "../updater/UpdateBanner";

interface AppShellProps {
  topbar?: ReactNode;
  rail?: ReactNode;
  sidebar?: ReactNode;
  sidebarOpen?: boolean;
  activeRailItem?: string | null;
  /** 顶栏运行态点击后定位对应会话。 */
  onOpenLiveSession?: (sessionId: string, title: string) => void;
  children?: ReactNode;
}

export function AppShell({
  topbar,
  rail,
  sidebar,
  sidebarOpen = true,
  activeRailItem = "chat",
  onOpenLiveSession,
  children,
}: AppShellProps): JSX.Element {
  const presence: PanelPresence = sidebarOpen ? "open" : "collapsed";

  return (
    <div className="app-shell-scene">
      <header className="app-spatial-topbar titlebar-drag-region">
        {topbar ? (
          <div className="flex shrink-0 items-center gap-2 titlebar-no-drag">
            {topbar}
          </div>
        ) : (
          <div className="w-16 shrink-0" aria-hidden />
        )}
        <UpdateBanner
          fallback={<StatusTicker onOpenSession={onOpenLiveSession} />}
        />
        <div className="ml-0 shrink-0 titlebar-no-drag">
          <WindowControls />
        </div>
      </header>

      <nav className="app-shell-nav">
        <NavIsland sidebarPresence={presence} activeRailItem={activeRailItem}>
          {rail}
          {sidebar}
        </NavIsland>
      </nav>

      <main className="app-shell-main">{children}</main>
    </div>
  );
}
