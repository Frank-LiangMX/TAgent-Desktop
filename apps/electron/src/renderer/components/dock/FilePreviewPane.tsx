/**
 * FilePreviewPane — Dockview 文件预览面板（FileChip 点击 → 右侧分屏）。
 *
 * 内容源：filePreviewRequestAtom（全局单例），pane 按 params.sessionId 匹配自己的会话，
 * 复用同一 pane 时只需 setActive，内容由 atom 驱动自动刷新。
 * 渲染分发：图片 → img；PDF → iframe；markdown → MessageResponse；其余 → BareCodeView
 * （无外壳的行号 + shiki 高亮，对齐 Proma 读文件预览，不套 CodeBlock 外壳）。
 */
import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { IDockviewPanelProps } from 'dockview'
import { AppTooltip, MessageResponse } from '@tagent/ui'
import { highlightToTokens, onHighlighterReady } from '@tagent/core'
import { filePreviewRequestAtom } from '../../atoms/file-preview'

interface FilePreviewPaneParams {
  sessionId: string
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; absPath: string; content?: string; dataUrl?: string; mime: string }

/** 扩展名 → shiki 语言（代码高亮用；覆盖常见语言） */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  cjs: 'javascript', json: 'json', jsonc: 'json', css: 'css', scss: 'scss',
  html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c',
  h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'bash', bash: 'bash',
  zsh: 'bash', ps1: 'powershell', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', sql: 'sql', vue: 'vue', svelte: 'svelte', rb: 'ruby', php: 'php',
}

/**
 * BareCodeView — 无外壳代码预览（对齐 Proma 读文件预览：行号 gutter + shiki 高亮，
 * 无语言标签/复制按钮/边框；那些是消息内嵌代码块的外壳，全屏预览不需要）。
 */
