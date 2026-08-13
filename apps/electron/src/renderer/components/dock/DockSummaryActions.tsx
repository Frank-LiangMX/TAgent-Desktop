/**
 * 兼容占位：旧 HMR / 残留 rightHeaderActionsComponent 仍会引用此名。
 * 真正的「摘要」入口在 WorkspaceDock 标签条右上角 overlay，这里不再渲染，
 * 避免 Dockview react-part 百分比尺寸把按钮塌成 0×0。
 */
import type { IDockviewHeaderActionsProps } from 'dockview'

export function DockSummaryActions(_props: IDockviewHeaderActionsProps): JSX.Element | null {
  return null
}
