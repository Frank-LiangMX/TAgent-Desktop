/**
 * MemoryMonitorPanel — 记忆页（rail-only · 单画面纵深）
 *
 * 层次：scene 透底 → 安静主场 → 待审抬升岛 → L0–L5 层带叠放（就地展开）。
 * 禁止左列表右详情（那是 sidebar 嵌进主区）。
 */

import * as React from 'react'

import { useAtomValue } from 'jotai'
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  FolderTree,
  GitBranch,
  History,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles,
  User,
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Tooltip, TooltipContent, TooltipTrigger } from '@tagent/ui'
import { topLevelModeAtom } from '@/atoms/app-mode'
import { Panel } from '@/components/app-shell/Panel'
import { detectIsMac, detectIsWindows } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { MemoryGraph } from './MemoryGraph'
import { StageQueueCard } from './StageQueueCard'

/** L4 摘要：紧凑 markdown，配合 line-clamp */
const SESSION_MD_COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block">{children}</span>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} className="text-primary underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[10px]">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block overflow-hidden font-mono text-[10px]">{children}</span>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block">{children}</span>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block">{children}</span>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block before:mr-1 before:content-['·']">{children}</span>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground/80">{children}</strong>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block font-semibold text-foreground/85">{children}</span>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block font-semibold text-foreground/85">{children}</span>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <span className="m-0 block font-semibold text-foreground/85">{children}</span>
  ),
}

// ===== 类型 =====

interface MemoryLayerStats {
  l0: { exists: boolean; lines: number; lastUpdated: number | null }
  l1: { exists: boolean; lines: number; lastUpdated: number | null }
  l2: { exists: boolean; lines: number; lastUpdated: number | null }
  l3: { rawCount: number; rulesCount: number; lastUpdated: number | null }
  l4: { sessions: number; oldestDate: number | null; newestDate: number | null }
  l5: { exists: boolean; lines: number; lastUpdated: number | null }
}

type LayerKey = 'l0' | 'l1' | 'l2' | 'l3' | 'l4' | 'l5'
type SurfaceMode = 'strata' | 'graph'

interface LayerConfig {
  key: LayerKey
  label: string
  code: string
  hint: string
  depth: string
  icon: React.ReactNode
  getCount: (stats: MemoryLayerStats) => number
  getUpdated: (stats: MemoryLayerStats) => number | null
}

interface SessionItem {
  id: number
  title: string
  summary: string
  created_at: number
}

// ===== 层配置：从上到下 = 近景 → 远景 =====

const LAYERS: LayerConfig[] = [
  {
    key: 'l0',
    label: '用户画像',
    code: 'L0',
    hint: '对话中自动学习的用户偏好与习惯',
    depth: '近 · 每次会话都会带到前台',
    icon: <User className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l0.exists ? s.l0.lines : 0),
    getUpdated: (s) => s.l0.lastUpdated,
  },
  {
    key: 'l1',
    label: '项目画像',
    code: 'L1',
    hint: '当前项目上下文、约定与边界',
    depth: '近 · 绑定工作区',
    icon: <FolderTree className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l1.exists ? s.l1.lines : 0),
    getUpdated: (s) => s.l1.lastUpdated,
  },
  {
    key: 'l2',
    label: '稳定事实',
    code: 'L2',
    hint: '跨会话保留、较少变动的事实',
    depth: '中 · 写入有冷却',
    icon: <Lightbulb className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l2.exists ? s.l2.lines : 0),
    getUpdated: (s) => s.l2.lastUpdated,
  },
  {
    key: 'l3',
    label: '纠错记录',
    code: 'L3',
    hint: '用户纠正后沉淀的规则',
    depth: '中 · 优先于默认推断',
    icon: <AlertTriangle className="size-4" strokeWidth={1.75} />,
    getCount: (s) => s.l3.rawCount,
    getUpdated: (s) => s.l3.lastUpdated,
  },
  {
    key: 'l4',
    label: '历史会话',
    code: 'L4',
    hint: '会话日志 · FTS5 · 自动合并归档',
    depth: '远 · 原始痕迹',
    icon: <History className="size-4" strokeWidth={1.75} />,
    getCount: (s) => s.l4.sessions,
    getUpdated: (s) => s.l4.newestDate,
  },
  {
    key: 'l5',
    label: '提炼洞察',
    code: 'L5',
    hint: 'Reflect 夜间从会话中提炼',
    depth: '远 · 压缩后的远景',
    icon: <Sparkles className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l5.exists ? s.l5.lines : 0),
    getUpdated: (s) => s.l5.lastUpdated,
  },
]

