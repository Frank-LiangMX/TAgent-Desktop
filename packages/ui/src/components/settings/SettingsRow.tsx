/**
 * SettingsRow - 设置行：左 label / 右控件
 */

import * as React from 'react'

import { cn } from '../../lib/utils'
import { FieldLabel } from './FieldLabel'
import { ROW_CLASS } from './SettingsUIConstants'

interface SettingsRowProps {
  label: string
  icon?: React.ReactNode
  description?: string
  children?: React.ReactNode
  bottomSlot?: React.ReactNode
  className?: string
}

export function SettingsRow({
  label,
  icon,
  description,
  children,
  bottomSlot,
  className,
}: SettingsRowProps): React.ReactElement {
  return (
    <div className={cn(ROW_CLASS, className)}>
      <div className="settings-row-main min-w-0 flex-1">
        <FieldLabel label={label} icon={icon} description={description} />
        {bottomSlot ? (
          <div className="settings-row-bottom mt-1.5 flex flex-wrap gap-1.5">{bottomSlot}</div>
        ) : null}
      </div>
      {children ? <div className="settings-row-control shrink-0">{children}</div> : null}
    </div>
  )
}
