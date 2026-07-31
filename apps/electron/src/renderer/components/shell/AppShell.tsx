/**
 * AppShell — 全局浮岛布局壳（对齐 TAgent_General 视觉，flex 行 + 玻璃浮岛）
 *
 * 结构：.app-shell-scene（flex 行）→ SpatialTopBar（absolute 浮顶）+ nav(rail+sidebar) + main
 * sidebar 展开/收起：width + gap 过渡（对齐 General left-sidebar layout ms/ease，无 morph 代理层）。
 */
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { WindowControls } from './WindowControls'

interface AppShellProps {
  /** 顶栏内容（渠道管理/工作区/主题等），放在浮顶右侧 */
  topbar?: ReactNode
  /** 左导航轨（Rail 组件） */
  rail?: ReactNode
  /** 侧栏（SessionSidebar）；插件/记忆等页不传或配合 sidebarOpen=false */
  sidebar?: ReactNode
  /**
   * 会话侧栏是否展开。
   * - true：width=254 + gap
   * - false：width=0 + gap=0（仍可挂载 DOM，便于过渡）
   */
  sidebarOpen?: boolean
  /** 主区内容（会话页/空状态） */
  children?: ReactNode
}

export function AppShell({
  topbar,
  rail,
  sidebar,
  sidebarOpen = true,
  children,
}: AppShellProps): JSX.Element {
  const hasSidebarSlot = sidebar != null

  return (
    <div className="app-shell-scene">
      {/* 顶栏：单独一行浮顶（窗口栏），含窗口控制 + 可选额外内容。对齐 TAgent_General SpatialTopBar */}
      <header className="app-spatial-topbar titlebar-drag-region">
        {topbar && <div className="flex items-center gap-2 titlebar-no-drag">{topbar}</div>}
        {/* 窗口控制放顶栏右侧（对齐旧版 WindowControls 在 SpatialTopBar） */}
        <div className="ml-auto titlebar-no-drag">
          <WindowControls />
        </div>
      </header>

      {/* nav：rail + sidebar 玻璃浮岛，顶栏下 16px 间隙（band-inset-top） */}
      <nav className="app-shell-nav">
        <div
          className={cn(
            'app-nav-stack',
            hasSidebarSlot && sidebarOpen && 'app-nav-stack--sidebar-open',
            hasSidebarSlot && !sidebarOpen && 'app-nav-stack--sidebar-closed',
          )}
          data-sidebar-open={hasSidebarSlot && sidebarOpen ? 'true' : 'false'}
        >
          {rail}
          {hasSidebarSlot ? (
            <div
              className={cn(
                'app-nav-sidebar-slot',
                sidebarOpen ? 'app-nav-sidebar-slot--open' : 'app-nav-sidebar-slot--closed',
              )}
              data-open={sidebarOpen ? 'true' : 'false'}
              aria-hidden={!sidebarOpen}
            >
              <div className="app-nav-sidebar-slot-inner">{sidebar}</div>
            </div>
          ) : null}
        </div>
      </nav>

      {/* main：透 scene，会话页/composer 在内 */}
      <main className="app-shell-main">{children}</main>
    </div>
  )
}
