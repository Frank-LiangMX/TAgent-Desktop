/**
 * Message - 消息组件原语
 *
 * 包含：
 * - Message — 根容器，`from` 属性区分 user/assistant
 * - MessageHeader — 头像 + 模型名
 * - MessageContent — 内容区域
 * - MessageActions — 操作按钮容器
 * - MessageAction — 单个操作按钮（可选 Tooltip）
 * - MessageResponse — Markdown 渲染（需 onOpenExternal 回调）
 * - UserMessageContent — 可折叠用户消息
 * - MessageAttachments — 附件展示（需 onReadAttachment/onSaveImage 回调）
 * - MessageLoading — 加载动画
 * - MessageStopped — "已停止生成" 状态标记
 * - StreamingIndicator — 流式呼吸脉冲点
 */

import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  CodeBlock,
  ImageLightbox,
  FilePathChip,
  MessageFilePathContext,
} from '@tagent/ui'
import { ChevronDown, ChevronUp, Paperclip, Download, MessageSquareText } from 'lucide-react'
import * as React from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import { isAbsoluteFilePath, isRelativeFilePath } from '@tagent/shared'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import type { HTMLAttributes, ComponentProps, ReactNode } from 'react'

import { cn } from '../../lib/utils'
import { isRichFenceLanguage, RichFence, unclosedFenceLanguage } from '../../rich-content'

// ===== Message 根容器 =====

type MessageRole = 'user' | 'assistant' | 'system'

interface MessageProps extends HTMLAttributes<HTMLDivElement> {
  /** 消息发送者角色 */
  from: MessageRole
}

/** 消息根容器，user 自动右对齐 */
export function Message({ className, from, ...props }: MessageProps): React.ReactElement {
  return (
    <div
      className={cn(
        'group flex w-full flex-col gap-0.5 rounded-[10px] px-2.5 py-2.5',
        from === 'user' ? 'is-user items-end' : 'is-assistant agent-turn-message',
        className
      )}
      {...props}
    />
  )
}

// ===== MessageHeader 头像 + 模型名 =====

interface MessageHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** 模型名称 */
  model?: string
  /** 头像元素 */
  logo?: ReactNode
  /** 消息时间戳 */
  time?: string
}

/** 消息头部（user 时自动隐藏） */
export function MessageHeader({
  model,
  logo,
  time,
  className,
  children,
  ...props
}: MessageHeaderProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 mb-2.5 select-none',
        'group-[.is-user]:hidden',
        className
      )}
      {...props}
    >
      {logo && (
        <div className="flex size-[32px] shrink-0 items-center justify-center overflow-hidden rounded-[25%]">
          {logo}
        </div>
      )}
      <div className="flex flex-col justify-between h-[32px]">
        {model && (
          <span className="text-sm font-semibold text-foreground/60 leading-none">{model}</span>
        )}
        {time && <span className="text-[10px] text-foreground/[0.38] leading-none">{time}</span>}
      </div>
      {children}
    </div>
  )
}

// ===== MessageContent 内容区域 =====

type MessageContentProps = HTMLAttributes<HTMLDivElement>

/**
 * 消息内容区域
 * - user 消息：右对齐
 * - assistant 消息：通栏（模型信息改到脚注 chip，不再左缩进对齐头像）
 */
