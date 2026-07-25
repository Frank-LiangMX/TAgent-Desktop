/**
 * SettingsSecretInput - API Key 专用密码输入控件
 *
 * 内置密码显隐切换，适用于 API Key 等敏感信息输入。
 *
 * 左右结构：左侧 label + ? tooltip，右侧 Input + 显隐按钮。
 */

import { Eye, EyeOff } from 'lucide-react'
import * as React from 'react'

import { Input } from '../input'
import { cn } from '../../lib/utils'
import { FieldLabel } from './FieldLabel'
import { ROW_CLASS } from './SettingsUIConstants'

interface SettingsSecretInputProps {
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
  /** 是否必填 */
  required?: boolean
  /** 是否禁用 */
  disabled?: boolean
}

export function SettingsSecretInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  required,
  disabled,
}: SettingsSecretInputProps): React.ReactElement {
  const [visible, setVisible] = React.useState(false)

  return (
    <div className={cn(ROW_CLASS)}>
      <div className="flex-1 min-w-0 mr-4">
        <FieldLabel label={label} description={description} />
      </div>
      <div className="relative shrink-0">
        <Input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className="w-[200px] pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
          tabIndex={-1}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  )
}
