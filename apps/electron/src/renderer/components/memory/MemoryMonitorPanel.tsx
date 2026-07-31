/**
 * MemoryMonitorPanel — 记忆页主面板（Phase 2.3 Desktop 适配版）
 * 层次：mode 切换 → 待审队列 → L0–L5 层带展开。
 */
import * as React from 'react'
import {
  AlertTriangle,
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
import { cn } from '../../lib/utils'
import { MemoryGraph } from './MemoryGraph'
import { StageQueueCard } from './StageQueueCard'

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
type MemoryMode = 'general' | 'ta'

interface LayerConfig {
  key: LayerKey
  label: string
  code: string
  hint: string
  icon: React.ReactNode
  getCount: (stats: MemoryLayerStats) => number
  getUpdated: (stats: MemoryLayerStats) => number | null
  mdLayer?: 'L0' | 'L1' | 'L2' | 'L5'
}

const LAYERS: LayerConfig[] = [
  {
    key: 'l0',
    label: '用户画像',
    code: 'L0',
    hint: '对话中自动学习的用户偏好',
    icon: <User className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l0.exists ? s.l0.lines : 0),
    getUpdated: (s) => s.l0.lastUpdated,
    mdLayer: 'L0',
  },
  {
    key: 'l1',
    label: '项目画像',
    code: 'L1',
    hint: '当前项目上下文与约定',
    icon: <FolderTree className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l1.exists ? s.l1.lines : 0),
    getUpdated: (s) => s.l1.lastUpdated,
    mdLayer: 'L1',
  },
  {
    key: 'l2',
    label: '稳定事实',
    code: 'L2',
    hint: '跨会话保留的事实',
    icon: <Lightbulb className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l2.exists ? s.l2.lines : 0),
    getUpdated: (s) => s.l2.lastUpdated,
    mdLayer: 'L2',
  },
  {
    key: 'l3',
    label: '纠错记录',
    code: 'L3',
    hint: '用户纠正后沉淀的规则',
    icon: <AlertTriangle className="size-4" strokeWidth={1.75} />,
    getCount: (s) => s.l3.rawCount,
    getUpdated: (s) => s.l3.lastUpdated,
  },
  {
    key: 'l4',
    label: '历史会话',
    code: 'L4',
    hint: '会话日志 · FTS5',
    icon: <History className="size-4" strokeWidth={1.75} />,
    getCount: (s) => s.l4.sessions,
    getUpdated: (s) => s.l4.newestDate,
  },
  {
    key: 'l5',
    label: '提炼洞察',
    code: 'L5',
    hint: 'Reflect 从会话中提炼',
    icon: <Sparkles className="size-4" strokeWidth={1.75} />,
    getCount: (s) => (s.l5.exists ? s.l5.lines : 0),
    getUpdated: (s) => s.l5.lastUpdated,
    mdLayer: 'L5',
  },
]

function formatRelativeTime(ts: number | null): string {
  if (!ts) return '从未'
  const hours = Math.floor((Date.now() - ts) / 3600000)
  if (hours < 1) return '刚刚'
  if (hours < 24) return `${hours}h 前`
  return `${Math.floor(hours / 24)}d 前`
}

