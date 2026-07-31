/**
 * 左栏 rail 按钮 ↔ sidebar morph
 * 几何与缓动对齐 prototypes/layout-direction-study（droplet / stream / tether）
 */

export interface SidebarMotionRect {
  left: number
  top: number
  width: number
  height: number
}

export type SidebarMotionDirection = 'opening' | 'closing'

export const SIDEBAR_OPEN_MS = 500
export const SIDEBAR_CLOSE_MS = 460
/** 收回：内容淡出时长（需 ≥ CSS content-leaving transition） */
export const SIDEBAR_CONTENT_LEAVE_MS = 120
export const SIDEBAR_CONTENT_REVEAL_MS = 190

/** 原型开场外层 easing */
export const SIDEBAR_OPEN_EASE = 'cubic-bezier(0.18, 0.72, 0.14, 1)'
/** 关闭外层 linear，关键帧内分段 ease */
export const SIDEBAR_CLOSE_OUTER_EASE = 'linear'

function clampSize(value: number): number {
  return Math.max(1, value)
}

function formatPx(value: number): string {
  return `${Number(value.toFixed(2))}px`
}

export function localSidebarRect(
  rect: DOMRect | SidebarMotionRect,
  overlay: DOMRect | SidebarMotionRect
): SidebarMotionRect {
  return {
    left: rect.left - overlay.left,
    top: rect.top - overlay.top,
    width: rect.width,
    height: rect.height,
  }
}

/** 原型 sidebarMorphPath：source → droplet → stream → gathered → target */
export function buildSidebarMorphPath(
  sourceViewport: SidebarMotionRect,
  targetViewport: SidebarMotionRect,
  overlay: SidebarMotionRect
): {
  source: SidebarMotionRect
  target: SidebarMotionRect
  gathered: SidebarMotionRect
  stream: SidebarMotionRect
  droplet: SidebarMotionRect
} {
  const source = localSidebarRect(sourceViewport, overlay)
  const target = localSidebarRect(targetViewport, overlay)
  const sourceRight = source.left + source.width
  const sourceCenterY = source.top + source.height / 2
  const streamRight = target.left + Math.max(116, target.width * 0.38)

  return {
    source,
    target,
    gathered: {
      left: target.left - 10,
      top: target.top + (sourceCenterY - target.top) * 0.14,
      width: target.width * 0.76,
      height: target.height * 0.8,
    },
    stream: {
      left: sourceRight + 5,
      top: sourceCenterY - 68,
      width: Math.max(112, streamRight - sourceRight),
      height: 136,
    },
    droplet: {
      left: sourceRight + 4,
      top: sourceCenterY - 44,
      width: Math.max(70, target.width * 0.24),
      height: 88,
    },
  }
}

function morphGeometry(
  rect: SidebarMotionRect,
  opacity: number,
  borderRadius: string,
  easing?: string
): Keyframe {
  const frame: Keyframe = {
    left: formatPx(rect.left),
    top: formatPx(rect.top),
    width: formatPx(clampSize(rect.width)),
    height: formatPx(clampSize(rect.height)),
    opacity,
    borderRadius,
  }
  if (easing) frame.easing = easing
  return frame
}

/**
 * 原型开合关键帧：直接插值 left/top/width/height（非 scale 盒子）
 */
export function createSidebarMorphKeyframes(
  sourceViewport: SidebarMotionRect,
  targetViewport: SidebarMotionRect,
  overlay: SidebarMotionRect,
  direction: SidebarMotionDirection
): Keyframe[] {
  const path = buildSidebarMorphPath(sourceViewport, targetViewport, overlay)

  if (direction === 'opening') {
    return [
      {
        ...morphGeometry(path.source, 0, '18px'),
        offset: 0,
        easing: 'cubic-bezier(0.16, 0.72, 0.18, 1)',
      },
      { ...morphGeometry(path.droplet, 0.9, '18px 34px 34px 18px'), offset: 0.22 },
      { ...morphGeometry(path.stream, 0.94, '20px 38px 38px 20px'), offset: 0.46 },
      { ...morphGeometry(path.gathered, 0.98, '26px'), offset: 0.74 },
      { ...morphGeometry(path.target, 1, '22px'), offset: 1 },
    ]
  }

  return [
    {
      ...morphGeometry(path.target, 1, '22px'),
      offset: 0,
      easing: 'cubic-bezier(0.34, 0, 0.56, 0.42)',
    },
    {
      ...morphGeometry(path.gathered, 0.97, '26px'),
      offset: 0.3,
      easing: 'cubic-bezier(0.18, 0.72, 0.14, 1)',
    },
    { ...morphGeometry(path.stream, 0.94, '20px 38px 38px 20px'), offset: 0.6 },
    { ...morphGeometry(path.droplet, 0.86, '18px 34px 34px 18px'), offset: 0.82 },
    { ...morphGeometry(path.source, 0, '18px'), offset: 1 },
  ]
}

