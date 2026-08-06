/**
 * 富内容渲染（自研）
 *
 * 消息 markdown 围栏语言分派：模型照常输出 markdown，
 * 渲染层把 diff/json/mermaid/math/datatable/spreadsheet/html-preview/
 * image-preview/pdf-preview/markdown-preview 围栏渲染为对应富组件，
 * 未知语言回落普通代码块。
 *
 * 设计文档：docs/plans/2026-07-31-rich-content-rendering.md
 */
export { RichFence } from './RichFence'
export { RichFrame, RichBlockBoundary, RichCopyAction, RichFullscreen } from './RichFrame'
export {
  MessageRichPreviewContext,
  MessageRichPreviewProvider,
  type MessageRichPreviewContextValue,
  type RichPreviewKind,
  type OpenRichInSplitPayload,
} from './rich-preview-context'
export { DataTableView } from './DataTableView'
export { JsonTree } from './JsonTree'
export { DiffView } from './DiffView'
export { MathView } from './MathView'
export {
  RichSourceContext,
  useRichSource,
  parsePreviewSpec,
  HtmlPreviewView,
  ImagePreviewView,
  PdfPreviewView,
  MarkdownPreviewView,
  type RichSourceResolver,
  type RichSourceResult,
} from './PreviewViews'
export {
  RICH_FENCE_LANGUAGES,
  isRichFenceLanguage,
  unclosedFenceLanguage,
} from './streaming'
export { parseUnifiedDiff, countDiffChanges } from './diff-parse'
export { parseDataSpec, normalizeDataSpec, toCsv } from './data-spec'