export function MessageContent({
  children,
  className,
  ...props
}: MessageContentProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex max-w-full min-w-0 flex-col gap-2 overflow-hidden',
        'group-[.is-user]:items-end group-[.is-user]:text-foreground',
        'group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// ===== MessageActions 操作按钮容器 =====

type MessageActionsProps = ComponentProps<'div'>

/** 操作按钮容器（复制、删除等），默认显示淡色，hover 时加深 */
export function MessageActions({
  className,
  children,
  ...props
}: MessageActionsProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 select-none text-muted-foreground/60 hover:text-muted-foreground/90 transition-colors duration-200 animate-in fade-in duration-200 fill-mode-both',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// ===== MessageAction 单个操作按钮 =====

interface MessageActionProps extends ComponentProps<typeof Button> {
  /** 悬停提示文字 */
  tooltip?: string
  /** 无障碍标签 */
  label?: string
}

/** 单个操作按钮（含可选 Tooltip 包装） */
export function MessageAction({
  tooltip,
  children,
  label,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: MessageActionProps): React.ReactElement {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

// ===== MessageLoading 加载动画 =====

export interface MessageLoadingProps {
  className?: string
}

/** 3 个弹跳点加载动画 */
export function MessageLoading({ className }: MessageLoadingProps): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-1.5 py-2', className)}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}

// ===== MessageStopped 已停止状态 =====

export interface MessageStoppedProps {
  className?: string
}

/** "已停止生成" 状态标记 */
export function MessageStopped({ className }: MessageStoppedProps): React.ReactElement {
  return (
    <div
      className={cn('flex items-center gap-1.5 py-2 text-xs text-muted-foreground/50', className)}
    >
      <MessageSquareText className="size-3.5" />
      <span>已停止生成</span>
    </div>
  )
}

// ===== StreamingIndicator 流式指示器 =====

export interface StreamingIndicatorProps {
  className?: string
}

/** 流式呼吸脉冲点 */
export function StreamingIndicator({ className }: StreamingIndicatorProps): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-1.5 py-2', className)}>
      <div className="size-1.5 rounded-full bg-primary/60 animate-pulse" />
    </div>
  )
}

// ===== MessageResponse Markdown 渲染 =====

/** 稳定引用的插件数组，避免 react-markdown 每帧重建插件管线 */
const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

/** 允许 mention:// 协议通过 URL 清洗 */
function mentionUrlTransform(url: string): string {
  if (url.startsWith('mention://')) return url
  return defaultUrlTransform(url)
}

interface MessageResponseProps {
  /** Markdown 内容 */
  children: string
  className?: string
  /** 打开外部链接的回调 */
  onOpenExternal?: (url: string) => void
  /** 基础目录路径，用于解析相对文件路径 */
  basePath?: string
  /** 额外的基础目录候选 */
  basePaths?: string[]
  /** 额外的 remark 插件 */
  remarkPlugins?: Array<() => (tree: unknown) => void>
  /** 是否流式输出中（富内容围栏未闭合时渲染占位，闭合后挂载富组件） */
  streaming?: boolean
}

/** 流式占位：富内容围栏尚未闭合 */
function PendingRichBlock(): React.ReactElement {
  return (
    <div className="my-2 overflow-hidden rounded-glass-popover border border-border/70">
      <div className="flex h-[34px] items-center justify-between bg-foreground/[0.05] px-2 py-1 text-xs text-muted-foreground">
        <span className="select-none font-medium">正在生成内容</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50" />
        内容完成后将自动呈现
      </div>
    </div>
  )
}

/** 使用 react-markdown 渲染 assistant 消息内容 */
export const MessageResponse = React.memo(
  function MessageResponse({
    children,
    className,
    onOpenExternal,
    remarkPlugins,
    streaming = false,
  }: MessageResponseProps): React.ReactElement {
    const mergedRemarkPlugins = React.useMemo(
      () => (remarkPlugins ? [...REMARK_PLUGINS, ...remarkPlugins] : REMARK_PLUGINS),
      [remarkPlugins]
    )

    /** 流式中最后一个未闭合围栏的语言（用于富内容占位判断） */
    const unclosedLanguage = React.useMemo(
      () => (streaming ? unclosedFenceLanguage(children) : null),
      [streaming, children]
    )

    /** 文件 chip 注入上下文（应用层 Provider；未注入 onOpenFile 时不启用识别） */
    const filePathCtx = React.useContext(MessageFilePathContext)

    const components = React.useMemo(
      () => ({
        a: ({
          href,
          children: linkChildren,
          ...linkProps
        }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                {...linkProps}
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                    onOpenExternal?.(href)
                  }
                }}
              >
                {linkChildren}
              </a>
            </TooltipTrigger>
            <TooltipContent className="max-w-[400px] break-all">{href}</TooltipContent>
          </Tooltip>
        ),
        // 拆掉 pre，由 code 组件统一包外壳（CodeBlock / 富内容块）
        pre: ({ children: preChildren }: { children?: React.ReactNode }) => <>{preChildren}</>,
        code: ({ className: codeClassName, children: codeChildren }: { className?: string; children?: React.ReactNode }) => {
          const langMatch = /language-(\S+)/.exec(codeClassName || '')
          if (!langMatch) {
            // 无语言标注的围栏块（```\n...\n```）也没有 language- 类，但它是块级的：
            // mdast→hast 只给块级 code 追加尾换行，据此与行内代码区分。
            // 不能放它落到行内分支——pre 已被拆掉，块级内容会失去 white-space:pre，
            // 目录树 / 表格这类靠空白对齐的内容会挤成一坨。
            if (String(codeChildren ?? '').includes('\n')) {
              return (
                <CodeBlock>
                  <code className={codeClassName}>{codeChildren}</code>
                </CodeBlock>
              )
            }
            // 行内代码：识别为文件路径且应用层注入了打开回调 → 渲染可点击 chip
            const text = String(codeChildren ?? '').trim()
            if (
              filePathCtx.onOpenFile &&
              text &&
              (isAbsoluteFilePath(text) || isRelativeFilePath(text))
            ) {
              return (
                <FilePathChip
                  filePath={text}
                  basePath={filePathCtx.basePath}
                  basePaths={filePathCtx.basePaths}
                  onResolveFile={filePathCtx.onResolveFile}
                  onOpenFile={filePathCtx.onOpenFile}
                  getSessionId={filePathCtx.getSessionId}
                  FileIcon={filePathCtx.FileIcon}
                  streaming={streaming}
                />
              )
            }
            // 行内代码显式样式：等宽 + 极浅底（不依赖 prose 默认，避免反引号伪元素观感）。
            // 技术文本里一段能出现十几个行内代码，底色一重整段就成了色块阵；
            // 等宽字形本身已足够区分，底色只做轻微成组提示。
            return (
              <code
                className={cn(
                  'rounded-[3px] bg-foreground/[0.05] px-[0.25em] py-[0.05em] font-mono text-[0.92em]',
                  codeClassName,
                )}
              >
                {codeChildren}
              </code>
            )
          }

          const language = langMatch[1]!.toLowerCase()
          const code = String(codeChildren ?? '').replace(/\n$/, '')
          const fallback = (
            <CodeBlock>
              <code className={codeClassName}>{codeChildren}</code>
            </CodeBlock>
          )

          if (isRichFenceLanguage(language)) {
            // 流式中围栏未闭合 → 占位；闭合后正常渲染富块
            if (streaming && unclosedLanguage === language) return <PendingRichBlock />
            return (
              <RichFence
                language={language}
                code={code}
                fallback={fallback}
              />
            )
          }
          return fallback
        },
      }),
      [onOpenExternal, streaming, unclosedLanguage, filePathCtx]
    )

    const normalizedContent = React.useMemo(() => {
      return children.replace(/\$\$/g, '$$$$$$').replace(/\$/g, '$')
    }, [children])

    return (
      <div
        className={cn(
          'prose dark:prose-invert max-w-none text-[length:var(--md-preview-font-size,13px)]',
          'prose-p:my-2 prose-p:leading-[1.65] prose-li:leading-[1.65] prose-pre:my-0 prose-hr:my-4',
          'prose-ul:my-2 prose-ol:my-2 prose-li:my-1',
          // 标题不做海报字号，但上间距必须明显大于段间距——分节感全靠这个留白，
          // 否则长回答会糊成一根连续的灰柱子。
          'prose-headings:mt-5 prose-headings:mb-2 prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-foreground',
          'prose-h1:text-[16.5px] prose-h1:leading-snug',
          'prose-h2:text-[15px] prose-h2:leading-snug',
          'prose-h3:text-[13.5px] prose-h3:leading-snug',
          'prose-h4:text-[13px] prose-h4:leading-snug',
          '[&_.code-block-wrapper+.code-block-wrapper]:mt-4',
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          className
        )}
      >
        <Markdown
          remarkPlugins={mergedRemarkPlugins}
          rehypePlugins={REHYPE_PLUGINS}
          urlTransform={mentionUrlTransform}
          components={components}
        >
          {normalizedContent}
        </Markdown>
      </div>
    )
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.onOpenExternal === nextProps.onOpenExternal &&
    prevProps.remarkPlugins === nextProps.remarkPlugins &&
    prevProps.streaming === nextProps.streaming
)

