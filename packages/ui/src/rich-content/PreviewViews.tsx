/**
 * 预览类富块（自研）：html / image / pdf / markdown
 *
 * 数据源：围栏内 JSON spec `{ "src": "...", "title"?: "..." }`，
 * src 经外部注入的 resolveSource 回调读取（electron 层走主进程鉴权 IPC），
 * 组件本身不感知文件系统。
 *
 * 全部重依赖（react-pdf / pdfjs）动态 import，不进首屏 chunk。
 */
import * as React from 'react'

import { RichFrame } from './RichFrame'

// ===== 数据源解析 =====

export interface RichSourceResult {
  /** 文本内容（html / markdown 用） */
  text?: string
  /** data URL（image / pdf 用） */
  dataUrl?: string
}

export type RichSourceResolver = (src: string) => Promise<RichSourceResult | null>

export interface RichSourceContextValue {
  resolve?: RichSourceResolver
}

export const RichSourceContext = React.createContext<RichSourceContextValue>({})

export function useRichSource(): RichSourceResolver | undefined {
  return React.useContext(RichSourceContext).resolve
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

interface PreviewSpec {
  src: string
  title?: string
  label?: string
}

export function parsePreviewSpec(code: string): PreviewSpec | null {
  try {
    const value = JSON.parse(code.trim()) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const spec = value as Record<string, unknown>
    if (typeof spec.src !== 'string' || !spec.src.trim()) return null
    return {
      src: spec.src,
      title: typeof spec.title === 'string' ? spec.title : undefined,
      label: typeof spec.label === 'string' ? spec.label : undefined,
    }
  } catch {
    return null
  }
}

// ===== 通用读取 hook =====

function useSource(spec: PreviewSpec | null): {
  state: 'loading' | 'ready' | 'error'
  result: RichSourceResult | null
  error: string
} {
  const resolve = useRichSource()
  const [state, setState] = React.useState<{
    state: 'loading' | 'ready' | 'error'
    result: RichSourceResult | null
    error: string
  }>({ state: 'loading', result: null, error: '' })

  React.useEffect(() => {
    let cancelled = false
    if (!spec || !resolve) {
      setState({ state: 'error', result: null, error: '缺少数据源读取能力' })
      return
    }
    setState({ state: 'loading', result: null, error: '' })
    resolve(spec.src)
      .then((result) => {
        if (cancelled) return
        if (!result) setState({ state: 'error', result: null, error: '无法读取该文件' })
        else setState({ state: 'ready', result, error: '' })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ state: 'error', result: null, error: toErrorMessage(error) })
      })
    return () => {
      cancelled = true
    }
  }, [spec, resolve])

  return state
}

function LoadingHint(): React.ReactElement {
  return <p className="rich-preview-hint">正在读取…</p>
}

function ErrorHint({ message }: { message: string }): React.ReactElement {
  return <p className="rich-preview-hint rich-preview-hint--error">{message}</p>
}

// ===== html =====

export function HtmlPreviewView({ code }: { code: string }): React.ReactElement | null {
  const spec = React.useMemo(() => parsePreviewSpec(code), [code])
  const { state, result, error } = useSource(spec)
  if (!spec) return null

  return (
    <RichFrame title={spec.title || 'HTML preview'} copyValue={code} fullscreen fullscreenTitle={spec.title || 'HTML preview'}>
      {state === 'loading' ? (
        <LoadingHint />
      ) : state === 'error' ? (
        <ErrorHint message={error} />
      ) : (
        <iframe
          title={spec.title || 'HTML preview'}
          sandbox=""
          srcDoc={result?.text ?? ''}
          className="h-[320px] w-full border-0 bg-background"
        />
      )}
    </RichFrame>
  )
}

// ===== image =====

export function ImagePreviewView({ code }: { code: string }): React.ReactElement | null {
  const spec = React.useMemo(() => parsePreviewSpec(code), [code])
  const { state, result, error } = useSource(spec)
  if (!spec) return null

  return (
    <RichFrame title={spec.title || spec.label || 'Image'} copyValue={code} fullscreen fullscreenTitle={spec.title || 'Image'}>
      {state === 'loading' ? (
        <LoadingHint />
      ) : state === 'error' ? (
        <ErrorHint message={error} />
      ) : result?.dataUrl ? (
        <img
          src={result.dataUrl}
          alt={spec.title || spec.label || ''}
          className="max-h-[420px] w-auto max-w-full object-contain bg-background p-2"
        />
      ) : (
        <ErrorHint message="该文件不是可预览的图片" />
      )}
    </RichFrame>
  )
}

