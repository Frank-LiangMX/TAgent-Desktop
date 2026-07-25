/**
 * SettingsCard - 设置卡片
 *
 * 抬升表面 + 行间分隔；视觉由 glass.css `.settings-card` 统一。
 */

import * as React from 'react'

import { Separator } from '../separator'
import { cn } from '../../lib/utils'
import { CARD_CLASS, DIVIDER_CLASS } from './SettingsUIConstants'

interface SettingsCardProps {
  children: React.ReactNode
  className?: string
  divided?: boolean
}

export function SettingsCard({
  children,
  className,
  divided = true,
}: SettingsCardProps): React.ReactElement {
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <div className={cn(CARD_CLASS, className)}>
      {divided
        ? childArray.map((child, index) => (
            <React.Fragment key={index}>
              {child}
              {index < childArray.length - 1 && (
                <Separator className={cn(DIVIDER_CLASS, 'settings-card-sep')} />
              )}
            </React.Fragment>
          ))
        : children}
    </div>
  )
}
