/**
 * StageQueueCard — 待审批记忆队列（Phase 2.3）
 */
import * as React from 'react'
import { Check, Loader2, X } from 'lucide-react'
import type { StageEntry } from '@tagent/shared'
import { cn } from '../../lib/utils'

interface StageQueueCardProps {
  mode: 'general' | 'ta'
  onChanged: () => void
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
      const list = (await window.electronAPI.getStageQueue(mode)) as StageEntry[]
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
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">加载待审批…</span>
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
              <Check className="size-3" />
            )}
            全部记住
          </button>
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => void run('reject-all', () => window.electronAPI.rejectStageAll(mode))}
            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            {acting === 'reject-all' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <X className="size-3" />
            )}
            全部不记
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="mb-2 text-[11px] text-destructive">{error}</p>
      ) : null}

      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li
            key={e.id}
            className={cn(
              'flex items-start gap-2 rounded-xl border border-border/50 bg-background/40 px-3 py-2',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-foreground/80">
                {e.targetLayer} · {e.type}
              </div>
              <p className="mt-0.5 line-clamp-2 text-[12px] text-foreground/70">
                {e.suggestedContent || e.pattern}
              </p>
            </div>
            <div className="flex shrink-0 gap-0.5">
              <button
                type="button"
                disabled={acting !== null}
                onClick={() =>
                  void run(`a-${e.id}`, () => window.electronAPI.acceptStageOne(mode, e.id))
                }
                className="inline-flex size-7 items-center justify-center rounded-full text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40"
                aria-label="记住"
              >
                {acting === `a-${e.id}` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                disabled={acting !== null}
                onClick={() =>
                  void run(`r-${e.id}`, () => window.electronAPI.rejectStageOne(mode, e.id))
                }
                className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-40"
                aria-label="不记"
              >
                {acting === `r-${e.id}` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
