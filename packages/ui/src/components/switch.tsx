/**
 * Switch — 全局胶囊开关（唯一入口）
 *
 * 视觉来源：Uiverse.io / Shoh2008 / average-monkey-56（MIT）
 * 适配：粉紫渐变 → 主题 primary；灰轨 / 拇指 / 笑脸 → 语义 token。
 *
 * 尺寸：
 * - default：设置 / 表单（--size 24px）
 * - sm：工具栏 / 紧凑浮层（--size 20px）
 *
 * @example
 * ```tsx
 * import { Switch } from '@tagent/ui'
 * <Switch checked={on} onCheckedChange={setOn} />
 * <Switch size="sm" checked={on} onCheckedChange={setOn} />
 * ```
 */

'use client'

import * as SwitchPrimitives from '@radix-ui/react-switch'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const switchVariants = cva(
  [
    'ui-switch peer relative inline-block shrink-0 cursor-pointer border-0 p-0',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:cursor-not-allowed disabled:opacity-50',
  ],
  {
    variants: {
      size: {
        default: 'ui-switch--default',
        sm: 'ui-switch--sm',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  }
)

export interface SwitchProps
  extends
    React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>,
    VariantProps<typeof switchVariants> {}

const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, size = 'default', ...props }, ref) => {
    return (
      <SwitchPrimitives.Root
        ref={ref}
        className={cn(switchVariants({ size }), className)}
        data-size={size ?? 'default'}
        {...props}
      >
        {/* 轨道：未选中灰底盖住主题渐变；选中透明露出 primary 渐变 + 笑脸 */}
        <span className="ui-switch-track" aria-hidden="true" />
        <SwitchPrimitives.Thumb className="ui-switch-thumb" />
      </SwitchPrimitives.Root>
    )
  }
)
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch, switchVariants }
