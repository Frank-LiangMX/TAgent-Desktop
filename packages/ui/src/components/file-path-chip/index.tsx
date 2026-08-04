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
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'resolved' | 'broken'>(() => {
    const key = existsCacheKey(cleanPath, candidateBases)
    // 只信任「存在」缓存；负缓存可能由写盘竞态 / 路径大小写误判产生，需允许重试
    if (cache.get(key) === true) return 'resolved'
    if (cache.has(key)) cache.delete(key)
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

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        const bases = candidateBases.length > 0 ? candidateBases : undefined
        const sessionId = getSessionId?.()
        onResolveFile(cleanPath, bases)
          .then((resolved) => {
            const exists = resolved !== null
            // 仅缓存「存在」：避免一次性误判（盘符大小写/写盘竞态）永久锁死为 broken
            if (exists) cache.set(key, true)
            else cache.delete(key)
            setFileStatus(exists ? 'resolved' : 'broken')
          })
          .catch(() => {})
      },
      { threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
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
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[12px] font-medium leading-[1.6]',
            'cursor-pointer',
            'align-baseline not-prose',
            'border',
            fileStatus === 'broken'
              ? 'border-dashed border-muted-foreground/30 text-muted-foreground opacity-50 hover:opacity-70 hover:bg-muted/20'
              : 'border-transparent bg-primary/10 text-primary hover:bg-primary/20',
            className
          )}
        >
          {IconComponent ? (
            <IconComponent name={filename} isDirectory={false} size={14} />
          ) : (
            <span className="size-3.5 inline-flex items-center justify-center rounded bg-primary/20 text-primary text-[8px]">
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