// ===== UserMessageContent 可折叠用户消息 =====

const COLLAPSE_LINE_THRESHOLD = 4

interface UserMessageContentProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * 正文：string 走 markdown；ReactNode 原样渲染（如 @ 芯片）。
   * 折叠高度测量依赖 contentKey（未传则用 string children）。
   */
  children: React.ReactNode
  /** 内容变化时重新测量折叠（ReactNode 时请传文本） */
  contentKey?: string
}

/** 用户消息内容组件，超过 4 行时默认折叠 */
export const UserMessageContent = React.memo(
  function UserMessageContent({
    children,
    contentKey,
    className,
    ...props
  }: UserMessageContentProps): React.ReactElement {
    const [isExpanded, setIsExpanded] = React.useState(false)
    const [shouldCollapse, setShouldCollapse] = React.useState(false)
    const contentRef = React.useRef<HTMLDivElement>(null)
    const measureKey = contentKey ?? (typeof children === 'string' ? children : '')

    React.useEffect(() => {
      if (!contentRef.current) return
      const element = contentRef.current
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
      const maxHeight = lineHeight * COLLAPSE_LINE_THRESHOLD
      setShouldCollapse(element.scrollHeight > maxHeight + 10)
    }, [measureKey])

    const toggleExpand = React.useCallback(() => {
      setIsExpanded((prev) => !prev)
    }, [])

    return (
      <div
        className={cn(
          'agent-user-bubble relative inline-block max-w-full px-3.5 py-2.5',
          // is-collapsed：给底部「展开」预留空间（勿用 pb-6，会被业务侧 padding 覆盖）
          shouldCollapse && !isExpanded && 'is-collapsed',
          shouldCollapse && isExpanded && 'is-expanded',
          className
        )}
        {...props}
      >
        <div
          ref={contentRef}
          className={cn(
            'agent-user-bubble__body overflow-hidden transition-[max-height] duration-200',
            '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
            shouldCollapse && !isExpanded && 'max-h-[6.5em]'
          )}
        >
          {typeof children === 'string' ? (
            <MessageResponse className="prose-p:my-0.5 prose-headings:my-1.5">
              {children}
            </MessageResponse>
          ) : (
            <div className="agent-user-bubble__rich text-[13.5px] leading-[1.55] whitespace-pre-wrap break-words">
              {children}
            </div>
          )}
        </div>
        {shouldCollapse ? (
          <button
            type="button"
            onClick={toggleExpand}
            className={cn(
              'agent-user-bubble__expand',
              !isExpanded && 'agent-user-bubble__expand--overlay',
            )}
            aria-expanded={isExpanded}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="size-3 shrink-0" />
                <span>收起</span>
              </>
            ) : (
              <>
                <ChevronDown className="size-3 shrink-0" />
                <span>展开全部</span>
              </>
            )}
          </button>
        ) : null}
      </div>
    )
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.contentKey === nextProps.contentKey &&
    prevProps.className === nextProps.className,
)

