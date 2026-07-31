/**
 * AppShell — 全局浮岛布局壳
 *
 * sidebar 开合交给 NavIsland（General 同款 morph）。
 */
import type { ReactNode } from 'react'
import { WindowControls } from './WindowControls'
import { NavIsland, type PanelPresence } from './NavIsland'

interface AppShellProps {
  topbar?: ReactNode
  rail?: ReactNode
  sidebar?: ReactNode
  /** 目标展开态 */
  sidebarOpen?: boolean
  /** morph 源按钮 data-rail-id，默认 chat */
  activeRailItem?: string | null
  children?: ReactNode
}

export function AppShell({
  topbar,
  rail,
  sidebar,
  sidebarOpen = true,
  activeRailItem = 'chat',
  children,
}: AppShellProps): JSX.Element {
  const presence: PanelPresence = sidebarOpen ? 'open' : 'collapsed'

  return (
    <div className="app-shell-scene">
      <header className="app-spatial-topbar titlebar-drag-region">
        {topbar && <div className="flex items-center gap-2 titlebar-no-drag">{topbar}</div>}
        <div className="ml-auto titlebar-no-drag">
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
  )
}
