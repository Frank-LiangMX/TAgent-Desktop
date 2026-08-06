/**
 * MermaidBlock - Mermaid 图表渲染组件
 *
 * 优先使用 beautiful-mermaid 渲染，遇到 beautiful-mermaid 不支持的图型时
 * 自动回退到官方 mermaid 渲染器。
 *
 * 渲染时序：
 *   流式输出 → 源码自然增长（零跳动）
 *   code 稳定 350ms → 后台 renderMermaid
 *   成功 → SVG 替换源码展示
 *   失败 → 保持源码展示
 *
 * 防竞态：generation 计数器，只有最新一代的渲染结果才会生效
 *
 * 缩放交互：仅头部按钮（缩小 / 重置 / 放大）。不响应滚轮和拖拽，
 * 让滚轮事件正常冒泡到页面滚动；放大后用容器原生 overflow scrollbar 浏览。
 */

import * as React from 'react'

import type { DiagramColors, RenderOptions } from 'beautiful-mermaid'

import { cn } from '../lib/utils'
import { RichFullscreen } from '../rich-content/RichFrame'
import { MessageRichPreviewContext } from '../rich-content/rich-preview-context'

interface MermaidBlockProps {
  /** mermaid 源码 */
  code: string
  /**
   * pane：分屏独立标签内嵌（隐藏「分屏打开」避免递归）
   * default：消息内嵌块
   */
  variant?: 'default' | 'pane'
}

/** 防抖间隔（ms） */
const DEBOUNCE_MS = 350
/** 缩放范围 */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 0.15
const INITIAL_SCALE = 1
let mermaidRenderId = 0

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
}

function getThemeOptions(themes: Record<string, DiagramColors>): RenderOptions {
  const dark = isDarkMode()
  const base = dark ? themes['github-dark'] : themes['github-light']
  // transparent：SVG 根节点不铺底；但 --bg 仍需实色——edge-label 药丸底用 var(--bg)，
  // 若也透明，连线会从标注文字中间穿过（像「没颜色的卡片被线挡」）。
  return {
    ...(base ?? { bg: '#ffffff', fg: '#0f172a' }),
    transparent: true,
    bg: dark ? '#0f172a' : '#f1f5f9',
    // 浅色：连线用近黑 slate，避免浅灰贴浅底看不清
    line: dark ? '#cbd5e1' : '#1e293b',
    border: dark ? '#94a3b8' : '#475569',
    accent: dark ? '#93c5fd' : '#1d4ed8',
    muted: dark ? '#94a3b8' : '#334155',
    surface: dark ? '#1e293b' : '#ffffff',
    fg: dark ? '#e2e8f0' : '#0f172a',
  }
}

function isUsableSvg(svg: unknown): svg is string {
  if (typeof svg !== 'string' || !svg.includes('<svg')) return false
  if (/(?:^|[^a-z])(?:NaN|Infinity|-Infinity)(?:[^a-z]|$)/i.test(svg)) return false
  // mermaid 解析失败时会返回带错误标记的 SVG，需要识别后走兜底
  if (svg.includes('aria-roledescription="error"')) return false
  if (svg.includes('class="error-text"')) return false
  return true
}

async function renderWithOfficialMermaid(code: string): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  const dark = isDarkMode()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // 解析/绘制失败时清理临时节点并抛错，而非把错误图注入 document.body
    // （后者会在页面底部残留一条孤立的 "Syntax error in text" bar）
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'base',
    themeVariables: {
      // 画布透明，交给外层冷灰洗底；节点仍用中性 slate，避免偏黄
      background: 'transparent',
      mainBkg: dark ? '#1e293b' : '#f8fafc',
      primaryColor: dark ? '#1e293b' : '#f8fafc',
      primaryTextColor: dark ? '#e2e8f0' : '#0f172a',
      primaryBorderColor: dark ? '#64748b' : '#475569',
      secondaryColor: dark ? '#1e293b' : '#f1f5f9',
      tertiaryColor: dark ? '#0f172a' : '#e2e8f0',
      lineColor: dark ? '#cbd5e1' : '#1e293b',
      textColor: dark ? '#e2e8f0' : '#0f172a',
    },
  })

  const id = `tagent-mermaid-${Date.now()}-${mermaidRenderId++}`
  const { svg } = await mermaid.render(id, code)
  if (!isUsableSvg(svg)) throw new Error('Mermaid 输出了无效 SVG')
  return svg
}