// ===== MessageAttachments 消息附件展示 =====

interface FileAttachment {
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}

interface MessageAttachmentsProps extends HTMLAttributes<HTMLDivElement> {
  attachments: FileAttachment[]
  /** 读取附件内容的回调（返回 base64） */
  onReadAttachment?: (localPath: string) => Promise<string>
  /** 保存图片的回调 */
  onSaveImage?: (localPath: string, filename: string) => void
}

/** 消息附件容器 */
export function MessageAttachments({
  attachments,
  className,
  onReadAttachment,
  onSaveImage,
  ...props
}: MessageAttachmentsProps): React.ReactElement {
  const imageAttachments = attachments.filter((att) => att.mediaType.startsWith('image/'))
  const fileAttachments = attachments.filter((att) => !att.mediaType.startsWith('image/'))
  const isSingleImage = imageAttachments.length === 1 && fileAttachments.length === 0

  return (
    <div className={cn('flex flex-col gap-2 mb-2', className)} {...props}>
      {imageAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {imageAttachments.map((att) => (
            <MessageAttachmentImage
              key={att.id}
              attachment={att}
              isSingle={isSingleImage}
              onReadAttachment={onReadAttachment}
              onSaveImage={onSaveImage}
            />
          ))}
        </div>
      )}
      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {fileAttachments.map((att) => (
            <MessageAttachmentFile key={att.id} attachment={att} />
          ))}
        </div>
      )}
    </div>
  )
}

