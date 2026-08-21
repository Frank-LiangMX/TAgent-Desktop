/**
 * FilePreviewPane — Dockview 文件预览面板（FileChip / Files Changed 点击 → 右侧分屏）。
 *
 * 内容源：filePreviewRequestAtom（全局单例），pane 按 params.sessionId 匹配自己的会话，
 * 复用同一 pane 时只需 setActive，内容由 atom 驱动自动刷新。
 *
 * 两种模式：
 * - 预览（chip / 附件 / 图片 / PDF / markdown）：渲染分发 img / iframe / MessageResponse / BareCodeView。
 * - 审阅（句尾 Files Changed 卡片带 review 上下文）：本轮 unified diff（红删绿增 + 折叠未改行），
 *   顶栏「审阅 | 当前文件」可切，多文件可在 pane 内切换。before 还原失败走 git HEAD 兜底，
 *   再失败退回当前文件预览。
 */
import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { IDockviewPanelProps } from 'dockview'
import { AppTooltip, MessageResponse } from '@tagent/ui'
import { fileLangBadgeForName } from '@tagent/shared'
import { highlightToTokens, onHighlighterReady } from '@tagent/core'
import { filePreviewRequestAtom } from '../../atoms/file-preview'
import {
  allNewHunks,
  computePatchBlockHunks,
  computeTurnReviewHunks,
  computeUnifiedHunks,
  countDiffHunks,
  DIFF_LARGE_LINE_LIMIT,
  isLargeDiff,
  normalizeFilePath,
  reconstructBefore,
  type DiffHunk,
  type DiffLine,
} from '../../lib/file-review-diff'

interface FilePreviewPaneParams {
  sessionId: string
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; absPath: string; content?: string; dataUrl?: string; mime: string }

/** 审阅模式计算结果 */
type ReviewState = {
  status: 'loading' | 'ready' | 'error'
  hunks: DiffHunk[]
  add: number
  del: number
  /** 顶栏小字提示（对照 HEAD / 文件较大 / 新增文件 / 无差异 等） */
  banner?: string
  /** 无法还原 → 退回当前文件预览（隐藏 审阅|当前 切换） */
  fallbackToCurrent?: boolean
  /** 当前磁盘内容（current 视图 / 全绿用） */
  after?: string
  /** 解析后的绝对路径（外部打开 / 工具条显示） */
  absPath?: string
  message?: string
}

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

const IMAGE_OR_PDF_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'bmp', 'ico', 'avif', 'tiff', 'tif',
])

