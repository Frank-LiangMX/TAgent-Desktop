/**
 * SettingsSection - 设置区块
 *
 * 标题 / 描述 / 可选 action + 子内容，壳层由 settings-shell 视觉接管。
 */

import * as React from 'react'

import { cn } from '../../lib/utils'
import { SECTION_TITLE_CLASS, SECTION_DESCRIPTION_CLASS } from './SettingsUIConstants'

interface SettingsSectionProps {
  title: React.ReactNode
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: SettingsSectionProps): React.ReactElement {
  return (
    <section className={cn('settings-block', className)}>
      <header className="settings-block-head">
        <div className="settings-block-copy min-w-0">
          <h4 className={SECTION_TITLE_CLASS}>{title}</h4>
          {description ? <p className={SECTION_DESCRIPTION_CLASS}>{description}</p> : null}
        </div>
        {action ? <div className="settings-block-action shrink-0">{action}</div> : null}
      </header>
      <div className="settings-block-body">{children}</div>
    </section>
  )
}