// ===== MessageAttachmentImage 图片附件展示 =====

interface MessageAttachmentImageProps {
  attachment: FileAttachment
  isSingle?: boolean
  onReadAttachment?: (localPath: string) => Promise<string>
  onSaveImage?: (localPath: string, filename: string) => void
}

function MessageAttachmentImage({
  attachment,
  isSingle = false,
  onReadAttachment,
  onSaveImage,
}: MessageAttachmentImageProps): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)

  React.useEffect(() => {
    if (onReadAttachment) {
      onReadAttachment(attachment.localPath)
        .then((base64) => {
          setImageSrc(`data:${attachment.mediaType};base64,${base64}`)
        })
        .catch((error) => {
          console.error('[MessageAttachmentImage] 读取附件失败:', error)
        })
    }
  }, [attachment.localPath, attachment.mediaType, onReadAttachment])

  const handleSave = React.useCallback((): void => {
    onSaveImage?.(attachment.localPath, attachment.filename)
  }, [attachment.localPath, attachment.filename, onSaveImage])

  if (!imageSrc) {
    return (
      <div
        className={cn(
          'rounded-glass-popover bg-muted/30 animate-pulse shrink-0',
          isSingle ? 'w-[280px] h-[200px]' : 'size-[280px]'
        )}
      />
    )
  }

  const imgElement = isSingle ? (
    <img
      src={imageSrc}
      alt={attachment.filename}
      className="max-w-[500px] max-h-[min(500px,50vh)] rounded-glass-popover object-contain cursor-pointer"
      onClick={() => setLightboxOpen(true)}
    />
  ) : (
    <img
      src={imageSrc}
      alt={attachment.filename}
      className="size-[280px] rounded-glass-popover object-cover shrink-0 cursor-pointer"
      onClick={() => setLightboxOpen(true)}
    />
  )

  return (
    <div className="relative group inline-block">
      {imgElement}
      {onSaveImage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleSave}
              className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
            >
              <Download className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>保存图片</TooltipContent>
        </Tooltip>
      )}
      <ImageLightbox
        src={imageSrc}
        alt={attachment.filename}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onSave={onSaveImage ? handleSave : undefined}
      />
    </div>
  )
}

// ===== MessageAttachmentFile 文件附件展示 =====

interface MessageAttachmentFileProps {
  attachment: FileAttachment
}

/** 文件附件展示（标签样式） */
function MessageAttachmentFile({ attachment }: MessageAttachmentFileProps): React.ReactElement {
  const displayName =
    attachment.filename.length > 20 ? attachment.filename.slice(0, 17) + '...' : attachment.filename

  return (
    <div className="flex items-center gap-2 rounded-glass-popover bg-[#37a5aa]/10 border border-[#37a5aa]/20 px-3 py-1.5 text-[13px] text-[#37a5aa] shrink-0">
      <Paperclip className="size-4" />
      <span>{displayName}</span>
    </div>
  )
}

