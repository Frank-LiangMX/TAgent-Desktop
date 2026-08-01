/**
 * RichFrame — 富内容块外壳（自研）
 *
 * 统一视觉：标题栏（内容类型）+ 操作（复制 / 全屏）+ 内容体。
 * 样式走全局 tokens（radius-glass / foreground / muted-foreground / border），
 * 头部栏与 CodeBlock / MermaidBlock 同构。
 *
 * RichBlockBoundary：单个富块渲染失败 → 回退 fallback（普通代码块），
 * 不拖垮整条消息。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../lib/utils'

// ===== 图标（与 CodeBlock / MermaidBlock 一致） =====

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
const fullscreenIconPath = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>
)

// ===== 错误边界 =====

interface RichBlockBoundaryProps {
  fallback: React.ReactNode
  children: React.ReactNode
}

interface RichBlockBoundaryState {
  failed: boolean
}

export class RichBlockBoundary extends React.Component<
  RichBlockBoundaryProps,
  RichBlockBoundaryState
> {
  override state: RichBlockBoundaryState = { failed: false }

  static getDerivedStateFromError(): RichBlockBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.warn('[rich-content] 富块渲染失败，回退普通代码块:', error)
  }

  override render(): React.ReactNode {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

// ===== 复制按钮 =====

interface CopyActionProps {
  value: string
  label?: string
}

export function RichCopyAction({ value, label }: CopyActionProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false)

  const handleCopy = React.useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (error) {
      console.error('[rich-content] 复制失败:', error)
    }
  }, [value])

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      title={copied ? '已复制' : '复制'}
    >
      <svg {...ICON_ATTRS}>{copied ? checkIconPath : copyIconPath}</svg>
      {label !== undefined && <span>{copied ? '已复制' : label}</span>}
    </button>
  )
}

// ===== 全屏 =====

interface RichFullscreenProps {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}

function RichFullscreen({
  open,
  title,
  onClose,
  children,
}: RichFullscreenProps): React.ReactElement | null {
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="flex h-full w-full max-w-[1200px] flex-col overflow-hidden rounded-[var(--radius-glass-modal)] border border-border/70 bg-background shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-[40px] shrink-0 items-center justify-between border-b border-border/70 bg-foreground/[0.05] px-3">
          <strong className="text-xs font-semibold text-foreground">{title}</strong>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            title="关闭"
          >
            <svg {...ICON_ATTRS}>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>
        <div className="rich-fullscreen-body scrollbar-thin min-h-0 flex-1 overflow-auto">{children}</div>
      </section>
    </div>,
    document.body,
  )
}

// ===== 主外壳 =====

export interface RichFrameProps {
  title: string
  /** 追加到头部栏的操作按钮（复制按钮自带） */
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** 显示复制按钮（复制围栏源码） */
  copyValue?: string
  /** 是否提供全屏入口 */
  fullscreen?: boolean
  fullscreenTitle?: string
}

export function RichFrame({
  title,
  actions,
  children,
  className,
  copyValue,
  fullscreen = false,
  fullscreenTitle,
}: RichFrameProps): React.ReactElement {
  const [fullscreenOpen, setFullscreenOpen] = React.useState(false)

  return (
    <>
      <section
        className={cn(
          'my-2 overflow-hidden rounded-glass-popover border border-border/70',
          className,
        )}
      >
        <div className="flex h-[34px] items-center justify-between bg-foreground/[0.05] px-2 py-1 text-xs text-muted-foreground">
          <span className="select-none font-medium">{title}</span>
          <div className="flex items-center gap-1">
            {actions}
            {fullscreen && (
              <button
                type="button"
                onClick={() => setFullscreenOpen(true)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                title="全屏查看"
              >
                <svg {...ICON_ATTRS}>{fullscreenIconPath}</svg>
              </button>
            )}
            {copyValue !== undefined && <RichCopyAction value={copyValue} />}
          </div>
        </div>
        <div className="rich-frame-body scrollbar-thin overflow-x-auto">{children}</div>
      </section>

      {fullscreen && (
        <RichFullscreen
          open={fullscreenOpen}
          title={fullscreenTitle ?? title}
          onClose={() => setFullscreenOpen(false)}
        >
          {children}
        </RichFullscreen>
      )}
    </>
  )
}
