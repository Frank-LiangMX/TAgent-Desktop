/**
 * SettingsInput - 设置文本输入控件
 *
 * 封装 ShadcnUI Input，集成标签和描述。
 * 支持错误状态提示。
 *
 * 左右结构：左侧 label + ? tooltip，右侧 Input。
 */

import * as React from 'react'

import { Input } from '../input'
import { cn } from '../../lib/utils'
import { FieldLabel } from './FieldLabel'
import { ROW_CLASS } from './SettingsUIConstants'

interface SettingsInputProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选，hover ? 图标显示 tooltip） */
  description?: string
  /** 输入值 */
  value: string
  /** 变更回调 */
  onChange: (value: string) => void
  /** 失焦回调（可选，用于延迟保存场景） */
  onBlur?: () => void
  /** 占位符 */
  placeholder?: string
  /** 是否必填 */
  required?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 错误信息（可选） */
  error?: string
  /** 输入类型 */
  type?: string
}

export function SettingsInput({
  label,
  description,
  value,
  onChange,
  onBlur,
  placeholder,
  required,
  disabled,
  error,
  type = 'text',
}: SettingsInputProps): React.ReactElement {
  return (
    <div className={cn(ROW_CLASS)}>
      <div className="flex-1 min-w-0 mr-4">
        <FieldLabel label={label} description={description} />
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <Input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className={cn('w-[200px]', error && 'border-destructive focus-visible:ring-destructive')}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}
