/**
 * PlayPauseToggle — Play / Pause 图标切换控件
 *
 * 来源：Uiverse.io / catraco / wet-rabbit-81（MIT）
 * 语义：playing=true 时显示暂停图标，false 时显示播放图标。
 * 支持受控 / 非受控；颜色继承 currentColor（推荐配合 text-muted-foreground 等语义类）。
 *
 * @example
 * ```tsx
 * import { PlayPauseToggle } from '@tagent/ui'
 *
 * <PlayPauseToggle
 *   playing={isPlaying}
 *   onPlayingChange={setIsPlaying}
 *   className="text-muted-foreground hover:text-foreground"
 * />
 * ```
 */

'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

export interface PlayPauseToggleProps {
  /**
   * 是否播放中（受控）
   * true → 显示暂停图标；false → 显示播放图标
   */
  playing?: boolean
  /** 非受控初始值 */
  defaultPlaying?: boolean
  /** 状态变化回调 */
  onPlayingChange?: (playing: boolean) => void
  /**
   * 图标尺寸（px），通过 CSS 变量控制
   * @default 30
   */
  size?: number
  /** 是否禁用 */
  disabled?: boolean
  /** 外层 className */
  className?: string
  /** input id（可选，默认自动生成） */
  id?: string
  /** 无障碍标签 */
  'aria-label'?: string
}

/**
 * Play / Pause 切换：原生 checkbox 驱动图标交换 + 旋转缩放入场动画。
 */
export const PlayPauseToggle = React.forwardRef<HTMLInputElement, PlayPauseToggleProps>(
  (
    {
      playing: playingProp,
      defaultPlaying = false,
      onPlayingChange,
      size = 30,
      disabled,
      className,
      id: idProp,
      'aria-label': ariaLabel = '播放 / 暂停',
    },
    ref
  ) => {
    const reactId = React.useId()
    const inputId = idProp ?? `play-pause-toggle-${reactId}`
    const isControlled = playingProp !== undefined
    const [uncontrolledPlaying, setUncontrolledPlaying] = React.useState(defaultPlaying)
    const playing = isControlled ? Boolean(playingProp) : uncontrolledPlaying

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
      const next = event.target.checked
      if (!isControlled) {
        setUncontrolledPlaying(next)
      }
      onPlayingChange?.(next)
    }

    return (
      <label
        htmlFor={inputId}
        className={cn(
          'ui-play-pause-toggle text-muted-foreground transition-colors',
          'hover:text-foreground',
          disabled && 'pointer-events-none',
          className
        )}
        style={{ ['--ppt-size' as string]: `${size}px` }}
      >
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="ui-play-pause-toggle__input"
          checked={playing}
          disabled={disabled}
          onChange={handleChange}
          aria-label={ariaLabel}
          aria-pressed={playing}
        />
        {/* Play 图标（未播放）— 原 Uiverse path */}
        <svg
          viewBox="0 0 384 512"
          height="1em"
          width="1em"
          xmlns="http://www.w3.org/2000/svg"
          className="ui-play-pause-toggle__icon ui-play-pause-toggle__icon--play"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80V432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z" />
        </svg>
        {/* Pause 图标（播放中）— 原 Uiverse path */}
        <svg
          viewBox="0 0 320 512"
          height="1em"
          width="1em"
          xmlns="http://www.w3.org/2000/svg"
          className="ui-play-pause-toggle__icon ui-play-pause-toggle__icon--pause"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M48 64C21.5 64 0 85.5 0 112V400c0 26.5 21.5 48 48 48H80c26.5 0 48-21.5 48-48V112c0-26.5-21.5-48-48-48H48zm192 0c-26.5 0-48 21.5-48 48V400c0 26.5 21.5 48 48 48h32c26.5 0 48-21.5 48-48V112c0-26.5-21.5-48-48-48H240z" />
        </svg>
      </label>
    )
  }
)
PlayPauseToggle.displayName = 'PlayPauseToggle'
