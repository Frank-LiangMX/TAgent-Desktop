/**
 * SettingsPageIntro - 设置页页头原语
 *
 * 通用 / 外观 / 渠道 / Agent 行为共用页头：左标题 + 描述，可选右侧 action。
 * `.settings-page-intro` 已是 `space-between`，action 自然落在右侧。
 * 视觉由 settings-shell.css `.settings-page-intro` 接管；禁止在此加 kicker / 自绘 chrome。
 */

import * as React from 'react'

interface SettingsPageIntroProps {
  title: React.ReactNode
  description?: React.ReactNode
  /** 右侧操作（如「添加渠道」）；不传则页头与通用 / 外观完全一致 */
  action?: React.ReactNode
}

export function SettingsPageIntro({
  title,
  description,
  action,
}: SettingsPageIntroProps): React.ReactElement {
  return (
    <div className="settings-page-intro">
      <div className="min-w-0">
        <h2 className="settings-page-intro-title">{title}</h2>
        {description ? <p className="settings-page-intro-desc">{description}</p> : null}
      </div>
      {action ? <div className="settings-page-intro-action shrink-0">{action}</div> : null}
    </div>
  )
}
