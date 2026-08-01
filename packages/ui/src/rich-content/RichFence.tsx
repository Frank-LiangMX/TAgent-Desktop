/**
 * RichFence — 富内容围栏分派器（自研）
 *
 * 按围栏语言分派到对应富块组件；非富语言返回 null（上层回落 CodeBlock）。
 * 每个富块包在 RichBlockBoundary 内：渲染失败回退普通代码块。
 *
 * 注意：分派表与 streaming.ts 的 RICH_FENCE_LANGUAGES 保持一致。
 */
import * as React from 'react'

import { MermaidBlock } from '../mermaid-block/MermaidBlock'
import { DataTableView } from './DataTableView'
import { DiffView } from './DiffView'
import { JsonTree } from './JsonTree'
import { MathView } from './MathView'
import { HtmlPreviewView, ImagePreviewView, MarkdownPreviewView, PdfPreviewView } from './PreviewViews'
import { RichBlockBoundary } from './RichFrame'

interface RichFenceProps {
  language: string
  code: string
  /** 回落用的普通代码块（由上层构造，带原始围栏内容） */
  fallback: React.ReactNode
}

function dispatch(language: string, code: string): React.ReactNode {
  switch (language) {
    case 'diff':
      return <DiffView code={code} />
    case 'json':
      return <JsonTree code={code} />
    case 'mermaid':
      return <MermaidBlock code={code} />
    case 'math':
    case 'latex':
      return <MathView code={code} />
    case 'datatable':
      return <DataTableView code={code} />
    case 'spreadsheet':
      return <DataTableView code={code} spreadsheet />
    case 'html-preview':
      return <HtmlPreviewView code={code} />
    case 'image-preview':
      return <ImagePreviewView code={code} />
    case 'pdf-preview':
      return <PdfPreviewView code={code} />
    case 'markdown-preview':
      return <MarkdownPreviewView code={code} />
    default:
      return null
  }
}

export function RichFence({ language, code, fallback }: RichFenceProps): React.ReactElement | null {
  const content = React.useMemo(() => dispatch(language, code), [language, code])
  if (content === null) return null
  return <RichBlockBoundary fallback={fallback}>{content}</RichBlockBoundary>
}
