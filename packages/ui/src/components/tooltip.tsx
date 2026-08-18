/**
 * Tooltip 全局体系
 *
 * - 基于 Radix Tooltip，禁止用浏览器原生 title 气泡
 * - 视觉：session-glass-tooltip 玻璃胶囊（packages/ui/styles/glass.css）
 * - 业务侧优先用 AppTooltip 一行封装；需要复合内容再用 Tooltip + Content
 */

import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'

import { cn } from '@/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

export type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(({ className, sideOffset = 6, collisionPadding = 10, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        // 材质/圆角：.session-glass-tooltip → --radius-glass-tooltip
        'session-glass-tooltip tagent-tooltip z-[10050]',
        'select-none text-balance',
        'animate-in fade-in-0 zoom-in-95 duration-150',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-100',
        'data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
        '[&_.text-muted-foreground]:text-tooltip-muted',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export interface AppTooltipProps {
  /** 提示文案；空 / null / undefined 则不挂 tooltip，直接渲染 children */
  label?: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
  align?: 'start' | 'center' | 'end'
  /** 长文案允许换行（路径、描述） */
  multiline?: boolean
  /** 覆盖 Provider 的 delay（ms） */
  delayDuration?: number
  /** 禁用时不显示 */
  disabled?: boolean
  /** 合并到 trigger 的 className */
  className?: string
  /** 内容气泡 className */
  contentClassName?: string
}

/**
 * 全局推荐封装：触发器 + 玻璃气泡。
 * 侧栏 / Rail / 工具条图标按钮请用这个，不要写 title=。
 */
export function AppTooltip({
  label,
  children,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  multiline = false,
  delayDuration,
  disabled = false,
  className,
  contentClassName,
}: AppTooltipProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)

  // 无文案才不包 Tooltip。disabled 不能拆包装——顶栏通知开弹窗时
  // disabled 会来回切，拆掉会重挂 children，胶囊文字闪进场动画。
  if (label == null || label === false || label === '') {
    return children
  }

  const trigger =
    className != null
      ? React.cloneElement(children, {
          className: cn(
            (children.props as { className?: string }).className,
            className,
          ),
        })
      : children

  return (
    <Tooltip
      delayDuration={delayDuration}
      open={disabled ? false : open}
      onOpenChange={(next) => {
        if (!disabled) setOpen(next)
      }}
    >
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={sideOffset}
        align={align}
        className={cn(
          multiline && 'tagent-tooltip--multiline',
          contentClassName,
        )}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
