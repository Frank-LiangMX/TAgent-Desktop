/**
 * AddonLoader — 附加加载动画
 *
 * 分类：**附加动画**（非默认 Spinner）
 * 来源：Uiverse.io / dexter-st / bright-lizard-8（MIT）
 * https://uiverse.io/dexter-st/bright-lizard-8
 *
 * 用途：全屏占位、生成中、重操作等待等需要更强视觉的场景。
 * 默认轻量加载请继续用 Spinner / LoadingIndicator / ThreePetalSpiral。
 *
 * 颜色跟随主题 primary；文字继承 currentColor（可用 className 覆盖）。
 *
 * @example
 * ```tsx
 * import { AddonLoader } from '@tagent/ui'
 *
 * <AddonLoader />
 * <AddonLoader text="生成中" size={140} className="text-foreground" />
 * ```
 */

'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

export interface AddonLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 中心跳动文字（按字符拆分动画）
   * @default '加载中'
   */
  text?: string
  /**
   * 直径（px）
   * @default 180
   */
  size?: number
  /**
   * 字号（CSS 值），默认随直径缩放
   * @default '1.2em'
   */
  fontSize?: string
  /** 无障碍标签 */
  'aria-label'?: string
}

/**
 * 附加动画：旋转 inset 光环 + 逐字跳动。
 * 请勿当作全局默认加载器替换 Spinner。
 */
export function AddonLoader({
  text = '加载中',
  size = 180,
  fontSize = '1.2em',
  className,
  'aria-label': ariaLabel,
  style,
  ...props
}: AddonLoaderProps): React.ReactElement {
  const letters = React.useMemo(() => Array.from(text), [text])

  return (
    <div
      role="status"
      aria-label={ariaLabel ?? text}
      data-addon-animation="true"
      data-animation-kind="addon"
      className={cn('ui-addon-loader text-foreground', className)}
      style={
        {
          ...style,
          ['--ui-addon-loader-size' as string]: `${size}px`,
          ['--ui-addon-loader-font' as string]: fontSize,
        } as React.CSSProperties
      }
      {...props}
    >
      {letters.map((ch, index) => (
        <span
          key={`${ch}-${index}`}
          className="ui-addon-loader__letter"
          style={{ animationDelay: `${index * 0.1}s` }}
          aria-hidden="true"
        >
          {/* 空格保留宽度，避免文字塌缩 */}
          {ch === ' ' ? '\u00a0' : ch}
        </span>
      ))}
      <div className="ui-addon-loader__ring" aria-hidden="true" />
    </div>
  )
}

AddonLoader.displayName = 'AddonLoader'
