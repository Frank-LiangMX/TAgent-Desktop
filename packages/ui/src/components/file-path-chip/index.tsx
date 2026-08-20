/**
 * FilePathChip — 文件路径可点击芯片
 *
 * 在 Agent 消息中检测到文件路径时，渲染为可点击的芯片。
 * 通过回调 props 解耦 Electron API 依赖。
 */

import * as React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@tagent/ui'
import {
  getFileName,
  stripLineCol,
  existsCacheKey,
  getFileExistsCache,
  joinBasePath,
  normalizeFilePathSeparators,
  msysPathToWindowsDrivePath,
  fileLangBadgeForName,
  type FileLangBadgeTone,
  type FileReviewContext,
} from '@tagent/shared'
import { cn } from '../../lib/utils'

/** Windows 平台（渲染进程无 process，用 navigator 探测；jsdom 测试默认非 win 不转换） */
const IS_WINDOWS =
  typeof navigator !== 'undefined' &&
  (/win/i.test(navigator.platform || '') ||
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
      ?.toLowerCase()
      .includes('win'))

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带行号后缀） */
  filePath: string
  /** 基础目录路径 */
  basePath?: string
  /** 多个候选基础目录 */
  basePaths?: string[]
  className?: string
  /** 解析文件是否存在（应用层注入 IPC 调用） */
  onResolveFile?: (path: string, bases?: string[]) => Promise<string | null>
  /**
   * 打开文件预览（应用层注入）。
   * options.review：句尾 Files Changed 卡片打开时分屏走「本轮 unified diff 审阅」；
   * 正文文件 chip 不传 review（仍只预览当前文件）。
   */
  onOpenFile?: (filePath: string, options?: { basePaths?: string[]; review?: FileReviewContext }) => void
  /** 获取当前会话 ID（应用层注入） */
  getSessionId?: () => string | null
  /** 文件类型图标组件 */
  FileIcon?: React.ComponentType<{ name: string; isDirectory?: boolean; size?: number }>
  /**
   * 所属 Markdown 仍在流式输出。流式中文件可能尚未落盘，且打字机会反复重挂 chip——
   * 此期间只允许 idle/checking/resolved，**禁止**写入 broken / 负缓存（否则锁 30s「文件不存在」）。
   */
  streaming?: boolean
}

/** MessageResponse 内 FilePathChip 的注入上下文（应用层 Provider 提供 IPC 回调） */
export interface MessageFilePathContextValue {
  basePath?: string
  basePaths?: string[]
  onResolveFile?: (path: string, bases?: string[]) => Promise<string | null>
  /** 见 FilePathChipProps.onOpenFile：options.review 仅句尾 Files Changed 卡片打开时传 */
  onOpenFile?: (filePath: string, options?: { basePaths?: string[]; review?: FileReviewContext }) => void
  getSessionId?: () => string | null
  FileIcon?: React.ComponentType<{ name: string; isDirectory?: boolean; size?: number }>
}

export const MessageFilePathContext = React.createContext<MessageFilePathContextValue>({})
export const MessageFilePathProvider = MessageFilePathContext.Provider

/**
 * 已确认「不存在」的路径（模块级，与 shared 的正缓存对称）。
 *
 * 流式期间同一条消息会反复重挂载。只有正缓存时，每次重挂都从 idle 重查、
 * 重新闪一次灰色的「文件不存在」；有了这份负缓存，结论在 TTL 内保持一致。
 * TTL 取短值：Agent 稍后把文件建出来时要能自愈。
 */
const confirmedMissingAt = new Map<string, number>()
const MISSING_TTL_MS = 30_000
/** 首次未命中不下结论，隔一小会儿再确认一次：文件可能正在写盘 */
const RECHECK_DELAY_MS = 400
/** 流式结束后的加长复查：Agent 写盘常晚于正文出现 chip */
const POST_STREAM_RECHECK_DELAYS_MS = [400, 1200, 2500] as const

/** 测试用：清空负缓存 */
export function clearFilePathMissingCache(): void {
  confirmedMissingAt.clear()
}