function isImageOrPdfExt(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_OR_PDF_EXT.has(ext)
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

// ===== 审阅模式：unified diff 视图 =====

function DiffRow({ line }: { line: Exclude<DiffLine, { type: 'collapsed' }> }): JSX.Element {
  if (line.type === 'ctx') {
    return (
      <div className="file-diff__row file-diff__row--ctx">
        <span className="file-diff__gutter">{line.oldNo}</span>
        <span className="file-diff__gutter">{line.newNo}</span>
        <span className="file-diff__marker" aria-hidden> </span>
        <span className="file-diff__text">{line.text}</span>
      </div>
    )
  }
  if (line.type === 'del') {
    return (
      <div className="file-diff__row file-diff__row--del">
        <span className="file-diff__gutter file-diff__gutter--del">{line.oldNo}</span>
        <span className="file-diff__gutter" />
        <span className="file-diff__marker file-diff__marker--del" aria-hidden>-</span>
        <span className="file-diff__text">{line.text}</span>
      </div>
    )
  }
  return (
    <div className="file-diff__row file-diff__row--add">
      <span className="file-diff__gutter" />
      <span className="file-diff__gutter file-diff__gutter--add">{line.newNo}</span>
      <span className="file-diff__marker file-diff__marker--add" aria-hidden>+</span>
      <span className="file-diff__text">{line.text}</span>
    </div>
  )
}

function DiffReviewView({ hunks }: { hunks: DiffHunk[] }): JSX.Element {
  // 折叠行的展开态：key = `${hunkIdx}:${lineIdx}`
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const rows: JSX.Element[] = []
  hunks.forEach((hunk, hi) => {
    hunk.lines.forEach((line, li) => {
      const key = `${hi}:${li}`
      if (line.type === 'collapsed') {
        if (expanded.has(key)) {
          // 展开：就地渲染被折叠的 ctx 行
          line.lines.forEach((c, ci) => {
            if (c.type === 'collapsed') return // 不嵌套
            rows.push(<DiffRow key={`${key}:${ci}`} line={c} />)
          })
        } else {
          rows.push(
            <button
              key={key}
              type="button"
              className="file-diff__collapse"
              onClick={() => toggle(key)}
            >
              <span className="file-diff__collapse-dots" aria-hidden>⋯</span>
              {line.count} 行未改
            </button>,
          )
        }
      } else {
        rows.push(<DiffRow key={key} line={line} />)
      }
    })
  })

  return <div className="file-diff">{rows}</div>
}

// ===== 主组件 =====

export function FilePreviewPane(props: IDockviewPanelProps<FilePreviewPaneParams>): JSX.Element {
  const sessionId = props.params?.sessionId
  const req = useAtomValue(filePreviewRequestAtom)
  // 只响应本会话的请求
  const target = req && req.sessionId === sessionId ? req : null

  const review = target?.review
  const targetPath = target?.path ?? ''
  const isReview = Boolean(
    review &&
      target &&
      !target.pendingAttachment &&
      !target.attachmentLocalPath &&
      !isImageOrPdfExt(targetPath),
  )

  const [state, setState] = useState<PreviewState>({ kind: 'loading' })

  // 审阅模式：当前选中文件路径（可经文件条切换）、审阅|当前 切换、diff 计算结果
  const [activePath, setActivePath] = useState<string>(targetPath)
  const [viewMode, setViewMode] = useState<'review' | 'current'>('review')
  const [reviewState, setReviewState] = useState<ReviewState>({
    status: 'loading',
    hunks: [],
    add: 0,
    del: 0,
  })

  // 新打开的审阅/预览：同步 activePath，并默认回到审阅视图
  useEffect(() => {
    if (!target) return
    setActivePath(target.path)
    setViewMode('review')
  }, [target?.sessionId, targetPath, Boolean(review)])

  // ===== 预览模式：读文件（chip / 附件 / 图片 / PDF / markdown） =====
  useEffect(() => {
    if (!target) {
      setState({ kind: 'loading' })
      return
    }
    // 审阅模式由独立 effect 处理，避免重复 IPC
    if (isReview) {
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
              absPath: abs!,
              dataUrl: `data:${mime};base64,${b64}`,
              mime,
            })
            return
          }
          setState({
            kind: 'ready',
            absPath: abs!,
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
          absPath: abs!,
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
    isReview,
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

  // ===== 审阅模式：读 after + 还原 before + 算 unified diff =====
  useEffect(() => {
    if (!isReview || !target || !review) return
    const sid = target.sessionId
    const bases = target.bases
    let cancelled = false
    setReviewState({ status: 'loading', hunks: [], add: 0, del: 0 })
    void (async () => {
      try {
        const abs = await window.electronAPI.resolveFile({
          sessionId: sid,
          path: activePath,
          bases,
        })
        if (cancelled) return
        if (!abs) {
          setReviewState({
            status: 'error',
            hunks: [],
            add: 0,
            del: 0,
            message: `文件不存在：${activePath}`,
          })
          return
        }
        const file = await window.electronAPI.readWorkspaceFile({ path: abs, sessionId: sid, bases })
        if (cancelled) return
        if (!file || file.content == null) {
          setReviewState({
            status: 'error',
            hunks: [],
            add: 0,
            del: 0,
            message: `无法读取文件：${abs}`,
          })
          return
        }
        const after = file.content
        const patchesForPath = review.patches.filter(
          (p) => normalizeFilePath(p.path) === normalizeFilePath(activePath),
        )
        const replacePatches = patchesForPath.filter((p) => p.kind === 'replace')

        // 有 Edit 补丁：按 old↔new 出 hunk（才能看见删除行）。整文件 LCS 会把
        // 仍留在文件里的旧行收成上下文，红行就没了。
        if (replacePatches.length > 0) {
          const hunks = isLargeDiff(
            replacePatches.map((p) => p.oldText).join('\n'),
            replacePatches.map((p) => p.newText).join('\n'),
          )
            ? computePatchBlockHunks(replacePatches, after)
            : computeTurnReviewHunks(replacePatches, after)
          const c = countDiffHunks(hunks)
          setReviewState({
            status: 'ready',
            hunks,
            add: c.add,
            del: c.del,
            banner: hunks.length === 0 ? '本轮补丁无行级差异' : undefined,
            fallbackToCurrent: hunks.length === 0,
            after,
            absPath: abs!,
          })
          return
        }

        let before = reconstructBefore(after, patchesForPath)
        let banner: string | undefined
        let hunks: DiffHunk[]
        let fallbackToCurrent = false

        // before 为 null（歧义 replace）或 ''（Write）→ git HEAD 兜底
        if (before === null || before === '') {
          const git = await window.electronAPI.readGitHeadFile({ sessionId: sid, path: abs, bases })
          if (cancelled) return
          if (git != null) {
            before = git
            banner = '无法还原本轮补丁，对照 HEAD'
          } else if (before === null) {
            // git 也没有 + 歧义 → 退回当前文件预览
            fallbackToCurrent = true
            banner = '无法还原 diff，显示当前文件'
          } else {
            // Write 且 git 也没有 → 整文件当新增（全绿）
            let green = allNewHunks(after)
            if (green.length > 0 && green[0]!.lines.length > DIFF_LARGE_LINE_LIMIT) {
              green = [{ lines: green[0]!.lines.slice(0, DIFF_LARGE_LINE_LIMIT) }]
              banner = `新增文件较大，仅显示前 ${DIFF_LARGE_LINE_LIMIT} 行`
            } else {
              banner = '新增文件'
            }
            const c = countDiffHunks(green)
            setReviewState({
              status: 'ready',
              hunks: green,
              add: c.add,
              del: c.del,
              banner,
              after,
              absPath: abs!,
            })
            return
          }
        }

        // before 已得（还原 / git）→ 算 hunks（大文件回退补丁块）
        if (isLargeDiff(before!, after)) {
          hunks = computePatchBlockHunks(patchesForPath, after)
          banner = banner ?? '文件较大，按本轮补丁块显示'
        } else {
          hunks = computeUnifiedHunks(before!, after)
          if (hunks.length === 0) {
            // 无差异（含仅尾换行差异被 splitLines 归一）→ 退回当前文件预览
            fallbackToCurrent = true
            banner = banner ?? '无差异，显示当前文件'
          }
        }
        const c = countDiffHunks(hunks)
        setReviewState({
          status: 'ready',
          hunks,
          add: c.add,
          del: c.del,
          banner,
          fallbackToCurrent,
          after,
          absPath: abs!,
        })
      } catch (err) {
        if (!cancelled) {
          setReviewState({
            status: 'error',
            hunks: [],
            add: 0,
            del: 0,
            message: toError(err),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isReview, activePath, target?.sessionId, target?.bases, review])

  // ===== 渲染分发 =====

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/60">
        点击会话中的文件 chip 在此预览
      </div>
    )
  }

  // ----- 审阅模式 -----
  if (isReview && review) {
    const fileName = activePath.split(/[\\/]/).pop() ?? activePath
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    // 顶栏 +N -M：优先文件条统计；没有则用 hunk 计数
    const activeFile = review.files.find(
      (f) => normalizeFilePath(f.path) === normalizeFilePath(activePath),
    )
    // 顶栏 +/- 跟审阅 hunk 走，避免卡片按 old/new 整段行数估的 -35 对不上红行
    const addN = reviewState.status === 'ready' ? reviewState.add : (activeFile?.add ?? 0)
    const delN = reviewState.status === 'ready' ? reviewState.del : (activeFile?.del ?? 0)
    const showToggle = !reviewState.fallbackToCurrent
    const showReview = showToggle && viewMode === 'review' && reviewState.status === 'ready'

    let body: JSX.Element
    if (reviewState.status === 'loading') {
      body = (
        <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
          正在生成审阅 {fileName}…
        </div>
      )
    } else if (reviewState.status === 'error') {
      body = <div className="p-4 text-xs text-destructive">{reviewState.message}</div>
    } else if (showReview && reviewState.hunks.length > 0) {
      body = (
        <div className="h-full min-h-0 overflow-auto">
          {/* key=activePath：切文件时重置折叠展开态 */}
          <DiffReviewView key={activePath} hunks={reviewState.hunks} />
        </div>
      )
    } else {
      // current 视图 / fallbackToCurrent / 无 hunk → BareCodeView 当前文件
      body = (
        <div className="h-full min-h-0 overflow-auto">
          <BareCodeView code={reviewState.after ?? ''} language={EXT_TO_LANG[ext] ?? (ext ? ext : '')} />
        </div>
      )
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* 工具条：路径 + +N -M + 审阅|当前 + 外部打开 */}
        <div className="file-diff-toolbar flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <AppTooltip label={reviewState.absPath ?? activePath} multiline>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
              {reviewState.absPath ?? activePath}
            </span>
          </AppTooltip>
          <span className="file-diff-toolbar__stat shrink-0" aria-label="行变更">
            {addN > 0 ? <span className="file-diff-toolbar__add">+{addN}</span> : null}
            {delN > 0 ? <span className="file-diff-toolbar__del">-{delN}</span> : null}
          </span>
          {showToggle ? (
            <div className="file-diff-seg shrink-0" role="tablist" aria-label="视图切换">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'review'}
                className={`file-diff-seg__btn${viewMode === 'review' ? ' is-active' : ''}`}
                onClick={() => setViewMode('review')}
              >
                审阅
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'current'}
                className={`file-diff-seg__btn${viewMode === 'current' ? ' is-active' : ''}`}
                onClick={() => setViewMode('current')}
              >
                当前文件
              </button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              if (reviewState.absPath) {
                void window.electronAPI.openPath({ sessionId, path: reviewState.absPath })
              }
            }}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            外部打开
          </button>
        </div>
        {reviewState.banner ? (
          <div className="file-diff-banner shrink-0 border-b border-border/40 px-3 py-1 text-[11px] text-muted-foreground/80">
            {reviewState.banner}
          </div>
        ) : null}
        {/* 多文件条 */}
        {review.files.length > 1 ? (
          <div className="file-diff-filebar shrink-0 overflow-x-auto border-b border-border/40">
            {review.files.map((f) => {
              const active = normalizeFilePath(f.path) === normalizeFilePath(activePath)
              const { label, tone } = fileLangBadgeForName(f.name)
              return (
                <button
                  key={f.path}
                  type="button"
                  className={`file-diff-filebar__item${active ? ' is-active' : ''}`}
                  onClick={() => setActivePath(f.path)}
                  title={f.path}
                >
                  <span className={`file-diff-filebar__badge file-diff-filebar__badge--${tone}`} aria-hidden>
                    {label}
                  </span>
                  <span className="file-diff-filebar__name">{f.name}</span>
                  {f.add > 0 ? <span className="file-diff-toolbar__add">+{f.add}</span> : null}
                  {f.del > 0 ? <span className="file-diff-toolbar__del">-{f.del}</span> : null}
                </button>
              )
            })}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    )
  }

  // ----- 预览模式（chip / 附件 / 图片 / PDF / markdown） -----
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
  } else if (ext === 'html' && state.content != null) {
    // HTML 预览：iframe 沙箱渲染（而非源码高亮），样式/图片生效、脚本受限。
    // sandbox 给 allow-same-origin 让本地相对资源解析，去 allow-scripts 防 XSS 执行
    // 影响主应用；用户要看脚本跑起来的效果时仍可右键在新窗口打开原文件。
    body = (
      <iframe
        title={fileName}
        srcDoc={state.content}
        sandbox="allow-same-origin allow-popups allow-forms"
        className="h-full w-full border-0 bg-background"
      />
    )
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
