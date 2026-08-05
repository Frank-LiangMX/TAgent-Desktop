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
} from '@tagent/shared'
import { cn } from '../../lib/utils'

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
}: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)
  const filename = getFileName(cleanPath)
  // 与 @tagent/shared isAbsoluteFilePath 对齐：Windows 盘符大小写 + 正/反斜杠 + UNC
  const isAbsolute =
    cleanPath.startsWith('/') || cleanPath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)

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
    const missingAt = confirmedMissingAt.get(key)
    // 沿用上次已确认的结论，重挂载时不再从「正常」跳到「不存在」
    if (missingAt !== undefined && Date.now() - missingAt < MISSING_TTL_MS) return 'broken'
    return 'idle'
  })

  const displayPath = React.useMemo(() => {
    if (isAbsolute) return trimmedPath
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

    const missingAt = confirmedMissingAt.get(key)
    const alreadyConfirmedMissing =
      missingAt !== undefined && Date.now() - missingAt < MISSING_TTL_MS
    if (alreadyConfirmedMissing) setFileStatus('broken')

    let cancelled = false
    let recheckTimer: ReturnType<typeof setTimeout> | undefined

    const resolve = (isRecheck: boolean): void => {
      const bases = candidateBases.length > 0 ? candidateBases : undefined
      onResolveFile(cleanPath, bases)
        .then((resolved) => {
          if (cancelled) return
          if (resolved !== null) {
            // 仅缓存「存在」：避免一次性误判（盘符大小写/写盘竞态）永久锁死为 broken
            cache.set(key, true)
            confirmedMissingAt.delete(key)
            setFileStatus('resolved')
            return
          }
          cache.delete(key)
          // 首次未命中先不显示 broken；已确认过的路径直接沿用结论，不必再等一轮
          if (!isRecheck && !alreadyConfirmedMissing) {
            recheckTimer = setTimeout(() => resolve(true), RECHECK_DELAY_MS)
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
        resolve(false)
      },
      { threshold: 0 }
    )
    observer.observe(el)
    return () => {
      cancelled = true
      observer.disconnect()
      if (recheckTimer) clearTimeout(recheckTimer)
    }
  }, [cleanPath, candidateBases, onResolveFile, getSessionId, cache])

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