function formatRelativeTime(ts: number | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) return '刚刚'
  if (hours < 24) return `${hours}h 前`
  return `${Math.floor(hours / 24)}d 前`
}

function formatSessionStamp(ts: number): string {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  if (ts >= startOfToday.getTime()) {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

// ===== 主组件 =====

export function MemoryMonitorPanel(): React.ReactElement {
  const topLevelMode = useAtomValue(topLevelModeAtom)
  const mode = topLevelMode === 'ta' ? 'ta' : 'general'
  const isMac = React.useMemo(() => detectIsMac(), [])
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  const [stats, setStats] = React.useState<MemoryLayerStats | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [surface, setSurface] = React.useState<SurfaceMode>('strata')
  const [openLayer, setOpenLayer] = React.useState<LayerKey | null>(null)
  const [pendingOpen, setPendingOpen] = React.useState(false)
  const [pendingCount, setPendingCount] = React.useState(0)
  const [sessions, setSessions] = React.useState<SessionItem[]>([])
  const [sessionsLoading, setSessionsLoading] = React.useState(false)

  const loadStats = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await window.electronAPI.initMemoryLayers()
      const [s, pending] = await Promise.all([
        window.electronAPI.getMemoryStats(mode),
        window.electronAPI.getStageQueue(mode).catch(() => []),
      ])
      setStats(s)
      setPendingCount(pending.length)
      if (pending.length === 0) setPendingOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode])

  const loadSessions = React.useCallback(async () => {
    setSessionsLoading(true)
    try {
      await window.electronAPI.initMemoryLayers()
      const recent = await window.electronAPI.listRecentMemorySessions(mode, 16)
      setSessions(
        (recent as SessionItem[]).map((s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          created_at: s.created_at,
        }))
      )
    } catch {
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }, [mode])

  React.useEffect(() => {
    void loadStats()
  }, [loadStats])

  React.useEffect(() => {
    if (openLayer === 'l4' && surface === 'strata') void loadSessions()
  }, [openLayer, surface, loadSessions])

  const totalMemories = stats ? LAYERS.reduce((sum, l) => sum + l.getCount(stats), 0) : 0
  const filledLayers = stats ? LAYERS.filter((l) => l.getCount(stats) > 0).length : 0

  // 统一栅格：图标列 | 正文 | 右侧指标（数字右对齐同宽）
  const rowGrid = 'grid w-full grid-cols-[36px_minmax(0,1fr)_72px] items-center gap-x-3'

  const toolbar = (
    <div className="flex shrink-0 items-center gap-0.5 titlebar-no-drag">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setSurface((m) => (m === 'graph' ? 'strata' : 'graph'))}
            className={cn(
              'inline-flex size-9 items-center justify-center rounded-full',
              'text-foreground/60 hover:text-foreground',
              surface === 'graph' && 'text-blue-500 dark:text-blue-400'
            )}
            aria-label={surface === 'graph' ? '退出图谱' : '记忆图谱'}
            aria-pressed={surface === 'graph'}
          >
            <GitBranch className="size-4" strokeWidth={1.75} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {surface === 'graph' ? '退出图谱' : '记忆图谱'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              void loadStats()
              if (openLayer === 'l4') void loadSessions()
            }}
            className="inline-flex size-9 items-center justify-center rounded-full text-foreground/60 hover:text-foreground"
            aria-label="刷新"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">刷新</TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <Panel variant="grow" className="content-glass relative flex min-h-0 flex-col overflow-hidden">
      {/* 仅保留拖拽安全区；操作钮跟正文同列，不挂在窗控旁 */}
      <div className={cn('relative shrink-0', isMac ? 'h-3' : 'h-8', isWindows && 'pr-[134px]')}>
        <div
          className="absolute inset-0 titlebar-drag-region"
          style={isWindows ? { right: 126 } : undefined}
          aria-hidden
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
            <AlertTriangle className="size-5 md-text-variant" strokeWidth={1.5} />
            <p className="md-text-variant text-[12px]">{error}</p>
            <button
              type="button"
              onClick={() => void loadStats()}
              className="text-[12px] font-medium text-primary hover:underline"
            >
              重试
            </button>
          </div>
        ) : surface === 'graph' ? (
          <div className="flex h-full min-h-0 flex-col px-6 pb-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="md-text-faint text-[11px] font-medium tracking-[0.04em]">记忆图谱</p>
              {toolbar}
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-glass-modal">
              <MemoryGraph mode={mode} />
            </div>
          </div>
        ) : loading && !stats ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin md-text-faint" />
          </div>
        ) : (
          <div className="h-full overflow-y-auto scrollbar-thin">
            <div className="px-6 pb-10">
              {/* 标题行：左文案 + 右操作，与下方层列同宽对齐 */}
              <div className="flex items-start justify-between gap-3 pb-7">
                <div className="min-w-0">
                  <p className="md-text-faint text-[11px] font-medium tracking-[0.04em]">记忆</p>
                  <div className="mt-3 flex items-end gap-3">
                    <span className="md-text text-[44px] font-semibold leading-none tracking-tight tabular-nums">
                      {totalMemories}
                    </span>
                    <span className="md-text-variant mb-1.5 text-[13px]">条沉淀</span>
                  </div>
                  <p className="md-text-variant mt-3 text-[12px] leading-relaxed">
                    {filledLayers}/{LAYERS.length} 层有内容
                    {stats?.l4.sessions ? ` · ${stats.l4.sessions} 段会话` : ''}
                    {' · '}
                    Reflect {formatRelativeTime(stats?.l5.lastUpdated ?? null)}
                  </p>
                </div>
                {toolbar}
              </div>

              {/* 抬升岛：待审（有队列才出现）——与层行同栅格起点 */}
              {pendingCount > 0 ? (
                <section className="mb-7">
                  <button
                    type="button"
                    onClick={() => setPendingOpen((o) => !o)}
                    className={cn(
                      rowGrid,
                      'rounded-glass-popover bg-amber-500/[0.08] py-3 text-left titlebar-no-drag ui-pressable',
                      'hover:bg-amber-500/[0.11]'
                    )}
                  >
                    <span className="flex size-9 items-center justify-center justify-self-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                      <Bell className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0">
                      <span className="md-text block text-[13px] font-medium">
                        {pendingCount} 条待你确认
                      </span>
                      <span className="md-text-variant mt-0.5 block text-[11px]">
                        写入门控暂存 · 接受后进入对应层
                      </span>
                    </span>
                    <span className="flex justify-end">
                      <ChevronDown
                        className={cn(
                          'size-4 text-foreground/45 transition-transform duration-200',
                          pendingOpen && 'rotate-180'
                        )}
                        strokeWidth={1.75}
                      />
                    </span>
                  </button>
                  {pendingOpen ? (
                    <div className={cn(rowGrid, 'pb-3 pt-1')}>
                      <span aria-hidden />
                      <div className="col-span-2 min-w-0">
                        <StageQueueCard
                          mode={mode}
                          onChanged={() => {
                            void loadStats()
                          }}
                        />
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* 场：L0→L5 统一栅格，无递进缩进 */}
              <section aria-label="记忆层级">
                <div className={cn(rowGrid, 'mb-2')}>
                  <span aria-hidden />
                  <h2 className="md-text text-[13px] font-semibold tracking-tight">层级</h2>
                  <p className="md-text-faint text-right text-[10px] tracking-[0.06em]">近→远</p>
                </div>

                <ul className="flex flex-col">
                  {LAYERS.map((layer) => {
                    const count = stats ? layer.getCount(stats) : 0
                    const updated = stats ? layer.getUpdated(stats) : null
                    const open = openLayer === layer.key

                    return (
                      <li
                        key={layer.key}
                        className="border-b border-foreground/[0.06] last:border-b-0"
                      >
                        <button
                          type="button"
                          onClick={() => setOpenLayer(open ? null : layer.key)}
                          aria-expanded={open}
                          className={cn(rowGrid, 'py-3.5 text-left titlebar-no-drag')}
                        >
                          <span
                            className={cn(
                              'flex size-9 items-center justify-center justify-self-center rounded-full',
                              'bg-foreground/[0.04] md-text-variant'
                            )}
                          >
                            {layer.icon}
                          </span>

                          <span className="min-w-0">
                            <span className="flex items-baseline gap-2">
                              <span
                                className={cn(
                                  'text-[14px] font-medium tracking-tight',
                                  open ? 'md-text' : 'md-text'
                                )}
                              >
                                {layer.label}
                              </span>
                              <span className="md-text-faint text-[10px] font-medium tracking-[0.08em]">
                                {layer.code}
                              </span>
                            </span>
                            {/* 展开时副文案换成 hint，不另开一块面板 */}
                            <span className="md-text-faint mt-0.5 block truncate text-[11px]">
                              {open ? layer.hint : layer.depth}
                            </span>
                          </span>

                          <span className="flex flex-col items-end gap-0.5 justify-self-end">
                            <span className="md-text w-full text-right text-[15px] font-semibold tabular-nums leading-none">
                              {count}
                            </span>
                            <span className="md-text-faint w-full text-right text-[10px] tabular-nums">
                              {count === 0 ? '空' : formatRelativeTime(updated)}
                            </span>
                          </span>
                        </button>

                        {open ? (
                          <div className={cn(rowGrid, 'pb-4 pt-0')}>
                            <span aria-hidden />
                            <div className="col-span-2 min-w-0">
                              <LayerBody
                                mode={mode}
                                layer={layer}
                                stats={stats}
                                sessions={sessions}
                                sessionsLoading={sessionsLoading}
                              />
                            </div>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </section>
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}

// ===== 层展开体：读真实内容 + 限高滚动（主题 scrollbar-thin）=====

/** 层内容区：不整页平铺，限高后主题细滚动条 */
const LAYER_SCROLL =
  'max-h-[min(280px,42vh)] overflow-y-auto overflow-x-hidden scrollbar-thin pr-1'

const LAYER_MD_KEY: Record<Exclude<LayerKey, 'l3' | 'l4'>, 'L0' | 'L1' | 'L2' | 'L5'> = {
  l0: 'L0',
  l1: 'L1',
  l2: 'L2',
  l5: 'L5',
}

function LayerBody({
  mode,
  layer,
  stats,
  sessions,
  sessionsLoading,
}: {
  mode: 'general' | 'ta'
  layer: LayerConfig
  stats: MemoryLayerStats | null
  sessions: SessionItem[]
  sessionsLoading: boolean
}): React.ReactElement {
  const count = stats ? layer.getCount(stats) : 0

  if (count === 0) {
    return (
      <p className="md-text-faint text-[11px] leading-relaxed">
        这一层还是空的，对话里满足门控后会自动写入。
      </p>
    )
  }

  if (layer.key === 'l4') {
    return (
      <div>
        {stats?.l4.oldestDate && stats.l4.newestDate ? (
          <p className="md-text-faint mb-2 text-[11px] tabular-nums">
            {new Date(stats.l4.oldestDate).toLocaleDateString('zh-CN')}
            {' → '}
            {new Date(stats.l4.newestDate).toLocaleDateString('zh-CN')}
          </p>
        ) : null}
        <div className={LAYER_SCROLL}>
          <L4SessionList loading={sessionsLoading} sessions={sessions} />
        </div>
      </div>
    )
  }

  if (layer.key === 'l3') {
    return <LayerCorrectionsBody mode={mode} stats={stats} />
  }

  return <LayerMdBody mode={mode} layerKey={LAYER_MD_KEY[layer.key]} />
}

function LayerMdBody({
  mode,
  layerKey,
}: {
  mode: 'general' | 'ta'
  layerKey: 'L0' | 'L1' | 'L2' | 'L5'
}): React.ReactElement {
  const [content, setContent] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.electronAPI
      .getMemoryMdContent(mode, layerKey)
      .then((md) => {
        if (cancelled) return
        setContent(md)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setContent(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode, layerKey])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1">
        <Loader2 className="size-3.5 animate-spin md-text-faint" />
        <span className="md-text-faint text-[11px]">加载内容…</span>
      </div>
    )
  }

  if (error) {
    return <p className="md-text-faint text-[11px] text-red-500">{error}</p>
  }

  const body = (content ?? '').trim()
  if (!body) {
    return <p className="md-text-faint text-[11px]">文件为空或仅有标题</p>
  }

  return (
    <div className={LAYER_SCROLL}>
      <div className="md-text-variant text-[12px] leading-relaxed break-words [&>*:first-child]:mt-0">
        <Markdown remarkPlugins={[remarkGfm]} components={SESSION_MD_COMPONENTS}>
          {body}
        </Markdown>
      </div>
    </div>
  )
}

function LayerCorrectionsBody({
  mode,
  stats,
}: {
  mode: 'general' | 'ta'
  stats: MemoryLayerStats | null
}): React.ReactElement {
  const [items, setItems] = React.useState<
    Array<{ timestamp: number; correction: string; context: string }>
  >([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.electronAPI
      .getMemoryCorrections(mode, 40)
      .then((list) => {
        if (!cancelled) setItems(list)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1">
        <Loader2 className="size-3.5 animate-spin md-text-faint" />
        <span className="md-text-faint text-[11px]">加载纠错…</span>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <p className="md-text-faint text-[11px] leading-relaxed">
        {stats?.l3.rulesCount ?? 0} 条规则已沉淀 · 暂无可展示的纠错明细
      </p>
    )
  }

  return (
    <div>
      <p className="md-text-faint mb-2 text-[11px] tabular-nums">
        {items.length} 条最近纠错
        {stats?.l3.rulesCount ? ` · 规则 ${stats.l3.rulesCount}` : ''}
      </p>
      <div className={LAYER_SCROLL}>
        <ul className="flex flex-col">
          {items.map((item, i) => (
            <li
              key={`${item.timestamp}-${i}`}
              className="border-b border-foreground/[0.05] py-2 last:border-b-0"
            >
              <p className="md-text text-[12px] leading-relaxed">{item.correction}</p>
              {item.context ? (
                <p className="md-text-faint mt-0.5 line-clamp-2 text-[11px] leading-relaxed">
                  {item.context}
                </p>
              ) : null}
              {item.timestamp ? (
                <p className="md-text-faint mt-1 text-[10px] tabular-nums">
                  {formatRelativeTime(item.timestamp)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function L4SessionList({
  loading,
  sessions,
}: {
  loading: boolean
  sessions: SessionItem[]
}): React.ReactElement {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1">
        <Loader2 className="size-3.5 animate-spin md-text-faint" />
        <span className="md-text-faint text-[11px]">加载会话…</span>
      </div>
    )
  }

  if (sessions.length === 0) {
    return <p className="md-text-faint text-[11px]">暂无最近会话摘要</p>
  }

  return (
    <ul className="flex flex-col">
      {sessions.map((s) => (
        <li key={s.id} className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 py-2">
          <span className="md-text-faint pt-0.5 text-[10px] tabular-nums">
            {formatSessionStamp(s.created_at)}
          </span>
          <div className="min-w-0">
            <p className="md-text truncate text-[12px] font-medium">{s.title || '（无标题）'}</p>
            {s.summary ? (
              <div className="md-text-faint mt-0.5 line-clamp-3 overflow-hidden text-[11px] leading-relaxed break-words [&>*:first-child]:mt-0">
                <Markdown remarkPlugins={[remarkGfm]} components={SESSION_MD_COMPONENTS}>
                  {s.summary}
                </Markdown>
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
