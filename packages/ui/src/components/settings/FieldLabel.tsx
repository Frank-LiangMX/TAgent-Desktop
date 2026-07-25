/**
 * FieldLabel - 设置项标签 + 可选说明 tooltip
 */

import * as React from 'react'
import { Info } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip'
import { LABEL_CLASS } from './SettingsUIConstants'

interface FieldLabelProps {
  label: React.ReactNode
  description?: string
  icon?: React.ReactNode
}

export function FieldLabel({ label, description, icon }: FieldLabelProps): React.ReactElement {
  return (
    <div className="settings-field flex min-w-0 items-center gap-2.5">
      {icon ? <div className="settings-field-icon shrink-0">{icon}</div> : null}
      <span className={LABEL_CLASS}>{label}</span>
      {description ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="settings-inline-help shrink-0"
              onClick={(e) => e.preventDefault()}
              aria-label="说明"
            >
              <Info className="size-3.5" strokeWidth={1.75} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            <p className="text-xs leading-relaxed">{description}</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