function BareCodeView({ code, language }: { code: string; language: string }): JSX.Element {
  const trimmed = code.replace(/\n$/, '')
  const lang = language || 'text'

  // 跟随明暗主题（与主区一致）
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const theme = isDark ? 'github-dark' : 'github-light'
  const [tokens, setTokens] = useState(() =>
    highlightToTokens({ code: trimmed, language: lang, theme }),
  )

  // 高亮器未就绪时异步初始化后补一次
  useEffect(() => {
    const sync = highlightToTokens({ code: trimmed, language: lang, theme })
    if (sync) {
      setTokens(sync)
      return
    }
    return onHighlighterReady(() => {
      setTokens(highlightToTokens({ code: trimmed, language: lang, theme }))
    })
  }, [trimmed, lang, theme])

  const lines = trimmed.split('\n')

  return (
    <pre
      className="shiki m-0 overflow-x-auto px-0 py-3 text-[0.8125em] leading-[1.55]"
      style={{ color: tokens?.fgColor ?? 'hsl(var(--foreground))' }}
    >
      <code>
        {lines.map((line, i) => {
          const lineTokens = tokens?.lines[i] ?? []
          const tokenLen = lineTokens.reduce((sum, t) => sum + t.content.length, 0)
          return (
            <div key={i} className="flex items-stretch">
              <span
                aria-hidden
                className="w-12 shrink-0 select-none pr-4 text-right text-muted-foreground/40"
              >
                {i + 1}
              </span>
              <span className="whitespace-pre">
                {lineTokens.map((token, ti) => (
                  <span key={ti} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))}
                {tokenLen < line.length && <span>{line.slice(tokenLen)}</span>}
              </span>
            </div>
          )
        })}
      </code>
    </pre>
  )
}

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** base64 → UTF-8 文本（renderer 侧解码附件正文） */
function base64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/** 由文件名推断 MIME（附件预览兜底） */
function mimeFromFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function FilePreviewPane(props: IDockviewPanelProps<FilePreviewPaneParams>): JSX.Element {
  const sessionId = props.params?.sessionId
  const req = useAtomValue(filePreviewRequestAtom)
  // 只响应本会话的请求
  const target = req && req.sessionId === sessionId ? req : null

  const [state, setState] = useState<PreviewState>({ kind: 'loading' })

  useEffect(() => {
    if (!target) {
      setState({ kind: 'loading' })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    void (async () => {
      try {
        // 输入框待发附件：内存 base64，尚未写入 ~/.tagent/attachments/
        if (target.pendingAttachment) {
          const { filename, mediaType, data } = target.pendingAttachment
          const mime = mediaType || mimeFromFilename(filename)
          if (mime.startsWith('image/') || mime === 'application/pdf') {
            setState({
              kind: 'ready',
              absPath: `待发：${filename}`,
              dataUrl: `data:${mime};base64,${data}`,
              mime,
            })
            return
          }
          setState({
            kind: 'ready',
            absPath: `待发：${filename}`,
            content: base64ToUtf8(data),
            mime,
          })
          return
        }

        // 会话附件：~/.tagent/attachments/ 下，不走工作区 resolve/read
        if (target.attachmentLocalPath) {
          const [b64, abs] = await Promise.all([
            window.electronAPI.readAttachment(target.attachmentLocalPath),
            window.electronAPI.resolveAttachmentPath(target.attachmentLocalPath),
          ])
          if (cancelled) return
          const fileName = target.title ?? target.path
          const mime = target.attachmentMediaType ?? mimeFromFilename(fileName)
          if (mime.startsWith('image/') || mime === 'application/pdf') {
            setState({
              kind: 'ready',
              absPath: abs,
              dataUrl: `data:${mime};base64,${b64}`,
              mime,
            })
            return
          }
          setState({
            kind: 'ready',
            absPath: abs,
            content: base64ToUtf8(b64),
            mime,
          })
          return
        }

        const abs = await window.electronAPI.resolveFile({
          sessionId: target.sessionId,
          path: target.path,
          bases: target.bases,
        })
        if (cancelled) return
        if (!abs) {
          setState({ kind: 'error', message: `文件不存在：${target.path}` })
          return
        }
        // 带上 sessionId + bases：允许根含会话工作区（hidden / 草稿 bases），避免「解析成功却读失败」
        const file = await window.electronAPI.readWorkspaceFile({
          path: abs,
          sessionId: target.sessionId,
          bases: target.bases,
        })
        if (cancelled) return
        if (!file) {
          setState({
            kind: 'error',
            message: `无法读取文件：${abs}（文件不存在、超过 10MB，或无读权限）`,
          })
          return
        }
        setState({
          kind: 'ready',
          absPath: abs,
          content: file.content,
          dataUrl: file.dataUrl,
          mime: file.mime ?? 'application/octet-stream',
        })
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: toError(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    target?.sessionId,
    target?.path,
    target?.bases,
    target?.attachmentLocalPath,
    target?.attachmentMediaType,
    target?.pendingAttachment?.filename,
    target?.pendingAttachment?.mediaType,
    target?.pendingAttachment?.data,
    target?.title,
  ])

  // ===== 渲染分发 =====

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/60">
        点击会话中的文件 chip 在此预览
      </div>
    )
  }

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
        正在读取 {target.path}…
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="p-4 text-xs text-destructive">{state.message}</div>
    )
  }

  const mime = state.mime
  const fileName = target.title ?? target.path.split(/[\\/]/).pop() ?? target.path
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''

  // 内容体（按类型分发）
  let body: JSX.Element
  if (mime.startsWith('image/') && state.dataUrl) {
    body = (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted/10 p-4">
        <img src={state.dataUrl} alt={fileName} className="max-h-full max-w-full object-contain" />
      </div>
    )
  } else if (mime === 'application/pdf' && state.dataUrl) {
    body = <iframe title={fileName} src={state.dataUrl} className="h-full w-full border-0 bg-background" />
  } else if ((ext === 'md' || ext === 'markdown') && state.content != null) {
    body = (
      <div className="h-full overflow-auto p-4">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <MessageResponse>{state.content}</MessageResponse>
        </div>
      </div>
    )
  } else {
    // 代码 / 纯文本：无外壳预览（行号 + shiki 高亮）
    body = (
      <div className="h-full min-h-0 overflow-auto">
        <BareCodeView
          code={state.content ?? ''}
          language={EXT_TO_LANG[ext] ?? (ext ? ext : '')}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具条：完整路径 + 外部打开（系统默认程序） */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <AppTooltip label={state.absPath} multiline>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
            {state.absPath}
          </span>
        </AppTooltip>
        {!target.pendingAttachment ? (
          <button
            type="button"
            onClick={() => {
              void window.electronAPI.openPath({ sessionId, path: state.absPath })
            }}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            外部打开
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  )
}
