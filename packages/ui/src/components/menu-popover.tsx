/**
 * MenuPopover — 弹窗类菜单通用积木
 *
 * 纯展示积木，搭配 @tagent/ui 的 Popover / PopoverContent 使用（不重造 Popover）。
 * 两种形态都覆盖：
 *   - 图标列表项（ModelSelector）：icon + label + trailing
 *   - 描述式选项（ComposerUnderlay 权限/子代理）：label + description + trailing(Check)
 *
 * 视觉：session-menu-item（hover 中性 foreground/8，不复用偏浊的 session-list-row）；
 *       选中态挂 session-list-item-active（玻璃浮岛）。
 */

import * as React from 'react'

import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/* MenuPopoverItem — 通用列表项 button */

export interface MenuPopoverItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** 是否选中（挂玻璃浮岛选中态） */
  selected?: boolean
  /** 左侧图标 / 缩略图（调用方控尺寸，建议 size-4 / size-5） */
  icon?: React.ReactNode
  /** 主文本 */
  label: React.ReactNode
  /** 副文本（描述式选项用，单行时省略） */
  description?: React.ReactNode
  /** 尾部槽（选中 Check、「默认」chip 等） */
  trailing?: React.ReactNode
}

export const MenuPopoverItem = React.forwardRef<HTMLButtonElement, MenuPopoverItemProps>(
  function MenuPopoverItem(
    { selected = false, icon, label, description, trailing, className, children, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        aria-selected={selected}
        className={cn(
          'session-menu-item',
          selected && 'session-menu-item--active session-list-item-active',
          className,
        )}
        {...props}
      >
        {icon != null && <span className="shrink-0">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{label}</span>
          {description != null && (
            <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
              {description}
            </span>
          )}
          {children}
        </span>
        {trailing != null && <span className="shrink-0">{trailing}</span>}
      </button>
    )
  },
)

/* ------------------------------------------------------------------ */
/* MenuPopoverGroup — 分组（组头 + 项列表） */

export interface MenuPopoverGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 组头（logo + 组名，调用方组合传入） */
  heading?: React.ReactNode
}

export const MenuPopoverGroup = React.forwardRef<HTMLDivElement, MenuPopoverGroupProps>(
  function MenuPopoverGroup({ heading, className, children, ...props }, ref) {
    return (
      <div ref={ref} className={cn('mb-1.5 last:mb-0', className)} {...props}>
        {heading != null && (
          <div className="mb-1 flex items-center gap-2 px-2 py-1">{heading}</div>
        )}
        <div className="flex flex-col gap-0.5 pl-1">{children}</div>
      </div>
    )
  },
)

/* ------------------------------------------------------------------ */
/* MenuPopoverSectionLabel — 段标题（内网服务 / 外部服务 / 可选模型） */

export interface MenuPopoverSectionLabelProps
  extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode
  /** 大写小标题样式（默认 true） */
  uppercase?: boolean
}

export const MenuPopoverSectionLabel = React.forwardRef<
  HTMLDivElement,
  MenuPopoverSectionLabelProps
>(function MenuPopoverSectionLabel(
  { icon, uppercase = true, className, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'mb-0.5 mt-1 flex items-center gap-1.5 px-2 text-[10px] font-semibold text-muted-foreground/70',
        uppercase && 'uppercase tracking-[0.12em]',
        className,
      )}
      {...props}
    >
      {icon != null && <span className="shrink-0 [&_svg]:size-3">{icon}</span>}
      {children}
    </div>
  )
})

/* ------------------------------------------------------------------ */
/* MenuPopoverSeparator — 分隔线 */

export const MenuPopoverSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function MenuPopoverSeparator({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-hidden
      className={cn('mx-3 my-1.5 h-px bg-border/45', className)}
      {...props}
    />
  )
})
