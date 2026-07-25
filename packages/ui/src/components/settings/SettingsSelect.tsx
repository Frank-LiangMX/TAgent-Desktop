/**
 * SettingsSelect - 设置下拉选择控件
 *
 * 封装 ShadcnUI Select，集成标签和描述。
 * 用于有限选项的设置项。
 *
 * 左右结构：左侧 label + ? tooltip，右侧 Select。
 * description 默认隐藏到 ? 图标 tooltip，避免满屏文字。
 */

import * as React from 'react'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'
import { cn } from '../../lib/utils'
import { FieldLabel } from './FieldLabel'
import { ROW_CLASS } from './SettingsUIConstants'

/** 选项定义 */
export interface SelectOption {
  value: string
  label: string
  /** 选项图标 URL（可选） */
  icon?: string
}

interface SettingsSelectProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选，hover ? 图标显示 tooltip） */
  description?: string
  /** 标签左侧图标（可选） */
  icon?: React.ReactNode
  /** 当前值 */
  value: string
  /** 变更回调 */
  onValueChange: (value: string) => void
  /** 选项列表 */
  options: SelectOption[]
  /** 占位符 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
}

export function SettingsSelect({
  label,
  description,
  icon,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
}: SettingsSelectProps): React.ReactElement {
  const selected = React.useMemo(() => options.find((o) => o.value === value), [options, value])

  return (
    <div className={cn(ROW_CLASS, 'settings-row--select')}>
      <div className="settings-row-main min-w-0 flex-1">
        <FieldLabel label={label} icon={icon} description={description} />
      </div>
      <div className="settings-row-control shrink-0">
        <Select value={value} onValueChange={onValueChange} disabled={disabled}>
          <SelectTrigger className="w-[200px] shrink-0 rounded-xl">
            <SelectValue placeholder={placeholder}>
              {selected ? (
                <span className="flex items-center gap-2">
                  {selected.icon && (
                    <img src={selected.icon} alt="" className="w-4 h-4 rounded-sm object-contain" />
                  )}
                  <span>{selected.label}</span>
                </span>
              ) : (
                placeholder
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2">
                  {option.icon && (
                    <img src={option.icon} alt="" className="w-4 h-4 rounded-sm object-contain" />
                  )}
                  <span>{option.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
