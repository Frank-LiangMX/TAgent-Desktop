/**
 * AppShell — 全局浮岛布局壳（对齐 TAgent_General 视觉，flex 行 + 玻璃浮岛）
 *
 * 结构：.app-shell-scene（flex 行）→ SpatialTopBar（absolute 浮顶）+ nav(rail+sidebar) + main
 * 不复刻旧版 1234 行 AppShell（无右 inspector/morph/折叠动画/mac-win 差异）。
 * 顶栏内容（渠道/主题等）、rail、sidebar、main 由 App 通过 props 传入。
 */
import type { ReactNode } from 'react'
import { WindowControls } from './WindowControls'

interface AppShellProps {
  /** 顶栏内容（渠道管理/工作区/主题等），放在浮顶右侧 */
  topbar?: ReactNode
  /** 左导航轨（Rail 组件） */
  rail?: ReactNode
  /** 侧栏（SessionSidebar） */
  sidebar?: ReactNode
  /** 主区内容（会话页/空状态） */
  children?: ReactNode
}

export function AppShell({ topbar, rail, sidebar, children }: AppShellProps): JSX.Element {
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
        <div className="app-nav-stack">
          {rail}
          {sidebar}
        </div>
      </nav>

      {/* main：透 scene，会话页/composer 在内 */}
      <main className="app-shell-main">{children}</main>
    </div>
  )
}
