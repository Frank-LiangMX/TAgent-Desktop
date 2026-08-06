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
  getExtension,
  stripLineCol,
  existsCacheKey,
  getFileExistsCache,
  msysPathToWindowsDrivePath,
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
  /** 打开文件预览（应用层注入） */
  onOpenFile?: (filePath: string, options?: { basePaths?: string[] }) => void
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
  onOpenFile?: (filePath: string, options?: { basePaths?: string[] }) => void
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
      const firstSegment = cleanPath.split('/')[0]
      if (firstSegment) {
        for (const base of candidateBases) {
          const baseName = base.endsWith('/')
            ? base.slice(0, -1).split('/').pop()
            : base.split('/').pop()
          if (baseName === firstSegment) {
            const parentDir = base.endsWith('/')
              ? base.slice(0, base.slice(0, -1).lastIndexOf('/'))
              : base.slice(0, base.lastIndexOf('/'))
            return parentDir.endsWith('/')
              ? `${parentDir}${cleanPath}`
              : `${parentDir}/${cleanPath}`
          }
        }
      }
      const base = candidateBases[0]!
      return base.endsWith('/') ? `${base}${cleanPath}` : `${base}/${cleanPath}`
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={chipRef}
          type="button"
          onClick={handleClick}
          data-file-status={fileStatus}
          className={cn(
            'inline-flex items-center gap-1 rounded-[3px] px-[0.25em] py-0 text-[0.92em] font-medium leading-[1.6]',
            'cursor-pointer transition-colors',
            'align-baseline not-prose',
            'border',
            // 常态只用主色文字，底色留给 hover：正文里连续出现多个路径时不再形成彩色块阵
            fileStatus === 'broken'
              ? 'border-dashed border-muted-foreground/30 text-muted-foreground opacity-50 hover:opacity-70 hover:bg-muted/20'
              : 'border-transparent text-primary/90 hover:bg-primary/10 hover:text-primary',
            className
          )}
        >
          {IconComponent ? (
            <span className="inline-flex shrink-0 opacity-80">
              <IconComponent name={filename} isDirectory={false} size={12} />
            </span>
          ) : (
            <span className="size-3 inline-flex items-center justify-center rounded-[2px] bg-primary/15 text-primary text-[8px]">
              {filename.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="truncate max-w-[240px]">
            {filename}
            {lineColSuffix}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[400px] break-all">
        {fileStatus === 'broken' ? `文件不存在: ${displayPath}` : displayPath}
      </TooltipContent>
    </Tooltip>
  )
}