export function createSidebarTetherKeyframes(direction: SidebarMotionDirection): Keyframe[] {
  if (direction === 'opening') {
    return [
      { opacity: 0, transform: 'scaleX(0.04)', offset: 0 },
      { opacity: 0.66, transform: 'scaleX(0.58)', offset: 0.22 },
      { opacity: 0.46, transform: 'scaleX(1)', offset: 0.68 },
      { opacity: 0, transform: 'scaleX(1)', offset: 1 },
    ]
  }
  return [
    { opacity: 0, transform: 'scaleX(1)', offset: 0 },
    { opacity: 0.62, transform: 'scaleX(1)', offset: 0.18 },
    { opacity: 0.48, transform: 'scaleX(0.54)', offset: 0.7 },
    { opacity: 0, transform: 'scaleX(0.03)', offset: 1 },
  ]
}

/** 代理 surface 固定到 target（满侧栏）盒；动画过程改 left/top/width/height */
export function getSidebarSurfaceBaseStyle(
  targetViewport: SidebarMotionRect,
  overlay: SidebarMotionRect
): Partial<CSSStyleDeclaration> {
  // 初始会立刻被 WAAPI 第一帧覆盖；给一个 target 占位即可
  const target = localSidebarRect(targetViewport, overlay)
  return {
    left: formatPx(target.left),
    top: formatPx(target.top),
    width: formatPx(clampSize(target.width)),
    height: formatPx(clampSize(target.height)),
  }
}

export function getSidebarTetherStyle(
  sourceViewport: SidebarMotionRect,
  targetViewport: SidebarMotionRect,
  overlay: SidebarMotionRect
): Partial<CSSStyleDeclaration> {
  const source = localSidebarRect(sourceViewport, overlay)
  const target = localSidebarRect(targetViewport, overlay)
  const sourceCenterX = source.left + source.width / 2
  const sourceCenterY = source.top + source.height / 2
  return {
    left: formatPx(sourceCenterX),
    top: formatPx(sourceCenterY - 9),
    width: formatPx(Math.max(18, target.left - sourceCenterX + 18)),
  }
}

export function measureRailSourceRect(
  railRoot: ParentNode | null,
  railItemId?: string | null
): SidebarMotionRect | null {
  const scope = railRoot ?? (typeof document !== 'undefined' ? document : null)
  if (!scope) return null

  let el: Element | null = null
  if (railItemId) {
    el = scope.querySelector(`[data-rail-id="${railItemId}"]`)
  }
  if (!el) {
    el =
      scope.querySelector('.app-nav-rail .rail-island-btn--active[data-rail-id]') ??
      scope.querySelector('.app-nav-rail [data-rail-id]')
  }
  if (!el) return null

  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

export function measureRailSourceElement(
  railRoot: ParentNode | null,
  railItemId?: string | null
): HTMLElement | null {
  const scope = railRoot ?? (typeof document !== 'undefined' ? document : null)
  if (!scope) return null
  if (railItemId) {
    const el = scope.querySelector(`[data-rail-id="${railItemId}"]`)
    if (el instanceof HTMLElement) return el
  }
  const active = scope.querySelector('.app-nav-rail .rail-island-btn--active[data-rail-id]')
  if (active instanceof HTMLElement) return active
  const any = scope.querySelector('.app-nav-rail [data-rail-id]')
  return any instanceof HTMLElement ? any : null
}
