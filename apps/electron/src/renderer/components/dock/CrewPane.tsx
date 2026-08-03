/**
 * CrewPane — Dockview 面板适配器，把现有 <KanbanCrewPanel> 塞进 Dockview 面板。
 *
 * 选项 B（面板绑定会话）：每个 crew pane 创建时绑定一个 sessionId（params 带入），
 * 永远显该会话的班组，不受点击哪个会话影响。两会话可各拖一个 crew pane 同屏各看各的。
 *
 * 作 pane 时面板常驻满宽（不传 width/拖宽回调，宽度由 Dockview 分隔条管），
 * open 恒 true，onOpenChange/onPresenceChange 给 noop（关 pane 走 Dockview tab ×）。
 */
import type { IDockviewPanelProps } from 'dockview'
import { KanbanCrewPanel } from '../chat/KanbanCrewPanel'

interface CrewPaneParams {
  sessionId: string
}

export function CrewPane(props: IDockviewPanelProps<CrewPaneParams>): JSX.Element {
  const sessionId = props.params?.sessionId
  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        未关联会话
      </div>
    )
  }
  return (
    <KanbanCrewPanel
      sessionId={sessionId}
      boardId={null}
      open={true}
      onOpenChange={() => {}}
      onPresenceChange={() => {}}
      embedded
    />
  )
}
