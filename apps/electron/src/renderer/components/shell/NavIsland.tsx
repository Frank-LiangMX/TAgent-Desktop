/**
 * NavIsland — 左侧导航组合层
 *
 * 开合动画：移植 layout-direction-study 的 rail→sidebar morph
 * （droplet / stream / tether / ghost + 交叠交接）
 *
 * 关键约束：
 * - morph effect 只依赖 requestedOpen（禁止把 ReactNode children 放进 deps，
 *   否则父组件重渲染会反复 cancel/重开 → 乱抽且永不落位）
 * - settledOpenRef 只在 morph 成功结束后更新（Strict Mode 安全）
 * - 交接对齐右栏：commitStyles → 真壳落位 → 代理淡出
 */

import * as React from 'react'

import { InertRegion } from './InertRegion'
import {
  createSidebarMorphKeyframes,
  createSidebarTetherKeyframes,
  getSidebarSurfaceBaseStyle,
  getSidebarTetherStyle,
  measureRailSourceElement,
  measureRailSourceRect,
  SIDEBAR_CLOSE_MS,
  SIDEBAR_CLOSE_OUTER_EASE,
  SIDEBAR_CONTENT_LEAVE_MS,
  SIDEBAR_OPEN_EASE,
  SIDEBAR_OPEN_MS,
  type SidebarMotionRect,
} from './left-sidebar-motion'
import {
  NAV_MAC_CHROME_HEIGHT,
  NAV_RAIL_WIDTH,
  NAV_SIDEBAR_WIDTH,
} from '@tagent/shared'
import { cn } from '../../lib/utils'

/** 与 General PanelPresence 同语义 */
export type PanelPresence = 'hidden' | 'collapsed' | 'open'

function detectIsMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (typeof platform === 'string' && platform.toLowerCase().includes('mac')) return true
  return /mac/i.test(navigator.platform || '')
}

export const NAV_SIDEBAR_DEFAULT_WIDTH = NAV_SIDEBAR_WIDTH
export const NAV_CLUSTER_GAP = 10
export const NAV_RAIL_EDGE_LEFT = 5

const RAIL_BTN_FALLBACK = 36
/** 收回：代理先盖住真壳再开 morph，避免「啪」一下换成空壳 */
const SIDEBAR_COVER_FADE_MS = 130
/** 展开：真壳落位后代理溶出（略长 + ease，压材质差） */
const SIDEBAR_HANDOFF_FADE_MS = 160
const SIDEBAR_HANDOFF_EASE = 'cubic-bezier(0.33, 0, 0.2, 1)'

type SidebarPhase = 'collapsed' | 'opening' | 'open' | 'closing'

