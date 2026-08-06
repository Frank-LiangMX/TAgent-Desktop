/**
 * RichPreviewPane — Dockview 独立标签预览富块（Mermaid / DataTable / JSON …）。
 * 画布铺满：内容按 pane 高度 stretch，不再套消息内小块尺寸。
 */
import { useAtomValue } from 'jotai'
import type { IDockviewPanelProps } from 'dockview'
import {
  MermaidBlock,
  DataTableView,
  JsonTree,
  DiffView,
  MathView,
  HtmlPreviewView,
  ImagePreviewView,
  PdfPreviewView,
  MarkdownPreviewView,
} from '@tagent/ui'
import { richPreviewRequestAtom } from '../../atoms/rich-preview'

interface RichPreviewPaneParams {
  sessionId: string
}

export function RichPreviewPane(
  props: IDockviewPanelProps<RichPreviewPaneParams>,
): JSX.Element {
  const sessionId = props.params?.sessionId
  const req = useAtomValue(richPreviewRequestAtom)
  const target = req && req.sessionId === sessionId ? req : null

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        等待打开预览…
      </div>
    )
  }

  const body = (() => {
    switch (target.kind) {
      case 'mermaid':
        return <MermaidBlock code={target.code} variant="pane" />
      case 'datatable':
        return <DataTableView code={target.code} variant="pane" />
      case 'spreadsheet':
        return <DataTableView code={target.code} spreadsheet variant="pane" />
      case 'json':
        return <JsonTree code={target.code} variant="pane" />
      case 'diff':
        return <DiffView code={target.code} variant="pane" />
      case 'math':
        return <MathView code={target.code} variant="pane" />
      case 'html-preview':
        return <HtmlPreviewView code={target.code} />
      case 'image-preview':
        return <ImagePreviewView code={target.code} />
      case 'pdf-preview':
        return <PdfPreviewView code={target.code} />
      case 'markdown-preview':
        return <MarkdownPreviewView code={target.code} />
      default:
        return (
          <div className="p-3 text-xs text-muted-foreground">
            暂不支持预览类型：{String(target.kind)}
          </div>
        )
    }
  })()

  return (
    <div className="flex h-full min-h-0 flex-col bg-foreground/[0.015]">
      <div className="rich-preview-pane flex min-h-0 flex-1 flex-col [&_.rich-frame]:my-0 [&_.mermaid-block-wrapper]:my-0">
        {body}
      </div>
    </div>
  )
}