// ===== pdf =====

export function PdfPreviewView({ code }: { code: string }): React.ReactElement | null {
  const spec = React.useMemo(() => parsePreviewSpec(code), [code])
  const { state, result, error } = useSource(spec)
  const [page, setPage] = React.useState(1)
  const [pageCount, setPageCount] = React.useState(0)
  const [pdf, setPdf] = React.useState<{ Document: React.ComponentType<any>; Page: React.ComponentType<any> } | null>(null)
  const [pdfError, setPdfError] = React.useState('')

  React.useEffect(() => {
    let cancelled = false
    if (state !== 'ready' || !result?.dataUrl) return
    void Promise.all([
      import('react-pdf'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url').then(async (worker) => {
        const { pdfjs } = await import('react-pdf')
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      }),
    ])
      .then(([module]) => {
        if (cancelled) return
        setPdf({ Document: module.Document as React.ComponentType<any>, Page: module.Page as React.ComponentType<any> })
      })
      .catch((e: unknown) => {
        if (!cancelled) setPdfError(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [state, result])

  if (!spec) return null

  let body: React.ReactElement
  if (state === 'loading') body = <LoadingHint />
  else if (state === 'error') body = <ErrorHint message={error} />
  else if (pdfError) body = <ErrorHint message={`PDF 组件加载失败：${pdfError}`} />
  else if (!pdf) body = <LoadingHint />
  else {
    const DocumentComp = pdf.Document
    const PageComp = pdf.Page
    body = (
      <div className="flex flex-col items-center gap-2 p-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((v) => Math.max(1, v - 1))}
            className="rounded px-1.5 py-0.5 transition-colors enabled:hover:bg-foreground/10 enabled:hover:text-foreground disabled:opacity-40"
          >
            ←
          </button>
          <span className="tabular-nums">
            {page} / {pageCount || '…'}
          </span>
          <button
            type="button"
            disabled={page >= pageCount}
            onClick={() => setPage((v) => Math.min(pageCount, v + 1))}
            className="rounded px-1.5 py-0.5 transition-colors enabled:hover:bg-foreground/10 enabled:hover:text-foreground disabled:opacity-40"
          >
            →
          </button>
        </div>
        <DocumentComp
          file={result!.dataUrl!}
          onLoadSuccess={(pdfDoc: { numPages: number }) => {
            setPageCount(pdfDoc.numPages)
            setPage(1)
          }}
        >
          <PageComp pageNumber={page} />
        </DocumentComp>
      </div>
    )
  }

  return (
    <RichFrame title={spec.title || 'PDF'} copyValue={code} fullscreen fullscreenTitle={spec.title || 'PDF'}>
      {body}
    </RichFrame>
  )
}

// ===== markdown =====

export function MarkdownPreviewView({ code }: { code: string }): React.ReactElement | null {
  const spec = React.useMemo(() => parsePreviewSpec(code), [code])
  const { state, result, error } = useSource(spec)
  const [NestedMarkdown, setNestedMarkdown] = React.useState<React.ComponentType<{ children: string }> | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void import('../components/message').then((module) => {
      if (!cancelled) setNestedMarkdown(() => module.MessageResponse as React.ComponentType<{ children: string }>)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!spec) return null

  let body: React.ReactElement
  if (state === 'loading') body = <LoadingHint />
  else if (state === 'error') body = <ErrorHint message={error} />
  else if (!NestedMarkdown) body = <LoadingHint />
  else
    body = (
      <div className="scrollbar-thin max-h-[420px] overflow-auto bg-background p-3">
        <NestedMarkdown>{result?.text ?? ''}</NestedMarkdown>
      </div>
    )

  return (
    <RichFrame title={spec.title || 'Markdown'} copyValue={code} fullscreen fullscreenTitle={spec.title || 'Markdown'}>
      {body}
    </RichFrame>
  )
}
