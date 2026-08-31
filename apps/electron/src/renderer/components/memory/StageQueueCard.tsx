/**
 * StageQueueCard — 待审批记忆队列
 *
 * 紧凑列表：单条/批量 accept/reject。嵌入记忆页待审条带，非独立任务卡场。
 */

import * as React from 'react'

import { Check, Loader2, X } from 'lucide-react'

import type { StageEntry } from '@tagent/shared'
import { AppTooltip } from '@tagent/ui'
import { cn } from '@/lib/utils'

interface StageQueueCardProps {
  mode: 'general' | 'ta'
  onChanged: () => void
}

function memoryStatusLabel(status?: string): string {
  switch (status) {
    case 'active':
      return '已生效'
    case 'candidate':
      return '候选'
    case 'pending_approval':
      return '待审批'
    case 'rejected':
      return '已拒绝'
    case 'deferred':
      return '已延后'
    default:
      return '待治理'
  }
}
export function StageQueueCard({
  mode,
  onChanged,
}: StageQueueCardProps): React.ReactElement | null {
  const [entries, setEntries] = React.useState<StageEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [acting, setActing] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.electronAPI.getStageQueue(mode)
      setEntries(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode])

  React.useEffect(() => {
    void load()
  }, [load])

  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setActing(key)
    try {
      await fn()
      await load()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActing(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-1 py-3">
        <Loader2 className="size-3.5 animate-spin md-text-faint" />
        <span className="md-text-faint text-[11px]">加载待审批…</span>
      </div>
    )
  }

  if (entries.length === 0 && !error) return null

  return (
    <div>
      {entries.length > 1 ? (
        <div className="mb-1.5 flex items-center justify-end gap-1">
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => void run('accept-all', () => window.electronAPI.acceptStageAll(mode))}
            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-400"
          >
            {acting === 'accept-all' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Check className="size-3" strokeWidth={1.75} />
            )}
            全部接受
          </button>
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => void run('reject-all', () => window.electronAPI.rejectStageAll(mode))}
            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] md-text-variant hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40"
          >
            {acting === 'reject-all' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <X className="size-3" strokeWidth={1.75} />
            )}
            全部拒绝
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <div className="mb-1.5 rounded-glass-popover bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-500">
          {error}
        </div>
      ) : null}

      <ul className="flex max-h-[min(240px,36vh)] flex-col overflow-y-auto overflow-x-hidden scrollbar-thin pr-1">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-start gap-2 border-b border-foreground/[0.05] py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="md-text-faint flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                  {entry.targetLayer}
                </span>
                <span>{entry.type}</span>
                <span>·</span>
                <span>{new Date(entry.enqueuedAt).toLocaleDateString('zh-CN')}</span>
                <span>·</span>
                <span>
                  {entry.scope === 'project'
                    ? '项目'
                    : entry.scope === 'global'
                      ? '全局'
                      : '旧记录'}
                </span>
                {entry.workspaceSlug ? <span>workspace · {entry.workspaceSlug}</span> : null}
                <span>· {memoryStatusLabel(entry.status)}</span>
              </div>
              <AppTooltip label={entry.pattern} multiline>
                <p className="md-text mt-1 line-clamp-2 text-[12px] leading-relaxed">
                  {entry.pattern}
                </p>
              </AppTooltip>
              {entry.evidence.length > 0 ? (
                <details className="mt-1 text-[10px]">
                  <summary className="md-text-faint cursor-pointer select-none">
                    查看依据 · {entry.evidence.length} 条
                  </summary>
                  <ul className="md-text-faint mt-1 space-y-0.5 border-l border-foreground/[0.12] pl-2 leading-relaxed">
                    {entry.evidence.map((evidence, index) => (
                      <li key={`${entry.id}-evidence-${index}`}>{evidence}</li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p className="md-text-faint mt-1 text-[10px]">暂无结构化依据</p>
              )}
            </div>
            <div className="flex shrink-0 gap-0.5">
              <AppTooltip label="接受">
                <button
                  type="button"
                  disabled={acting !== null}
                  onClick={() =>
                    void run(`accept-${entry.id}`, () =>
                      window.electronAPI.acceptStageOne(mode, entry.id),
                    )
                  }
                  className={cn(
                    'inline-flex size-7 items-center justify-center rounded-full',
                    'text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-35 dark:text-emerald-400',
                  )}
                  aria-label="接受"
                >
                  {acting === `accept-${entry.id}` ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3.5" strokeWidth={1.75} />
                  )}
                </button>
              </AppTooltip>
              <AppTooltip label="拒绝">
                <button
                  type="button"
                  disabled={acting !== null}
                  onClick={() =>
                    void run(`reject-${entry.id}`, () =>
                      window.electronAPI.rejectStageOne(mode, entry.id),
                    )
                  }
                  className="inline-flex size-7 items-center justify-center rounded-full md-text-variant hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-35"
                  aria-label="拒绝"
                >
                  {acting === `reject-${entry.id}` ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <X className="size-3.5" strokeWidth={1.75} />
                  )}
                </button>
              </AppTooltip>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