// ===== BasePathsContext =====

const BasePathsContext = React.createContext<string[] | undefined>(undefined)

/** 提供附加目录候选给所有内嵌的 MessageResponse */
export function BasePathsProvider({
  basePaths,
  children,
}: {
  basePaths?: string[]
  children: React.ReactNode
}): React.ReactElement {
  return <BasePathsContext.Provider value={basePaths}>{children}</BasePathsContext.Provider>
}

// ===== remarkMentions =====

type MentionType = 'file' | 'skill' | 'mcp' | 'session'

interface MdastTextNode {
  type: 'text'
  value: string
}

interface MdastLinkNode {
  type: 'link'
  url: string
  children: MdastNode[]
}

interface MdastBreakNode {
  type: 'break'
}

interface MdastGenericNode {
  type: string
  children?: MdastNode[]
  value?: string
}

type MdastNode = MdastTextNode | MdastLinkNode | MdastBreakNode | MdastGenericNode

interface MdastParent {
  type: string
  children: MdastNode[]
}

function walkMdastText(
  node: MdastParent,
  visitor: (node: MdastTextNode, index: number, parent: MdastParent) => number | void
): void {
  if (!node.children) return
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (child.type === 'text') {
      const result = visitor(child as MdastTextNode, i, node)
      if (typeof result === 'number') i = result - 1
    } else if (child.type !== 'code' && child.type !== 'inlineCode') {
      const asParent = child as MdastParent
      if (asParent.children) walkMdastText(asParent, visitor)
    }
  }
}

/** remark 插件：将 @file: /skill: #mcp: &session: 转为 mention:// link 节点 */
export function remarkMentions(): (tree: unknown) => void {
  return (tree: unknown) => {
    const mdastTree = tree as MdastParent
    walkMdastText(mdastTree, (node, index, parent) => {
      const text = node.value
      const mentionPattern = /@file:(\S+)|\/skill:(\S+)|#mcp:(\S+)|&session:(\S+)/g
      if (!mentionPattern.test(text)) return
      mentionPattern.lastIndex = 0

      const parts: MdastNode[] = []
      let lastIdx = 0
      let m: RegExpExecArray | null

      while ((m = mentionPattern.exec(text)) !== null) {
        if (m.index > lastIdx) {
          parts.push({ type: 'text', value: text.slice(lastIdx, m.index) })
        }
        const mType: MentionType = m[1] ? 'file' : m[2] ? 'skill' : m[3] ? 'mcp' : 'session'
        const mValue = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
        const alreadyEncoded = /%[0-9A-Fa-f]{2}/.test(mValue)
        const safeValue = alreadyEncoded ? mValue : encodeURIComponent(mValue)
        parts.push({
          type: 'link',
          url: `mention://${mType}/${safeValue}`,
          children: [{ type: 'text', value: m[0] }],
        })
        lastIdx = m.index + m[0].length
      }

      if (lastIdx < text.length) {
        parts.push({ type: 'text', value: text.slice(lastIdx) })
      }

      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

// ===== remarkPreserveBreaks =====

/** remark 插件：在 text 节点中将 \n 转为 break 节点（跳过代码块） */
export function remarkPreserveBreaks(): (tree: unknown) => void {
  return (tree: unknown) => {
    const mdastTree = tree as MdastParent
    walkMdastText(mdastTree, (node, index, parent) => {
      const text = node.value
      if (!text.includes('\n')) return

      const lines = text.split('\n')
      const parts: MdastNode[] = []

      for (let i = 0; i < lines.length; i++) {
        if (i > 0) parts.push({ type: 'break' })
        if (lines[i]) parts.push({ type: 'text', value: lines[i] })
      }

      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

/** remark 插件函数签名 */
export type RemarkPluginFn = () => (tree: unknown) => void