export function getNavClusterWidth(
  showSidebar: boolean,
  railWidth = NAV_RAIL_WIDTH,
  sidebarWidth = NAV_SIDEBAR_DEFAULT_WIDTH,
  clusterGap = NAV_CLUSTER_GAP,
  railEdgeLeft = NAV_RAIL_EDGE_LEFT
): number {
  const core = showSidebar ? railWidth + clusterGap + sidebarWidth : railWidth
  return core + railEdgeLeft
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function waitForLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

export interface NavIslandProps {
  sidebarPresence: PanelPresence
  activeRailItem?: string | null
  sidebarWidth?: number
  railWidth?: number
  children: React.ReactNode
}

export function NavIsland({
  sidebarPresence,
  activeRailItem = null,
  sidebarWidth = NAV_SIDEBAR_DEFAULT_WIDTH,
  railWidth = NAV_RAIL_WIDTH,
  children,
}: NavIslandProps): React.ReactElement {
  const isMac = React.useMemo(() => detectIsMac(), [])
  const childList = React.Children.toArray(children)
  const rail = childList[0]
  const sidebar = childList[1]
  const hasSidebar = Boolean(sidebar)

  const requestedOpen = sidebarPresence === 'open'
  const [phase, setPhase] = React.useState<SidebarPhase>(requestedOpen ? 'open' : 'collapsed')
  const [isContentLeaving, setIsContentLeaving] = React.useState(false)
  const [isContentRevealing, setIsContentRevealing] = React.useState(false)

  /** 仅在 morph 完整结束后更新，禁止 effect 开头改（Strict Mode 会吞 open） */
  const settledOpenRef = React.useRef(requestedOpen)
  const phaseRef = React.useRef<SidebarPhase>(phase)
  phaseRef.current = phase
  const morphVersionRef = React.useRef(0)
  const morphAnimRef = React.useRef<Animation | null>(null)
  const tetherAnimRef = React.useRef<Animation | null>(null)
  const sidebarWidthRef = React.useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const hasSidebarRef = React.useRef(hasSidebar)
  hasSidebarRef.current = hasSidebar
  const activeRailItemRef = React.useRef(activeRailItem)
  activeRailItemRef.current = activeRailItem

  const stackRef = React.useRef<HTMLElement>(null)
  const sidebarRef = React.useRef<HTMLDivElement>(null)
  const morphLayerRef = React.useRef<HTMLDivElement>(null)
  const morphSurfaceRef = React.useRef<HTMLDivElement>(null)
  const morphTetherRef = React.useRef<HTMLDivElement>(null)

  /**
   * 占位只跟 phase：opening 才撑开、closing 即收窄。
   * 禁止用 requestedOpen（一点击 main 会秒切，morph 还没开始）。
   */
  const shellExpanded = phase === 'open' || phase === 'opening'
  const isMorphing = phase === 'opening' || phase === 'closing'
  // content-leaving 只淡内容，不整栏 hidden（否则收回开头真壳先空一拍再出代理）
  const suppressRealSidebar = isMorphing || (requestedOpen && phase === 'collapsed')
  /** 与 morph 同步：驱动 flex 让 main 跟着让位，避免秒切 */
  const layoutMotionMs =
    phase === 'opening' ? SIDEBAR_OPEN_MS : phase === 'closing' ? SIDEBAR_CLOSE_MS : 0
  const layoutMotionEase =
    phase === 'closing' ? 'cubic-bezier(0.34, 0, 0.14, 1)' : SIDEBAR_OPEN_EASE

  const clearRailMorphClasses = React.useCallback(() => {
    stackRef.current
      ?.querySelectorAll('.rail-island-btn.is-morph-emitting, .rail-island-btn.is-morph-absorbing')
      .forEach((btn) => {
        btn.classList.remove('is-morph-emitting', 'is-morph-absorbing')
      })
  }, [])

  const resetMorphSurface = React.useCallback(() => {
    morphAnimRef.current?.cancel()
    tetherAnimRef.current?.cancel()
    morphAnimRef.current = null
    tetherAnimRef.current = null
    const surface = morphSurfaceRef.current
    const tether = morphTetherRef.current
    if (surface) {
      surface.classList.remove('is-active', 'is-opening', 'is-closing')
      surface.removeAttribute('style')
      surface.replaceChildren()
    }
    if (tether) {
      tether.classList.remove('is-active')
      tether.removeAttribute('style')
    }
    clearRailMorphClasses()
  }, [clearRailMorphClasses])

  const resolveSource = React.useCallback((): {
    rect: SidebarMotionRect
    button: HTMLElement | null
  } => {
    const stack = stackRef.current
    const button = measureRailSourceElement(stack, activeRailItemRef.current)
    const measured = measureRailSourceRect(stack, activeRailItemRef.current)
    if (measured) return { rect: measured, button }

    const railEl = stack?.querySelector('.app-nav-rail')
    const railBox = railEl?.getBoundingClientRect()
    if (railBox) {
      return {
        rect: {
          left: railBox.left + (railBox.width - RAIL_BTN_FALLBACK) / 2,
          top: railBox.top + 72,
          width: RAIL_BTN_FALLBACK,
          height: RAIL_BTN_FALLBACK,
        },
        button,
      }
    }
    return {
      rect: { left: 12, top: 100, width: RAIL_BTN_FALLBACK, height: RAIL_BTN_FALLBACK },
      button,
    }
  }, [])

  /**
   * 目标几何：优先用 stack + 已知 sidebarWidth 推算（不依赖 morph 中
   * visibility:hidden / contain:strict 的测量噪声）。
   */
  const resolvePanelViewport = React.useCallback((): SidebarMotionRect => {
    const width = sidebarWidthRef.current
    const stack = stackRef.current
    const sidebarEl = sidebarRef.current
    const stackBox = stack?.getBoundingClientRect()
    const railEl = stack?.querySelector('.app-nav-rail')
    const railBox = railEl?.getBoundingClientRect()

    if (sidebarEl) {
      const box = sidebarEl.getBoundingClientRect()
      if (box.width > 40 && box.height > 40) {
        return {
          left: box.left,
          top: box.top,
          width: Math.max(box.width, width),
          height: box.height,
        }
      }
    }

    const left =
      railBox != null
        ? railBox.right + NAV_CLUSTER_GAP
        : stackBox != null
          ? stackBox.left + railWidth + NAV_CLUSTER_GAP
          : 60
    const top = stackBox?.top ?? railBox?.top ?? 64
    const height = Math.max(stackBox?.height ?? 0, railBox?.height ?? 0, 480)

    return { left, top, width, height }
  }, [railWidth])

  React.useLayoutEffect(() => {
    const openingEdge = requestedOpen && !settledOpenRef.current
    const closingEdge = !requestedOpen && settledOpenRef.current
    const currentPhase = phaseRef.current

    if (!openingEdge && !closingEdge) {
      const active = morphAnimRef.current
      const surface = morphSurfaceRef.current
      const canReverse =
        !!active && !!surface?.classList.contains('is-active') && active.playState === 'running'

      if (canReverse && currentPhase === 'opening' && !requestedOpen) {
        const version = ++morphVersionRef.current
        let cancelled = false
        surface!.classList.remove('is-opening')
        surface!.classList.add('is-closing')
        setPhase('closing')
        active!.reverse()
        tetherAnimRef.current?.reverse()
        void (async () => {
          await active!.finished.catch(() => undefined)
          if (cancelled || version !== morphVersionRef.current) return
          settledOpenRef.current = false
          setPhase('collapsed')
          setIsContentLeaving(false)
          setIsContentRevealing(false)
          resetMorphSurface()
        })()
        return () => {
          cancelled = true
        }
      }

      if (canReverse && currentPhase === 'closing' && requestedOpen) {
        const version = ++morphVersionRef.current
        let cancelled = false
        surface!.classList.remove('is-closing')
        surface!.classList.add('is-opening')
        setPhase('opening')
        active!.reverse()
        tetherAnimRef.current?.reverse()
        void (async () => {
          await active!.finished.catch(() => undefined)
          if (cancelled || version !== morphVersionRef.current) return
          settledOpenRef.current = true
          setPhase('open')
          setIsContentLeaving(false)
          setIsContentRevealing(false)
          resetMorphSurface()
        })()
        return () => {
          cancelled = true
        }
      }

      if (requestedOpen && currentPhase === 'open') {
        setIsContentLeaving(false)
        return
      }
      if (!requestedOpen && currentPhase === 'collapsed') {
        setIsContentLeaving(false)
        setIsContentRevealing(false)
        return
      }

      // 无动画可 reverse 的卡死态：直接对齐
      if (requestedOpen && (currentPhase === 'collapsed' || currentPhase === 'closing')) {
        setPhase('open')
        settledOpenRef.current = true
        setIsContentLeaving(false)
        resetMorphSurface()
      } else if (!requestedOpen && (currentPhase === 'open' || currentPhase === 'opening')) {
        setPhase('collapsed')
        settledOpenRef.current = false
        setIsContentLeaving(false)
        setIsContentRevealing(false)
        resetMorphSurface()
      }
      return
    }

    const version = ++morphVersionRef.current
    let cancelled = false

    const run = async () => {
      if (prefersReducedMotion() || !hasSidebarRef.current) {
        setPhase(requestedOpen ? 'open' : 'collapsed')
        settledOpenRef.current = requestedOpen
        setIsContentLeaving(false)
        setIsContentRevealing(false)
        resetMorphSurface()
        return
      }

      const layer = morphLayerRef.current
      const surface = morphSurfaceRef.current
      const tether = morphTetherRef.current
      if (!layer || !surface || !tether) {
        setPhase(requestedOpen ? 'open' : 'collapsed')
        settledOpenRef.current = requestedOpen
        resetMorphSurface()
        return
      }

      const prepareProxyShell = (
        panelViewport: SidebarMotionRect,
        overlay: SidebarMotionRect,
        sourceViewport: SidebarMotionRect,
        direction: 'opening' | 'closing'
      ) => {
        Object.assign(surface.style, getSidebarSurfaceBaseStyle(panelViewport, overlay))
        Object.assign(tether.style, getSidebarTetherStyle(sourceViewport, panelViewport, overlay))
        // 交接帧不挂 ghost 文案：空壳更接近真面板材质，避免「替代面板」感
        surface.replaceChildren()
        surface.classList.add('is-active', direction === 'opening' ? 'is-opening' : 'is-closing')
        surface.classList.remove(direction === 'opening' ? 'is-closing' : 'is-opening')
      }

      const handoffToReal = async (mode: 'open' | 'collapsed') => {
        const finishedAnim = morphAnimRef.current
        const finishedTether = tetherAnimRef.current
        if (finishedAnim) {
          try {
            finishedAnim.commitStyles()
          } catch {
            // ignore
          }
          finishedAnim.cancel()
          morphAnimRef.current = null
        }
        if (finishedTether) {
          try {
            finishedTether.commitStyles()
          } catch {
            // ignore
          }
          finishedTether.cancel()
          tetherAnimRef.current = null
        }

        // 代理固定在终态，盖住真壳首帧；内容直接上，不做 0→1 reveal（否则溶掉后再闪一次）
        surface.style.opacity = '1'
        surface.style.transition = 'none'
        surface.classList.add('is-active')
        surface.replaceChildren()
        tether.classList.remove('is-active')
        tether.removeAttribute('style')
        clearRailMorphClasses()

        if (mode === 'open') {
          settledOpenRef.current = true
          setPhase('open')
          setIsContentRevealing(false)
        } else {
          settledOpenRef.current = false
          setPhase('collapsed')
          setIsContentRevealing(false)
        }
        setIsContentLeaving(false)

        await waitForLayout()
        if (cancelled || version !== morphVersionRef.current) return

        surface.style.transition = `opacity ${SIDEBAR_HANDOFF_FADE_MS}ms ${SIDEBAR_HANDOFF_EASE}`
        void surface.offsetWidth
        surface.style.opacity = '0'
        await waitMs(SIDEBAR_HANDOFF_FADE_MS)
        if (cancelled || version !== morphVersionRef.current) return

        surface.classList.remove('is-active', 'is-opening', 'is-closing')
        surface.removeAttribute('style')
        surface.replaceChildren()
      }

      if (closingEdge) {
        // 内容先轻收，同时量几何（真壳仍在）
        setIsContentLeaving(true)
        await waitMs(SIDEBAR_CONTENT_LEAVE_MS)
        if (cancelled || version !== morphVersionRef.current) return

        const overlayBox = layer.getBoundingClientRect()
        const overlay: SidebarMotionRect = {
          left: overlayBox.left,
          top: overlayBox.top,
          width: overlayBox.width,
          height: overlayBox.height,
        }
        const panelViewport = resolvePanelViewport()
        const { rect: sourceViewport, button } = resolveSource()

        resetMorphSurface()
        button?.classList.add('is-morph-absorbing')
        prepareProxyShell(panelViewport, overlay, sourceViewport, 'closing')
        // 盖住真壳：先淡入代理，再切 morphing（真壳瞬间消失时已被盖住）
        surface.style.opacity = '0'
        surface.style.transition = `opacity ${SIDEBAR_COVER_FADE_MS}ms ${SIDEBAR_HANDOFF_EASE}`
        tether.classList.remove('is-active')
        void surface.offsetWidth
        surface.style.opacity = '1'
        await waitMs(SIDEBAR_COVER_FADE_MS)
        if (cancelled || version !== morphVersionRef.current) return

        surface.style.transition = 'none'
        tether.classList.add('is-active')
        setPhase('closing')
        setIsContentLeaving(false)
        await waitForLayout()
        if (cancelled || version !== morphVersionRef.current) return

        const anim = surface.animate(
          createSidebarMorphKeyframes(sourceViewport, panelViewport, overlay, 'closing'),
          {
            duration: SIDEBAR_CLOSE_MS,
            easing: SIDEBAR_CLOSE_OUTER_EASE,
            fill: 'forwards',
          }
        )
        const tAnim = tether.animate(createSidebarTetherKeyframes('closing'), {
          duration: SIDEBAR_CLOSE_MS,
          easing: 'cubic-bezier(0.34, 0, 0.14, 1)',
          fill: 'forwards',
        })
        morphAnimRef.current = anim
        tetherAnimRef.current = tAnim
        await anim.finished.catch(() => undefined)
        if (cancelled || version !== morphVersionRef.current) return
        await handoffToReal('collapsed')
        window.setTimeout(() => button?.classList.remove('is-morph-absorbing'), 40)
        return
      }

      // —— opening ——
      setPhase('opening')
      setIsContentRevealing(false)
      await waitForLayout()
      if (cancelled || version !== morphVersionRef.current) return

      const overlayBox = layer.getBoundingClientRect()
      const overlay: SidebarMotionRect = {
        left: overlayBox.left,
        top: overlayBox.top,
        width: overlayBox.width,
        height: overlayBox.height,
      }
      const panelViewport = resolvePanelViewport()
      const { rect: sourceViewport, button } = resolveSource()

      resetMorphSurface()
      button?.classList.add('is-morph-emitting')
      prepareProxyShell(panelViewport, overlay, sourceViewport, 'opening')
      tether.classList.add('is-active')

      const anim = surface.animate(
        createSidebarMorphKeyframes(sourceViewport, panelViewport, overlay, 'opening'),
        {
          duration: SIDEBAR_OPEN_MS,
          easing: SIDEBAR_OPEN_EASE,
          fill: 'forwards',
        }
      )
      const tAnim = tether.animate(createSidebarTetherKeyframes('opening'), {
        duration: SIDEBAR_OPEN_MS,
        easing: SIDEBAR_OPEN_EASE,
        fill: 'forwards',
      })
      morphAnimRef.current = anim
      tetherAnimRef.current = tAnim
      await anim.finished.catch(() => undefined)
      if (cancelled || version !== morphVersionRef.current) return
      button?.classList.remove('is-morph-emitting')
      await handoffToReal('open')
    }

    void run()
    return () => {
      cancelled = true
    }
    // 只跟 requestedOpen：children / callback 身份变化不得重开 morph
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见文件头
  }, [requestedOpen])

  React.useEffect(() => {
    return () => {
      morphVersionRef.current += 1
      resetMorphSurface()
    }
  }, [resetMorphSurface])

  return (
    <>
      <aside
        ref={stackRef}
        className={cn(
          'app-nav-stack',
          shellExpanded && hasSidebar && 'app-nav-stack--expanded',
          suppressRealSidebar && 'app-nav-stack--sidebar-morphing',
          isContentLeaving && 'app-nav-stack--sidebar-content-leaving',
          isContentRevealing && 'app-nav-stack--sidebar-revealing',
          phase === 'closing' && 'app-nav-stack--sidebar-closing'
        )}
        aria-label="主导航"
        data-sidebar-presence={sidebarPresence}
        data-sidebar-phase={phase}
        style={{
          ['--app-nav-rail-width' as string]: `${railWidth}px`,
          ['--app-nav-sidebar-width' as string]: `${sidebarWidth}px`,
          ['--app-nav-cluster-gap' as string]: `${NAV_CLUSTER_GAP}px`,
          ['--left-sidebar-layout-ms' as string]: `${layoutMotionMs}ms`,
          ['--left-sidebar-layout-ease' as string]: layoutMotionEase,
        }}
      >
        <div
          className={cn('app-nav-rail', isMac && 'app-nav-rail--mac')}
          style={
            {
              width: railWidth,
              ['--nav-mac-chrome-height' as string]: `${NAV_MAC_CHROME_HEIGHT}px`,
            } as React.CSSProperties
          }
        >
          {isMac ? (
            <div
              className="app-nav-mac-chrome titlebar-drag-region"
              style={{ height: NAV_MAC_CHROME_HEIGHT }}
              aria-hidden
            />
          ) : null}
          <div className="app-nav-rail-content">{rail}</div>
        </div>

        {sidebar ? (
          <InertRegion
            ref={sidebarRef}
            id="app-navigation-sidebar"
            className="app-nav-sidebar"
            data-surface-role="panel-elevated"
            style={{ width: shellExpanded ? sidebarWidth : 0 }}
            inactive={!requestedOpen || suppressRealSidebar}
          >
            <div className="app-nav-sidebar-content">{sidebar}</div>
          </InertRegion>
        ) : null}
      </aside>

      <div ref={morphLayerRef} className="left-sidebar-morph-layer" aria-hidden>
        <div ref={morphTetherRef} className="left-sidebar-morph-tether" />
        <div ref={morphSurfaceRef} className="left-sidebar-morph-surface" />
      </div>
    </>
  )
}
