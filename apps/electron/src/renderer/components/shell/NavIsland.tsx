/**
 * NavIsland — 左侧导航组合层（对齐 TAgent_General NavIsland）
 *
 * 开合：rail 按钮 → sidebar morph（droplet / stream / tether）+ width 让位同步。
 * effect 只依赖 requestedOpen，避免 children 重渲染打断动画。
 */
import * as React from 'react'
import { cn } from '../../lib/utils'
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

export const NAV_SIDEBAR_DEFAULT_WIDTH = 254
export const NAV_CLUSTER_GAP = 10
export const NAV_RAIL_WIDTH = 58

const RAIL_BTN_FALLBACK = 36
const SIDEBAR_COVER_FADE_MS = 130
const SIDEBAR_HANDOFF_FADE_MS = 160
const SIDEBAR_HANDOFF_EASE = 'cubic-bezier(0.33, 0, 0.2, 1)'

type SidebarPhase = 'collapsed' | 'opening' | 'open' | 'closing'
export type PanelPresence = 'hidden' | 'collapsed' | 'open'

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
  /** open | collapsed（Desktop 无 hidden 场景时等同 collapsed） */
  sidebarPresence: PanelPresence
  /** 用于量 rail 源按钮，如 'chat' */
  activeRailItem?: string | null
  sidebarWidth?: number
  railWidth?: number
  /** [0]=rail, [1]=sidebar 内容（不含 app-nav-sidebar 外壳） */
  children: React.ReactNode
}

export function NavIsland({
  sidebarPresence,
  activeRailItem = null,
  sidebarWidth = NAV_SIDEBAR_DEFAULT_WIDTH,
  railWidth = NAV_RAIL_WIDTH,
  children,
}: NavIslandProps): React.ReactElement {
  const childList = React.Children.toArray(children)
  const rail = childList[0]
  const sidebar = childList[1]
  const hasSidebar = Boolean(sidebar)

  const requestedOpen = sidebarPresence === 'open'
  const [phase, setPhase] = React.useState<SidebarPhase>(requestedOpen ? 'open' : 'collapsed')
  const [isContentLeaving, setIsContentLeaving] = React.useState(false)

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

  const shellExpanded = phase === 'open' || phase === 'opening'
  const isMorphing = phase === 'opening' || phase === 'closing'
  const suppressRealSidebar = isMorphing || (requestedOpen && phase === 'collapsed')
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
        return
      }

      if (requestedOpen && (currentPhase === 'collapsed' || currentPhase === 'closing')) {
        setPhase('open')
        settledOpenRef.current = true
        setIsContentLeaving(false)
        resetMorphSurface()
      } else if (!requestedOpen && (currentPhase === 'open' || currentPhase === 'opening')) {
        setPhase('collapsed')
        settledOpenRef.current = false
        setIsContentLeaving(false)
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
        direction: 'opening' | 'closing',
      ) => {
        Object.assign(surface.style, getSidebarSurfaceBaseStyle(panelViewport, overlay))
        Object.assign(tether.style, getSidebarTetherStyle(sourceViewport, panelViewport, overlay))
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
            /* ignore */
          }
          finishedAnim.cancel()
          morphAnimRef.current = null
        }
        if (finishedTether) {
          try {
            finishedTether.commitStyles()
          } catch {
            /* ignore */
          }
          finishedTether.cancel()
          tetherAnimRef.current = null
        }

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
        } else {
          settledOpenRef.current = false
          setPhase('collapsed')
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
          },
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

      // opening
      setPhase('opening')
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
        },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟 requestedOpen，同 General
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
          phase === 'closing' && 'app-nav-stack--sidebar-closing',
        )}
        aria-label="主导航"
        data-sidebar-presence={sidebarPresence}
        data-sidebar-phase={phase}
        style={
          {
            ['--app-nav-rail-width' as string]: `${railWidth}px`,
            ['--app-nav-sidebar-width' as string]: `${sidebarWidth}px`,
            ['--app-nav-cluster-gap' as string]: `${NAV_CLUSTER_GAP}px`,
            ['--left-sidebar-layout-ms' as string]: `${layoutMotionMs}ms`,
            ['--left-sidebar-layout-ease' as string]: layoutMotionEase,
          } as React.CSSProperties
        }
      >
        {rail}

        {sidebar ? (
          <div
            ref={sidebarRef}
            id="app-navigation-sidebar"
            className="app-nav-sidebar"
            style={{ width: shellExpanded ? sidebarWidth : 0 }}
            aria-hidden={!requestedOpen || suppressRealSidebar}
          >
            <div className="app-nav-sidebar-content">{sidebar}</div>
          </div>
        ) : null}
      </aside>

      <div ref={morphLayerRef} className="left-sidebar-morph-layer" aria-hidden>
        <div ref={morphTetherRef} className="left-sidebar-morph-tether" />
        <div ref={morphSurfaceRef} className="left-sidebar-morph-surface" />
      </div>
    </>
  )
}
