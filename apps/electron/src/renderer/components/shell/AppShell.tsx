/**
 * AppShell — 全局浮岛布局壳（对齐 TAgent_General 视觉，flex 行 + 玻璃浮岛）
 *
 * sidebar 展开/收起：分 phase 驱动（opening / open / closing / closed）
 * - 收起：内容先淡出 → 宽度收拢（对齐 General CONTENT_LEAVE + CLOSE_MS）
 * - 展开：宽度先撑开 → 内容再淡入（对齐 OPEN_MS + CONTENT_REVEAL）
 * 缓动与 General left-sidebar-motion 一致，不做 morph 代理层。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { WindowControls } from './WindowControls'

/** 对齐 General left-sidebar-motion.ts */
const SIDEBAR_OPEN_MS = 500
const SIDEBAR_CLOSE_MS = 460
const SIDEBAR_CONTENT_LEAVE_MS = 120
const SIDEBAR_CONTENT_REVEAL_MS = 190
const SIDEBAR_OPEN_EASE = 'cubic-bezier(0.18, 0.72, 0.14, 1)'
/** 收起：先快后慢，比 linear 更顺 */
const SIDEBAR_CLOSE_EASE = 'cubic-bezier(0.34, 0, 0.14, 1)'

type SidebarPhase = 'open' | 'closed' | 'opening' | 'closing'

interface AppShellProps {
  topbar?: ReactNode
  rail?: ReactNode
  sidebar?: ReactNode
  /** 目标展开态（true=要展开，false=要收起） */
  sidebarOpen?: boolean
  children?: ReactNode
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function AppShell({
  topbar,
  rail,
  sidebar,
  sidebarOpen = true,
  children,
}: AppShellProps): JSX.Element {
  const hasSidebarSlot = sidebar != null
  const [phase, setPhase] = useState<SidebarPhase>(sidebarOpen ? 'open' : 'closed')
  const [contentVisible, setContentVisible] = useState(sidebarOpen)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const genRef = useRef(0)

  // 响应 sidebarOpen 目标，跑分阶段动画
  useEffect(() => {
    if (!hasSidebarSlot) {
      setPhase('closed')
      setContentVisible(false)
      return
    }

    const reduced = prefersReducedMotion()
    const gen = ++genRef.current
    const wantOpen = sidebarOpen
    const current = phaseRef.current

    // 已到位
    if (wantOpen && (current === 'open' || current === 'opening')) return
    if (!wantOpen && (current === 'closed' || current === 'closing')) return

    if (reduced) {
      setPhase(wantOpen ? 'open' : 'closed')
      setContentVisible(wantOpen)
      return
    }

    let t1 = 0
    let t2 = 0

    if (wantOpen) {
      // closed → opening（宽）→ open + 内容淡入
      setContentVisible(false)
      setPhase('opening')
      t1 = window.setTimeout(() => {
        if (gen !== genRef.current) return
        setContentVisible(true)
        t2 = window.setTimeout(() => {
          if (gen !== genRef.current) return
          setPhase('open')
        }, SIDEBAR_CONTENT_REVEAL_MS)
      }, SIDEBAR_OPEN_MS)
    } else {
      // open → 内容先淡出 → closing（收宽）→ closed
      setContentVisible(false)
      t1 = window.setTimeout(() => {
        if (gen !== genRef.current) return
        setPhase('closing')
        t2 = window.setTimeout(() => {
          if (gen !== genRef.current) return
          setPhase('closed')
        }, SIDEBAR_CLOSE_MS)
      }, SIDEBAR_CONTENT_LEAVE_MS)
    }

    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [sidebarOpen, hasSidebarSlot])

  const shellExpanded = phase === 'open' || phase === 'opening'
  const layoutMs = phase === 'opening' ? SIDEBAR_OPEN_MS : phase === 'closing' ? SIDEBAR_CLOSE_MS : 0
  const layoutEase = phase === 'closing' ? SIDEBAR_CLOSE_EASE : SIDEBAR_OPEN_EASE

  return (
    <div className="app-shell-scene">
      <header className="app-spatial-topbar titlebar-drag-region">
        {topbar && <div className="flex items-center gap-2 titlebar-no-drag">{topbar}</div>}
        <div className="ml-auto titlebar-no-drag">
          <WindowControls />
        </div>
      </header>

      <nav className="app-shell-nav">
        <div
          className={cn(
            'app-nav-stack',
            shellExpanded && 'app-nav-stack--sidebar-open',
            !shellExpanded && 'app-nav-stack--sidebar-closed',
          )}
          data-sidebar-open={shellExpanded ? 'true' : 'false'}
          data-sidebar-phase={phase}
          style={
            {
              ['--left-sidebar-layout-ms' as string]: `${layoutMs}ms`,
              ['--left-sidebar-layout-ease' as string]: layoutEase,
            } as React.CSSProperties
          }
        >
          {rail}
          {hasSidebarSlot ? (
            <div
              className={cn(
                'app-nav-sidebar-slot',
                shellExpanded ? 'app-nav-sidebar-slot--open' : 'app-nav-sidebar-slot--closed',
                phase === 'opening' && 'app-nav-sidebar-slot--opening',
                phase === 'closing' && 'app-nav-sidebar-slot--closing',
              )}
              data-open={shellExpanded ? 'true' : 'false'}
              data-phase={phase}
              aria-hidden={!shellExpanded}
            >
              <div
                className={cn(
                  'app-nav-sidebar-slot-inner',
                  contentVisible
                    ? 'app-nav-sidebar-slot-inner--content-visible'
                    : 'app-nav-sidebar-slot-inner--content-hidden',
                )}
              >
                {sidebar}
              </div>
            </div>
          ) : null}
        </div>
      </nav>

      <main className="app-shell-main">{children}</main>
    </div>
  )
}