export function MemoryMonitorPanel(): React.ReactElement {
  const [mode, setMode] = React.useState<MemoryMode>('general')
  const [stats, setStats] = React.useState<MemoryLayerStats | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [surface, setSurface] = React.useState<SurfaceMode>('strata')
  const [openLayer, setOpenLayer] = React.useState<LayerKey | null>(null)
  const [pendingCount, setPendingCount] = React.useState(0)
  const [layerContent, setLayerContent] = React.useState<string | null>(null)
  const [layerLoading, setLayerLoading] = React.useState(false)
  const [sessions, setSessions] = React.useState<
    Array<{ id: number; title: string; summary: string; created_at: number }>
  >([])

  const loadStats = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await window.electronAPI.initMemoryLayers()
      const [s, pending] = await Promise.all([
        window.electronAPI.getMemoryStats(mode) as Promise<MemoryLayerStats>,
        window.electronAPI.getStageQueue(mode).catch(() => []) as Promise<unknown[]>,
      ])
      setStats(s)
      setPendingCount(Array.isArray(pending) ? pending.length : 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode])

  React.useEffect(() => {
    void loadStats()
  }, [loadStats])

  React.useEffect(() => {
    if (!openLayer || surface !== 'strata') {
      setLayerContent(null)
      return
    }
    const cfg = LAYERS.find((l) => l.key === openLayer)
    if (!cfg) return

    let cancelled = false
    setLayerLoading(true)
    ;(async () => {
      try {
        if (cfg.mdLayer) {
          const md = await window.electronAPI.getMemoryMdContent(mode, cfg.mdLayer)
          if (!cancelled) setLayerContent(md || '（空）')
        } else if (openLayer === 'l3') {
          const rows = await window.electronAPI.getMemoryCorrections(mode, 30)
          if (!cancelled) {
            setLayerContent(
              Array.isArray(rows) && rows.length > 0
                ? JSON.stringify(rows, null, 2)
                : '（无纠错记录）',
            )
          }
        } else if (openLayer === 'l4') {
          const recent = (await window.electronAPI.listRecentMemorySessions(mode, 16)) as Array<{
            id: number
            title: string
            summary: string
            created_at: number
          }>
          if (!cancelled) {
            setSessions(recent ?? [])
            setLayerContent(null)
          }
        }
      } catch (e) {
        if (!cancelled) setLayerContent(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLayerLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [openLayer, mode, surface])

  const totalMemories = stats ? LAYERS.reduce((sum, l) => sum + l.getCount(stats), 0) : 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/40 px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight">记忆</h1>
          <p className="text-xs text-muted-foreground">
            {loading
              ? '加载中…'
              : stats
                ? `${totalMemories} 条 · L0–L5 分层`
                : '未初始化'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <div className="mr-2 flex rounded-full border border-border/50 p-0.5 text-[11px]">
            {(['general', 'ta'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'rounded-full px-2.5 py-1 transition-colors',
                  mode === m
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m === 'general' ? '通用' : 'TA'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSurface((s) => (s === 'graph' ? 'strata' : 'graph'))}
            className={cn(
              'inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground',
              surface === 'graph' && 'text-primary',
            )}
            aria-label="图谱"
          >
            <GitBranch className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => void loadStats()}
            className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            aria-label="刷新"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <p className="mb-3 text-sm text-destructive">{error}</p>
        ) : null}

        {surface === 'graph' ? (
          <MemoryGraph mode={mode} />
        ) : (
          <>
            {/* 待审 */}
            {pendingCount > 0 || true ? (
              <section className="mb-5">
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  待审批 {pendingCount > 0 ? `(${pendingCount})` : ''}
                </h2>
                <StageQueueCard mode={mode} onChanged={() => void loadStats()} />
              </section>
            ) : null}

            {/* 层列表 */}
            <section className="space-y-1">
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                分层记忆
              </h2>
              {loading && !stats ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  加载统计…
                </div>
              ) : (
                LAYERS.map((layer) => {
                  const count = stats ? layer.getCount(stats) : 0
                  const updated = stats ? layer.getUpdated(stats) : null
                  const open = openLayer === layer.key
                  return (
                    <div
                      key={layer.key}
                      className="overflow-hidden rounded-xl border border-border/40 bg-background/30"
                    >
                      <button
                        type="button"
                        onClick={() => setOpenLayer(open ? null : layer.key)}
                        className="grid w-full grid-cols-[36px_minmax(0,1fr)_72px_24px] items-center gap-x-2 px-3 py-2.5 text-left hover:bg-muted/40"
                      >
                        <span className="flex size-9 items-center justify-center rounded-lg bg-muted/50 text-foreground/70">
                          {layer.icon}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium">
                            {layer.code} {layer.label}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {layer.hint}
                          </span>
                        </span>
                        <span className="text-right text-[12px] tabular-nums text-muted-foreground">
                          {count}
                          <span className="mt-0.5 block text-[10px]">
                            {formatRelativeTime(updated)}
                          </span>
                        </span>
                        <ChevronDown
                          className={cn(
                            'size-4 text-muted-foreground transition-transform',
                            open && 'rotate-180',
                          )}
                        />
                      </button>
                      {open ? (
                        <div className="border-t border-border/30 px-3 py-3">
                          {layerLoading ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="size-3.5 animate-spin" />
                              加载内容…
                            </div>
                          ) : layer.key === 'l4' ? (
                            sessions.length === 0 ? (
                              <p className="text-xs text-muted-foreground">暂无会话记录</p>
                            ) : (
                              <ul className="space-y-2">
                                {sessions.map((s) => (
                                  <li key={s.id} className="text-xs">
                                    <div className="font-medium text-foreground/80">
                                      {s.title || `会话 #${s.id}`}
                                    </div>
                                    <div className="line-clamp-2 text-muted-foreground">
                                      {s.summary || '（无摘要）'}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )
                          ) : (
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/75">
                              {layerContent ?? '（空）'}
                            </pre>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
