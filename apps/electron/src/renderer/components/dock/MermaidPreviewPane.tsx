/**
 * MermaidPreviewPane — Dockview 独立标签预览 Mermaid 图。
 * 内容源：richPreviewRequestAtom（同会话复用 pane，atom 驱动刷新）。
 */
import { useAtomValue } from 'jotai'
import type { IDockviewPanelProps } from 'dockview'
import { MermaidBlock } from '@tagent/ui'
import { richPreviewRequestAtom } from '../../atoms/rich-preview'

interface MermaidPreviewPaneParams {
  sessionId: string
}

export function MermaidPreviewPane(
  props: IDockviewPanelProps<MermaidPreviewPaneParams>,
): JSX.Element {
  const sessionId = props.params?.sessionId
  const req = useAtomValue(richPreviewRequestAtom)
  const target =
    req && req.sessionId === sessionId && req.kind === 'mermaid' ? req : null

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        等待打开 Mermaid 图…
      </div>
    )
  }

  return (
    <div className="scrollbar-thin h-full min-h-0 overflow-auto bg-foreground/[0.015] p-3">
      {/* pane 内再套一层块：去掉消息内 my-2 的局促感，用满宽 */}
      <div className="mermaid-preview-pane [&_.mermaid-block-wrapper]:my-0">
        <MermaidBlock code={target.code} variant="pane" />
      </div>
    </div>
  )
}
