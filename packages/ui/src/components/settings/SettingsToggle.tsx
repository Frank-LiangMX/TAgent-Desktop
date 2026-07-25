/**
 * SettingsToggle - 设置开关行
 *
 * 右侧开关统一走 `@tagent/ui` Switch，禁止业务侧再拼自定义胶囊。
 */

import * as React from 'react'

import { Switch, type SwitchProps } from '../switch'
import { cn } from '../../lib/utils'
import { FieldLabel } from './FieldLabel'
import { ROW_CLASS } from './SettingsUIConstants'

interface SettingsToggleProps {
  label: string
  description?: string
  icon?: React.ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  /** 开关尺寸，默认 default（设置行） */
  size?: SwitchProps['size']
}

export function SettingsToggle({
  label,
  description,
  icon,
  checked,
  onCheckedChange,
  disabled,
  size = 'default',
}: SettingsToggleProps): React.ReactElement {
  return (
    <div className={cn(ROW_CLASS, 'settings-row--toggle')}>
      <div className="settings-row-main min-w-0 flex-1">
        <FieldLabel label={label} icon={icon} description={description} />
      </div>
      <div className="settings-row-control shrink-0">
        <Switch
          size={size}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
