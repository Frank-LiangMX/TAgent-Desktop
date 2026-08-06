/**
 * CodeBlock - 代码块组件
 *
 * 提供语法高亮（Shiki）、语言标签和复制按钮。
 * 用于 react-markdown 的 pre 元素自定义渲染。
 *
 * 流式渲染策略（类 Cherry Studio 方案）：
 * 1. 使用 highlightToTokens 获取结构化 token，逐行渲染为 React 元素
 * 2. 稳定的行级 key → React reconciliation 只更新变化/新增的行
 * 3. 节流 80ms → 避免每个 token 都触发高亮计算
 * 4. 首次挂载异步初始化 → 后续全部同步
 *
 * 结构：
 * ┌─────────────────────────────────────────┐
 * │ [language]                     [📋 复制] │  ← 头部栏
 * ├─────────────────────────────────────────┤
 * │  const foo = 'bar'                      │  ← 高亮代码区（逐行渲染）
 * │  console.log(foo)                       │
 * └─────────────────────────────────────────┘
 */

import { getDisplayName, highlightToTokens, onHighlighterReady } from '@tagent/core'
import * as React from 'react'

import type { HighlightToken, HighlightTokensResult } from '@tagent/core'

/** react-markdown 传入的 <code> 元素 props */
interface CodeElementProps {
  className?: string
  children?: React.ReactNode
}

interface CodeBlockProps {
  /** react-markdown 传入的 <pre> 子元素（内含 <code>） */
  children: React.ReactNode
}

/** 节流间隔（ms）：流式输出时限制高亮更新频率 */
const THROTTLE_MS = 80
const PLAIN_TEXT_LANGUAGES = new Set(['', 'text', 'plaintext', 'txt'])
const LIGHT_SHIKI_THEME = 'github-light'
const DARK_SHIKI_THEME = 'github-dark'

// ===== 工具函数 =====

/** 递归提取 ReactNode 中的纯文本 */
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (React.isValidElement(node)) {
    return extractText((node.props as CodeElementProps).children)
  }
  return ''
}

/** 从 children 中提取语言名和代码文本 */
function extractCodeInfo(children: React.ReactNode): { language: string; code: string } {
  // react-markdown v10 把 <code> 替换成自定义组件后，type 不再是字符串 'code'，
  // 但 pre 的 code child 要么是原生 'code'（v9 及之前），要么是自定义函数/对象组件（v10+）。
  // 通过 type 形态过滤掉意外混入的其他原生 HTML 元素，避免未来 react-markdown
  // 行为变化时静默把第一个 element 误识别为 code
  const codeElement = React.Children.toArray(children).find(
    (child): child is React.ReactElement => {
      if (!React.isValidElement(child)) return false
      const t = (child as React.ReactElement).type
      return t === 'code' || typeof t === 'function' || typeof t === 'object'
    }
  ) as React.ReactElement | undefined

  if (!codeElement) {
    return { language: '', code: extractText(children) }
  }

  const props = codeElement.props as CodeElementProps
  const langMatch = props.className?.match(/language-(\S+)/)

  return {
    language: langMatch?.[1] ?? '',
    code: extractText(props.children),
  }
}

/** Plain-text fences (including ASCII diagrams) should inherit the active theme foreground. */
export function shouldUsePlainTextColors(language: string): boolean {
  return PLAIN_TEXT_LANGUAGES.has(language.toLowerCase())
}

/** 代码高亮主题必须与应用明暗模式一致。 */
export function resolveShikiTheme(isDark: boolean): string {
  return isDark ? DARK_SHIKI_THEME : LIGHT_SHIKI_THEME
}

function getIsDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function useShikiTheme(): string {
  const [theme, setTheme] = React.useState(() => resolveShikiTheme(getIsDarkMode()))

  React.useEffect(() => {
    const updateTheme = (): void => setTheme(resolveShikiTheme(getIsDarkMode()))
    const observer = new MutationObserver(updateTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return theme
}

// ===== SVG 图标路径常量 =====

const ICON_ATTRS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const copyIconPath = (
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
)

const checkIconPath = <polyline points="20 6 9 17 4 12" />

// ===== 逐行渲染子组件 =====

interface CodeLineProps {
  tokens: HighlightToken[]
  /** 该行的原始文本（token 未覆盖部分作为 fallback） */
  rawLine: string
  useTokenColors: boolean
}

/** 单行代码渲染（memo 避免已稳定行重复渲染） */
const CodeLine = React.memo(function CodeLine({
  tokens,
  rawLine,
  useTokenColors,
}: CodeLineProps): React.ReactElement {
  // token 覆盖的字符数
  const tokenLen = tokens.reduce((sum, t) => sum + t.content.length, 0)

  return (
    <span className="line">
      {tokens.map((token, i) => (
        <span key={i} style={useTokenColors && token.color ? { color: token.color } : undefined}>
          {token.content}
        </span>
      ))}
      {/* 流式输出时可能有 token 尚未覆盖的尾部文本 */}
      {tokenLen < rawLine.length && <span>{rawLine.slice(tokenLen)}</span>}
    </span>
  )
})

// ===== 主组件 =====

/**
 * CodeBlock 代码块组件
 *
 * 渲染策略：
 * - 逐行渲染：highlightToTokens → 每行独立 React 元素 + 稳定 key
 * - 节流 80ms：流式输出时控制重计算频率
 * - 异步兜底：首次挂载高亮器未就绪时，异步初始化后触发一次更新
 */
export function CodeBlock({ children }: CodeBlockProps): React.ReactElement {
  const { language, code } = React.useMemo(() => extractCodeInfo(children), [children])
  const [copied, setCopied] = React.useState(false)
  const shikiTheme = useShikiTheme()

  const trimmedCode = code.replace(/\n$/, '')
  const langOrText = language || 'text'
  const usePlainTextColors = shouldUsePlainTextColors(language)
  const rawLines = React.useMemo(() => trimmedCode.split('\n'), [trimmedCode])

  // ---- 节流 token 高亮 ----
  const [tokenResult, setTokenResult] = React.useState<HighlightTokensResult | null>(() =>
    highlightToTokens({ code: trimmedCode, language: langOrText, theme: shikiTheme })
  )
  const pendingCodeRef = React.useRef(trimmedCode)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastUpdateRef = React.useRef(Date.now())

  pendingCodeRef.current = trimmedCode

  React.useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastUpdateRef.current

    const doHighlight = () => {
      const currentCode = pendingCodeRef.current
      const result = highlightToTokens({
        code: currentCode,
        language: langOrText,
        theme: shikiTheme,
      })
      if (result) {
        lastUpdateRef.current = Date.now()
        setTokenResult(result)
      }
    }

    // 同步路径可用时
    const syncResult = highlightToTokens({
      code: trimmedCode,
      language: langOrText,
      theme: shikiTheme,
    })
    if (syncResult) {
      if (elapsed >= THROTTLE_MS) {
        // 距上次更新已超过节流间隔，立即执行
        lastUpdateRef.current = now
        setTokenResult(syncResult)
      } else if (!timerRef.current) {
        // 安排延迟执行，确保最终状态正确
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          doHighlight()
        }, THROTTLE_MS - elapsed)
      }
      return
    }

    // 兜底：高亮器尚未初始化，订阅就绪事件，初始化完成后用同步路径上色
    const unsubscribe = onHighlighterReady(() => doHighlight())
    return () => unsubscribe()
  }, [trimmedCode, langOrText, shikiTheme])

  // 清理节流定时器
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // 复制到剪贴板
  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trimmedCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('[CodeBlock] 复制失败:', error)
    }
  }, [trimmedCode])

  return (
    <div className="code-block-wrapper group/code my-2 overflow-hidden rounded-glass-popover border border-foreground/15 bg-foreground/[0.02]">
      {/* 头部栏：语言标签 + 复制按钮 */}
      <div className="flex h-[34px] items-center justify-between border-b border-foreground/10 bg-foreground/[0.045] px-2 py-1 text-xs text-muted-foreground">
        <span className="select-none font-medium">{getDisplayName(language)}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <svg {...ICON_ATTRS}>{copied ? checkIconPath : copyIconPath}</svg>
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>

      {/* 代码区域：逐行渲染 */}
      <pre
        className="shiki scrollbar-thin m-0 overflow-x-auto bg-foreground/[0.015] p-3.5 text-[0.8125em] leading-[1.55]"
        style={{
          color: usePlainTextColors
            ? 'hsl(var(--foreground))'
            : (tokenResult?.fgColor ?? '#e1e4e8'),
        }}
      >
        <code>
          {rawLines.map((rawLine, i) => (
            <React.Fragment key={i}>
              {i > 0 && '\n'}
              <CodeLine
                tokens={tokenResult?.lines[i] ?? []}
                rawLine={rawLine}
                useTokenColors={!usePlainTextColors}
              />
            </React.Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}