async function renderMermaidSvg(code: string): Promise<string> {
  try {
    const { renderMermaidSVGAsync, THEMES } = await import('beautiful-mermaid')
    const svg = await renderMermaidSVGAsync(code, getThemeOptions(THEMES))
    if (isUsableSvg(svg)) return svg
  } catch {
    // beautiful-mermaid 只覆盖部分图型，不支持时交给官方 mermaid 兜底。
  }

  return renderWithOfficialMermaid(code)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 从 SVG 字符串解析固有宽高（viewBox 或 width/height） */
function readSvgIntrinsicSize(svg: string): { w: number; h: number } | null {
  const vb = svg.match(/viewBox=["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i)
  if (vb) {
    const w = Number(vb[3])
    const h = Number(vb[4])
    if (w > 0 && h > 0) return { w, h }
  }
  const wm = svg.match(/\bwidth=["']([\d.]+)(?:px)?["']/i)
  const hm = svg.match(/\bheight=["']([\d.]+)(?:px)?["']/i)
  if (wm && hm) {
    const w = Number(wm[1])
    const h = Number(hm[1])
    if (w > 0 && h > 0) return { w, h }
  }
  return null
}

/**
 * 画布铺满：按容器尺寸 fit SVG，再乘用户缩放。
 * 消息内 inline 不走这套，仍用手势 scale。
 */
function MermaidFitCanvas({
  svg,
  userScale,
}: {
  svg: string
  userScale: number
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [fit, setFit] = React.useState(1)
  const intrinsic = React.useMemo(() => readSvgIntrinsicSize(svg), [svg])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host || !intrinsic) return

    const update = (): void => {
      const pad = 32
      const cw = Math.max(0, host.clientWidth - pad)
      const ch = Math.max(0, host.clientHeight - pad)
      if (cw < 8 || ch < 8) return
      setFit(Math.min(cw / intrinsic.w, ch / intrinsic.h, 8))
    }

    update()
    const ro = new ResizeObserver(update)
    ro.observe(host)
    return () => ro.disconnect()
  }, [intrinsic, svg])

  const scale = fit * userScale

  return (
    <div
      ref={hostRef}
      className="mermaid-fit-canvas relative min-h-0 flex-1 overflow-auto bg-foreground/[0.015]"
    >
      <div className="flex h-full w-full items-center justify-center p-4">
        <div
          className="mermaid-svg mermaid-svg--fit [&>svg]:bg-transparent"
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
            width: intrinsic?.w,
            height: intrinsic?.h,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  )
}

// ===== 图标（与 CodeBlock 一致） =====

const ICON_ATTRS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}
const copyIconPath = (
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
)
const checkIconPath = <polyline points="20 6 9 17 4 12" />
const zoomInPath = (
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </>
)
const zoomOutPath = (
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </>
)

const fullscreenIconPath = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>
)

const splitPanePath = (
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 3v18" />
  </>
)

// ===== 主组件 =====

export function MermaidBlock({
  code,
  variant = 'default',
}: MermaidBlockProps): React.ReactElement {
  const { openRichInSplit, openMermaidInSplit } = React.useContext(MessageRichPreviewContext)
  const [renderedSvg, setRenderedSvg] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [scale, setScale] = React.useState<number>(INITIAL_SCALE)
  const [fullscreenOpen, setFullscreenOpen] = React.useState(false)

  const codeRef = React.useRef(code)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** generation 计数器：每次 code 变化递增，防止异步竞态 */
  const generationRef = React.useRef(0)

  codeRef.current = code

  const renderCurrentCode = React.useCallback(async (generation: number) => {
    try {
      const svg = await renderMermaidSvg(codeRef.current)
      if (generationRef.current !== generation) return
      setRenderedSvg(svg)
    } catch {
      if (generationRef.current === generation) setRenderedSvg(null)
    }
  }, [])

  // ==== 唯一的渲染 effect：全部走防抖，generation 防竞态 ====
  React.useEffect(() => {
    // 每次 code 变化递增 generation，作废所有旧的异步渲染
    generationRef.current++
    const currentGen = generationRef.current

    if (debounceRef.current) clearTimeout(debounceRef.current)
    setRenderedSvg(null)
    setScale(INITIAL_SCALE)
    debounceRef.current = setTimeout(() => {
      void renderCurrentCode(currentGen)
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [code, renderCurrentCode])

  // ---- 主题变化：重新渲染当前 code ----
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      generationRef.current++
      void renderCurrentCode(generationRef.current)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [renderCurrentCode])

  const handleZoomIn = React.useCallback(() => {
    setScale((prev) => clamp(prev + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX))
  }, [])
  const handleZoomOut = React.useCallback(() => {
    setScale((prev) => clamp(prev - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX))
  }, [])
  const handleZoomReset = React.useCallback(() => setScale(INITIAL_SCALE), [])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('[MermaidBlock] 复制失败:', error)
    }
  }, [code])

  const zoomPercent = Math.round(scale * 100)
  const canOpenSplit =
    variant === 'default' && Boolean(openRichInSplit || openMermaidInSplit)

  const handleOpenSplit = (): void => {
    if (openRichInSplit) {
      openRichInSplit({ kind: 'mermaid', code, title: 'Mermaid' })
      return
    }
    openMermaidInSplit?.(code, 'Mermaid')
  }

  const renderDiagram = (fill: boolean): React.ReactElement => {
    if (!renderedSvg) {
      return (
        <pre
          className={cn(
            'mermaid-block-scroll scrollbar-thin m-0 overflow-x-auto bg-foreground/[0.015] p-4 text-[13px] leading-[1.6] text-foreground/80',
            fill && 'min-h-0 flex-1',
          )}
        >
          <code>{code}</code>
        </pre>
      )
    }
    if (fill) {
      return <MermaidFitCanvas svg={renderedSvg} userScale={scale} />
    }
    return (
      <div className="mermaid-block-scroll scrollbar-thin min-h-[180px] overflow-auto bg-foreground/[0.02]">
        <div
          className="flex min-h-[180px] origin-center items-center justify-center p-4"
          style={{ transform: `scale(${scale})` }}
        >
          <div
            className="mermaid-svg [&>svg]:h-auto [&>svg]:max-w-full [&>svg]:bg-transparent"
            dangerouslySetInnerHTML={{ __html: renderedSvg }}
          />
        </div>
      </div>
    )
  }

  /** 全屏 / 分屏共用：无卡片边框，仅顶栏缩放 + 画布铺满 */
  const expandedChrome = (opts: { showCopy?: boolean }): React.ReactElement => (
    <div className="flex h-full min-h-0 flex-col bg-foreground/[0.015]">
      <div className="flex h-[34px] shrink-0 items-center justify-end gap-1 px-2 text-xs text-muted-foreground">
        {renderedSvg ? (
          <div className="mr-auto flex items-center gap-0.5">
            <button
              type="button"
              onClick={handleZoomOut}
              className="rounded p-0.5 transition-colors hover:bg-foreground/10"
              title="缩小"
            >
              <svg {...ICON_ATTRS}>{zoomOutPath}</svg>
            </button>
            <button
              type="button"
              onClick={handleZoomReset}
              className="min-w-[40px] rounded px-1 py-0.5 text-center tabular-nums transition-colors hover:bg-foreground/10"
              title="适应画布"
            >
              {zoomPercent}%
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              className="rounded p-0.5 transition-colors hover:bg-foreground/10"
              title="放大"
            >
              <svg {...ICON_ATTRS}>{zoomInPath}</svg>
            </button>
          </div>
        ) : (
          <span className="mr-auto select-none text-muted-foreground/70">渲染中…</span>
        )}
        {opts.showCopy ? (
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <svg {...ICON_ATTRS}>{copied ? checkIconPath : copyIconPath}</svg>
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        ) : null}
      </div>
      {renderDiagram(true)}
    </div>
  )

  if (variant === 'pane') {
    return expandedChrome({ showCopy: true })
  }

  return (
    <>
      <div className="mermaid-block-wrapper group/mermaid my-2 overflow-hidden rounded-[var(--radius-glass-modal)] border border-foreground/15 bg-foreground/[0.02]">
        <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-foreground/10 bg-foreground/[0.045] px-2 py-1 text-xs text-muted-foreground">
          <span className="select-none font-medium">Mermaid</span>
          <div className="flex items-center gap-1">
            {renderedSvg && (
              <div className="mr-2 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={handleZoomOut}
                  className="rounded p-0.5 transition-colors hover:bg-foreground/10"
                  title="缩小"
                >
                  <svg {...ICON_ATTRS}>{zoomOutPath}</svg>
                </button>
                <button
                  type="button"
                  onClick={handleZoomReset}
                  className="min-w-[40px] rounded px-1 py-0.5 text-center tabular-nums transition-colors hover:bg-foreground/10"
                  title="重置缩放"
                >
                  {zoomPercent}%
                </button>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  className="rounded p-0.5 transition-colors hover:bg-foreground/10"
                  title="放大"
                >
                  <svg {...ICON_ATTRS}>{zoomInPath}</svg>
                </button>
              </div>
            )}
            {canOpenSplit ? (
              <button
                type="button"
                onClick={handleOpenSplit}
                className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                title="在分屏独立标签打开"
              >
                <svg {...ICON_ATTRS}>{splitPanePath}</svg>
                <span>分屏</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setFullscreenOpen(true)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              title="全屏查看"
            >
              <svg {...ICON_ATTRS}>{fullscreenIconPath}</svg>
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <svg {...ICON_ATTRS}>{copied ? checkIconPath : copyIconPath}</svg>
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        </div>
        <div className="overflow-hidden">{renderDiagram(false)}</div>
      </div>

      <RichFullscreen
        open={fullscreenOpen}
        title="Mermaid"
        onClose={() => setFullscreenOpen(false)}
        size="wide"
      >
        {expandedChrome({ showCopy: false })}
      </RichFullscreen>
    </>
  )
}
