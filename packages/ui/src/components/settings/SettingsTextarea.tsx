/**
 * SettingsTextarea - 设置多行文本输入控件
 *
 * 左右结构：左侧 label + ? tooltip，右侧 Textarea。
 */

import * as React from 'react'

import { Textarea } from '../textarea'
import { cn } from '../../lib/utils'
import { FieldLabel } from './FieldLabel'
import { ROW_CLASS } from './SettingsUIConstants'

interface SettingsTextareaProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选，hover ? 图标显示 tooltip） */
  description?: string
  /** 输入值 */
  value: string
  /** 变更回调 */
  onChange: (value: string) => void
  /** 占位符 */
  placeholder?: string
  /** 最小高度 */
  minHeight?: number
  /** 是否禁用 */
  disabled?: boolean
  /** 错误信息（可选） */
  error?: string
}

export function SettingsTextarea({
  label,
  description,
  value,
  onChange,
  placeholder,
  minHeight = 96,
  disabled,
  error,
}: SettingsTextareaProps): React.ReactElement {
  return (
    <div className={cn(ROW_CLASS)}>
      <div className="flex-1 min-w-0 mr-4">
        <FieldLabel label={label} description={description} />
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'w-[280px] resize-y',
            error && 'border-destructive focus-visible:ring-destructive'
          )}
          style={{ minHeight }}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}
