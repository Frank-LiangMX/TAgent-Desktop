import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2, Search, X } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/** 搜索框统一圆角（与插件侧栏原 rounded-xl 一致） */
const SEARCH_INPUT_RADIUS = 'rounded-glass-rail'

/*
 * 注意：flex / gap / padding 工具类只加在非 capsule 变体上。
 * capsule 的布局（grid 三列 / 高度 / 内距）全权由 search.css 管，
 * 若在这里加 flex / px-* 会在 Tailwind utilities 层压过 CSS，破坏粒子与 label 定位。
 */
const searchInputVariants = cva('ui-search-input w-full', {
  variants: {
    variant: {
      /** 设置页 / 表单内标准搜索框 — 干净白底，避免 muted 灰泥 */
      default: cn(
        'flex items-center gap-2 transition-colors',
        SEARCH_INPUT_RADIUS,
        'border border-foreground/[0.08] bg-card shadow-[0_1px_0_hsl(var(--foreground)/0.03)]',
        'focus-within:border-foreground/20 focus-within:shadow-[0_0_0_3px_hsl(var(--foreground)/0.04)]'
      ),
      /** 侧栏 / 列表面板紧凑搜索 */
      muted: cn(
        'flex items-center gap-2 transition-colors',
        SEARCH_INPUT_RADIUS,
        'border border-foreground/[0.06] bg-card/80',
        'focus-within:border-foreground/16 focus-within:bg-card'
      ),
      /** 插件面板 / 模型选择器等玻璃浮层 */
      glass: cn(
        'flex items-center gap-2 transition-colors',
        SEARCH_INPUT_RADIUS,
        'ui-search-input--glass border border-transparent'
      ),
      /** 对话框顶栏：无容器背景，仅图标 + 输入 */
      plain:
        'flex items-center gap-2 transition-colors rounded-none border-0 bg-transparent p-0 shadow-none ring-0 focus-within:ring-0',
      /**
       * 侧栏会话搜索：玻璃本体形状不变
       * focus：Uiverse clever-panda-6 — Nebula 四层扩散 + 左粒子 + 文字上浮
       */
      capsule: 'ui-search-input--capsule',
    },
    size: {
      sm: 'h-7 px-2',
      md: 'h-8 px-2.5',
      lg: 'h-9 px-3',
      /** 侧栏紧凑：高度 / 内距全由 .ui-search-input--capsule 管（30px / 0 9px） */
      capsule: '',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'md',
  },
})

const searchInputFieldVariants = cva(
  'min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-foreground/35 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        sm: 'text-[11px]',
        md: 'text-sm',
        lg: 'text-sm',
        /* 字号由 .ui-search-input--capsule > input 管（12px） */
        capsule: '',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  }
)

const SEARCH_ICON_SIZE = {
  sm: 13,
  md: 14,
  lg: 16,
  capsule: 14,
} as const satisfies Record<NonNullable<VariantProps<typeof searchInputVariants>['size']>, number>

/**
 * clever-panda-6 粒子轨迹（源码一致）
 * left 起点在输入框左侧，focus 时沿 --x/--y 飞出
 */
const NEBULA_PARTICLES = [
  { x: 0.2, y: -0.4, delay: '0.1s' },
  { x: 0.5, y: -0.2, delay: '0.3s' },
  { x: 0.3, y: 0.3, delay: '0.5s' },
  { x: 0.7, y: 0.1, delay: '0.2s' },
  { x: 0.1, y: -0.7, delay: '0.4s' },
  { x: 0.6, y: 0.4, delay: '0.6s' },
] as const

export interface SearchInputProps
  extends
    Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof searchInputVariants> {
  /** 外层容器 class */
  containerClassName?: string
  /** 显示加载中图标（替代搜索图标） */
  loading?: boolean
  /** 是否显示清空按钮；默认有 value 且提供 onClear 时显示 */
  showClear?: boolean
  /** 点击清空按钮 */
  onClear?: () => void
  /** 右侧附加内容（快捷键提示、计数等） */
  trailing?: React.ReactNode
}

const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      className,
      containerClassName,
      variant,
      size,
      loading = false,
      showClear,
      onClear,
      trailing,
      value,
      disabled,
      placeholder,
      ...props
    },
    ref
  ) => {
    // capsule 变体默认用 capsule 高度档
    const resolvedSize = size ?? (variant === 'capsule' ? 'capsule' : 'md')
    const iconSize = SEARCH_ICON_SIZE[resolvedSize]
    const stringValue = typeof value === 'string' ? value : undefined
    const filled = !!stringValue && stringValue.length > 0
    const showClearButton = showClear ?? (onClear !== undefined && filled)
    const isCapsule = variant === 'capsule'
    // capsule：placeholder 改作上浮标签文案，input 用空格占位以便 :placeholder-shown 判断
    const floatLabel = isCapsule ? (placeholder ?? '') : undefined
    const inputPlaceholder = isCapsule ? ' ' : placeholder

    return (
      <div
        className={cn(searchInputVariants({ variant, size: resolvedSize }), containerClassName)}
        data-filled={isCapsule && filled ? 'true' : undefined}
      >
        {loading ? (
          <Loader2
            size={iconSize}
            className="shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : (
          <Search
            size={iconSize}
            className="shrink-0 text-foreground/40"
            strokeWidth={2}
            aria-hidden
          />
        )}
        <input
          ref={ref}
          type="text"
          disabled={disabled}
          value={value}
          autoComplete="off"
          placeholder={inputPlaceholder}
          className={cn(searchInputFieldVariants({ size: resolvedSize }), className)}
          {...props}
        />
        {/* clever-panda-6：user-label 上浮（focus / 有内容） */}
        {isCapsule && floatLabel ? (
          <span className="ui-search-float-label" aria-hidden>
            {floatLabel}
          </span>
        ) : null}
        {/* capsule 用 grid 三列，无 trailing 时不渲染空 div */}
        {(showClearButton || trailing) && (
          <div className="ui-search-capsule-trailing flex shrink-0 items-center gap-1">
            {showClearButton && onClear ? (
              <button
                type="button"
                tabIndex={-1}
                onClick={onClear}
                className={cn(
                  'text-muted-foreground transition-colors hover:text-foreground',
                  isCapsule
                    ? 'rounded-md p-0.5 hover:bg-foreground/[0.06]'
                    : 'rounded-full p-1 hover:bg-foreground/[0.06]'
                )}
                aria-label="清空"
              >
                <X size={isCapsule || resolvedSize === 'sm' ? 11 : 13} />
              </button>
            ) : null}
            {trailing}
          </div>
        )}
        {/* Nebula 粒子：左侧起点，focus 时飞出 */}
        {isCapsule
          ? NEBULA_PARTICLES.map((p, i) => (
              <span
                key={i}
                className="ui-search-nebula-particle"
                aria-hidden
                style={
                  {
                    ['--x' as string]: String(p.x),
                    ['--y' as string]: String(p.y),
                    ['--delay' as string]: p.delay,
                  } as React.CSSProperties
                }
              />
            ))
          : null}
      </div>
    )
  }
)
SearchInput.displayName = 'SearchInput'

export { SearchInput, searchInputFieldVariants, searchInputVariants }
