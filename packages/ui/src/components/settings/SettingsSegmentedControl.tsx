/**
 * SettingsSegmentedControl - 分段选择行
 */

import * as React from 'react'

import { SegmentedTabs, SegmentedTabsItem } from '../segmented-tabs'
import { cn } from '../../lib/utils'
import { FieldLabel } from './FieldLabel'
import { ROW_CLASS } from './SettingsUIConstants'

interface SegmentOption {
  value: string
  label: string
}

interface SettingsSegmentedControlProps {
  label: string
  description?: string
  value: string
  onValueChange: (value: string) => void
  options: SegmentOption[]
  disabled?: boolean
}

export function SettingsSegmentedControl({
  label,
  description,
  value,
  onValueChange,
  options,
  disabled,
}: SettingsSegmentedControlProps): React.ReactElement {
  return (
    <div className={cn(ROW_CLASS, 'settings-row--segmented')}>
      <div className="settings-row-main min-w-0 flex-1">
        <FieldLabel label={label} description={description} />
      </div>
      <div className="settings-row-control shrink-0">
        <SegmentedTabs
          className="settings-segmented shrink-0"
          value={value}
          onValueChange={onValueChange}
        >
          {options.map((option) => (
            <SegmentedTabsItem key={option.value} value={option.value} disabled={disabled}>
              {option.label}
            </SegmentedTabsItem>
          ))}
        </SegmentedTabs>
      </div>
    </div>
  )
}