const BADGE_TONE_CLASS: Record<FileLangBadgeTone, string> = {
  react: 'bg-[hsl(193_85%_40%/0.18)] text-[hsl(193_85%_32%)]',
  ts: 'bg-[hsl(211_70%_48%/0.16)] text-[hsl(211_70%_38%)]',
  css: 'bg-[hsl(187_65%_40%/0.16)] text-[hsl(187_65%_32%)]',
  md: 'bg-[hsl(25_70%_45%/0.14)] text-[hsl(25_70%_36%)]',
  code: 'bg-[hsl(215_40%_46%/0.14)] text-[hsl(215_40%_36%)]',
  text: 'bg-muted-foreground/10 text-muted-foreground/75',
}

export function FilePathChip({
  filePath,
  basePath,
  basePaths,
  className,
  onResolveFile,
  onOpenFile,
  getSessionId,
  FileIcon,
  streaming = false,
}: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)
  const filename = getFileName(cleanPath)
  // 与 @tagent/shared isAbsoluteFilePath 对齐：Windows 盘符大小写 + 正/反斜杠 + UNC
  const isAbsolute =
    cleanPath.startsWith('/') || cleanPath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)
  const streamingRef = React.useRef(streaming)
  streamingRef.current = streaming

  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])

  const cache = getFileExistsCache()
  const [fileStatus, setFileStatus] = React.useState<
    'idle' | 'checking' | 'resolved' | 'broken'
  >(() => {
    const key = existsCacheKey(cleanPath, candidateBases)
    if (cache.get(key) === true) return 'resolved'
    if (cache.has(key)) cache.delete(key)
    // 流式中忽略负缓存：上一次误判不该锁死本轮
    if (streaming) return 'idle'
    const missingAt = confirmedMissingAt.get(key)
    if (missingAt !== undefined && Date.now() - missingAt < MISSING_TTL_MS) return 'broken'
    return 'idle'
  })

  const displayPath = React.useMemo(() => {
    if (isAbsolute) {
      // MSYS/Git Bash 挂载形态（/f/...）：Windows 上按盘符路径显示，避免 tooltip 出现解析不了的假路径
      if (IS_WINDOWS) {
        const drive = msysPathToWindowsDrivePath(trimmedPath)
        if (drive) return drive
      }
      return trimmedPath
    }
    if (candidateBases.length > 0) {
      // REGRESS-J(J6)：base 可能是 `D:\UnrealTagManager`（反斜杠）、cleanPath 可能带 `/`，
      // 统一经 joinBasePath 归一为 `/`，不再拼出 `D:\UnrealTagManager/Foo/Bar.h` 混分隔符路径。
      const firstSegment = cleanPath.split('/')[0]
      if (firstSegment) {
        for (const base of candidateBases) {
          const baseName = normalizeFilePathSeparators(base)
            .replace(/\/+$/, '')
            .split('/')
            .pop()
          if (baseName === firstSegment) {
            const parentDir = normalizeFilePathSeparators(base).replace(/\/+$/, '').replace(/[^/]*$/, '')
            return joinBasePath(parentDir, cleanPath)
          }
        }
      }
      const base = candidateBases[0]!
      return joinBasePath(base, cleanPath)
    }
    return trimmedPath
  }, [trimmedPath, cleanPath, isAbsolute, candidateBases])

  React.useEffect(() => {
    const el = chipRef.current
    if (!el || !onResolveFile) return

    const key = existsCacheKey(cleanPath, candidateBases)
    if (cache.get(key) === true) {
      setFileStatus('resolved')
      return
    }
    if (cache.has(key)) cache.delete(key)

    // 流式开始：清掉可能过期的负结论，回到可复查态
    if (streaming) {
      confirmedMissingAt.delete(key)
      setFileStatus((prev) => (prev === 'broken' ? 'idle' : prev))
    }

    const missingAt = confirmedMissingAt.get(key)
    const alreadyConfirmedMissing =
      !streaming &&
      missingAt !== undefined &&
      Date.now() - missingAt < MISSING_TTL_MS
    if (alreadyConfirmedMissing) setFileStatus('broken')

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []

    const resolve = (attempt: number): void => {
      const bases = candidateBases.length > 0 ? candidateBases : undefined
      onResolveFile(cleanPath, bases)
        .then((resolved) => {
          if (cancelled) return
          if (resolved !== null) {
            cache.set(key, true)
            confirmedMissingAt.delete(key)
            setFileStatus('resolved')
            return
          }
          cache.delete(key)
          if (streamingRef.current) {
            // 流式中：有限次轻量重试，绝不写负缓存 / broken（等 streaming 结束再裁决）
            setFileStatus((prev) => (prev === 'resolved' ? prev : 'checking'))
            if (attempt < 6) {
              timers.push(setTimeout(() => resolve(attempt + 1), 1000))
            }
            return
          }
          const delays = POST_STREAM_RECHECK_DELAYS_MS
          if (attempt < delays.length && !alreadyConfirmedMissing) {
            timers.push(setTimeout(() => resolve(attempt + 1), delays[attempt]!))
            return
          }
          confirmedMissingAt.set(key, Date.now())
          setFileStatus('broken')
        })
        .catch(() => {})
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        setFileStatus((prev) => (prev === 'idle' ? 'checking' : prev))
        resolve(0)
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => {
      cancelled = true
      observer.disconnect()
      for (const t of timers) clearTimeout(t)
    }
  }, [cleanPath, candidateBases, onResolveFile, getSessionId, cache, streaming])

  // 流式刚结束：再跑最终裁决（流式期间的 miss 都未写负缓存）
  const wasStreamingRef = React.useRef(streaming)
  React.useEffect(() => {
    const ended = wasStreamingRef.current && !streaming
    wasStreamingRef.current = streaming
    if (!ended || !onResolveFile) return

    const key = existsCacheKey(cleanPath, candidateBases)
    if (cache.get(key) === true) {
      setFileStatus('resolved')
      return
    }

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const bases = candidateBases.length > 0 ? candidateBases : undefined

    const finalize = (attempt: number): void => {
      onResolveFile(cleanPath, bases)
        .then((resolved) => {
          if (cancelled) return
          if (resolved !== null) {
            cache.set(key, true)
            confirmedMissingAt.delete(key)
            setFileStatus('resolved')
            return
          }
          const delays = POST_STREAM_RECHECK_DELAYS_MS
          if (attempt < delays.length) {
            timers.push(setTimeout(() => finalize(attempt + 1), delays[attempt]!))
            return
          }
          confirmedMissingAt.set(key, Date.now())
          setFileStatus('broken')
        })
        .catch(() => {})
    }

    setFileStatus((prev) => (prev === 'resolved' ? prev : 'checking'))
    finalize(0)
    return () => {
      cancelled = true
      for (const t of timers) clearTimeout(t)
    }
  }, [streaming, cleanPath, candidateBases, onResolveFile, cache])

  const handleClick = React.useCallback(() => {
    if (!onOpenFile) return
    onOpenFile(cleanPath, {
      basePaths: candidateBases.length > 0 ? candidateBases : undefined,
    })
  }, [onOpenFile, cleanPath, candidateBases])

  const IconComponent = FileIcon
  const langBadge = fileLangBadgeForName(filename)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={chipRef}
          type="button"
          onClick={handleClick}
          data-file-status={fileStatus}
          className={cn(
            // 与正文按基线对齐；align-middle 会把整个 inline-flex 芯片压到正文基线下方。
            // 截断文本额外留出下行字母空间，避免 truncate 的 overflow-hidden 裁掉 g/p/q。
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.9em] font-medium leading-normal',
            'cursor-pointer transition-colors align-baseline not-prose',
            fileStatus === 'broken'
              ? 'border-dashed border-muted-foreground/30 bg-muted/10 text-muted-foreground opacity-60 hover:bg-muted/20 hover:opacity-80'
              : 'border-primary/10 bg-primary/[0.07] text-primary/90 hover:border-primary/15 hover:bg-primary/[0.12] hover:text-primary',
            className
          )}
        >
          {IconComponent ? (
            <span className="inline-flex shrink-0 self-center leading-none opacity-80" aria-hidden>
              <IconComponent name={filename} isDirectory={false} size={12} />
            </span>
          ) : (
            <span
              className={cn(
                'inline-flex size-4 shrink-0 items-center justify-center self-center rounded-[4px] text-[7.5px] font-bold leading-none tracking-tight',
                BADGE_TONE_CLASS[langBadge.tone],
              )}
              aria-hidden
            >
              {langBadge.label}
            </span>
          )}
          <span className="inline-flex min-h-4 max-w-[240px] min-w-0 items-center font-normal leading-normal text-foreground/88">
            <span className="min-w-0 truncate pb-px leading-normal">
              {filename}
              {lineColSuffix}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[400px] break-all">
        {fileStatus === 'broken' ? `文件不存在: ${displayPath}` : displayPath}
      </TooltipContent>
    </Tooltip>
  )
}
