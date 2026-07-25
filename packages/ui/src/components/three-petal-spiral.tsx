/**
 * ThreePetalSpiral — 三瓣螺旋加载动画
 *
 * 基于内旋轮线（Hypotrochoid）数学曲线：
 *   u(t) = ((R-r) cos t + d cos((R-r)t/r), (R-r) sin t - d sin((R-r)t/r))
 *   m(t) = scale + breath·s
 *   (x, y) = 50 + u(t) · m(t)
 *
 * 粒子沿曲线拖尾流动，整体缓慢旋转 + 呼吸缩放。
 * 使用 SVG + requestAnimationFrame 渲染，适配 light/dark 主题。
 */

import * as React from 'react'

import { cn } from '@/lib/utils'

interface ThreePetalSpiralProps {
  className?: string
  /** 动画缩放尺寸，默认 24px */
  size?: number
}

const SPIRAL_CONFIG = {
  particleCount: 82,
  trailSpan: 0.34,
  durationMs: 2800,
  rotationDurationMs: 16000,
  pulseDurationMs: 2800,
  strokeWidth: 2.6,
  R: 3.0,
  r: 1.0,
  d: 3.0,
  scale: 3.6,
  breath: 0.55,
  pathSteps: 720,
} as const

/** 计算曲线上的点 */
function spiralPoint(progress: number, detailScale: number): { x: number; y: number } {
  const t = progress * Math.PI * 2
  const d = SPIRAL_CONFIG.d + detailScale * 0.25
  const Rmr = SPIRAL_CONFIG.R - SPIRAL_CONFIG.r
  const baseX = Rmr * Math.cos(t) + d * Math.cos((Rmr / SPIRAL_CONFIG.r) * t)
  const baseY = Rmr * Math.sin(t) - d * Math.sin((Rmr / SPIRAL_CONFIG.r) * t)
  const s = SPIRAL_CONFIG.scale + detailScale * SPIRAL_CONFIG.breath
  return { x: 50 + baseX * s, y: 50 + baseY * s }
}

/** 构建完整曲线路径 */
function buildPath(detailScale: number): string {
  const steps = SPIRAL_CONFIG.pathSteps
  let d = ''
  for (let i = 0; i <= steps; i++) {
    const p = spiralPoint(i / steps, detailScale)
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(3)} ${p.y.toFixed(3)} `
  }
  return d
}

/** 计算单个粒子属性 */
function getParticle(
  index: number,
  progress: number,
  detailScale: number
): { x: number; y: number; radius: number; opacity: number } {
  const tailOffset = index / (SPIRAL_CONFIG.particleCount - 1)
  const np = (((progress - tailOffset * SPIRAL_CONFIG.trailSpan) % 1) + 1) % 1
  const point = spiralPoint(np, detailScale)
  const fade = Math.pow(1 - tailOffset, 0.56)
  return {
    x: point.x,
    y: point.y,
    radius: 0.5 + fade * 1.8,
    opacity: 0.04 + fade * 0.96,
  }
}

export function ThreePetalSpiral({
  className,
  size = 24,
}: ThreePetalSpiralProps): React.ReactElement {
  const svgRef = React.useRef<SVGSVGElement>(null)
  const groupEl = React.useRef<SVGGElement | null>(null)
  const pathEl = React.useRef<SVGPathElement | null>(null)
  const particleEls = React.useRef<SVGCircleElement[]>([])
  const rafId = React.useRef(0)
  const startTime = React.useRef(0)

  // 初始化 SVG 子元素
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const ns = 'http://www.w3.org/2000/svg'

    const g = document.createElementNS(ns, 'g')
    svg.appendChild(g)
    groupEl.current = g

    const path = document.createElementNS(ns, 'path')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('opacity', '0.28')
    path.setAttribute('stroke-width', String(SPIRAL_CONFIG.strokeWidth))
    g.appendChild(path)
    pathEl.current = path

    const circles: SVGCircleElement[] = []
    for (let i = 0; i < SPIRAL_CONFIG.particleCount; i++) {
      const circle = document.createElementNS(ns, 'circle')
      circle.setAttribute('fill', 'currentColor')
      g.appendChild(circle)
      circles.push(circle)
    }
    particleEls.current = circles

    return () => {
      while (svg.firstChild) svg.removeChild(svg.firstChild)
      groupEl.current = null
      pathEl.current = null
      particleEls.current = []
    }
  }, [])

  // 动画循环
  React.useEffect(() => {
    startTime.current = performance.now()

    function render(now: number): void {
      const time = now - startTime.current
      const progress = (time % SPIRAL_CONFIG.durationMs) / SPIRAL_CONFIG.durationMs

      // 呼吸缩放
      const pulsePhase = (time % SPIRAL_CONFIG.pulseDurationMs) / SPIRAL_CONFIG.pulseDurationMs
      const detailScale = 0.52 + ((Math.sin(pulsePhase * Math.PI * 2 + 0.55) + 1) / 2) * 0.48

      // 旋转角度
      const rotation =
        -((time % SPIRAL_CONFIG.rotationDurationMs) / SPIRAL_CONFIG.rotationDurationMs) * 360

      const g = groupEl.current
      const p = pathEl.current
      const circles = particleEls.current

      if (g) g.setAttribute('transform', `rotate(${rotation} 50 50)`)
      if (p) p.setAttribute('d', buildPath(detailScale))

      for (let i = 0; i < circles.length; i++) {
        const pt = getParticle(i, progress, detailScale)
        const c = circles[i]!
        c.setAttribute('cx', pt.x.toFixed(3))
        c.setAttribute('cy', pt.y.toFixed(3))
        c.setAttribute('r', pt.radius.toFixed(3))
        c.setAttribute('opacity', pt.opacity.toFixed(3))
      }

      rafId.current = requestAnimationFrame(render)
    }

    rafId.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafId.current)
  }, [])

  return (
    <svg
      ref={svgRef}
      viewBox="28 28 44 44"
      className={cn('overflow-visible', className)}
      style={{ width: size, height: size, color: 'hsl(var(--primary))' }}
      aria-hidden="true"
    />
  )
}
