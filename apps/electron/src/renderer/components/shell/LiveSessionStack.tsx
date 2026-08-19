/**
 * 顶栏多会话运行态：单胶囊 + 悬停下拉列表。
 * 不要再叠 peek 描边——半透明前景会把内圈边框透出来，看起来像胶囊套娃。
 */
import { useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import type { TabItem } from '../../atoms/tabs'
import { formatElapsedDuration, useLiveElapsedMs } from '../../lib/time-utils'
import { cn } from '../../lib/utils'

export interface LiveSessionStackProps {
  sessions: TabItem[]
  startedAtBySession: Record<string, number | null | undefined>
  onOpenSession?: (sessionId: string, title: string) => void
}

function SessionElapsed({
  startedAt,
  live,
}: {
  startedAt: number | null | undefined
  live: boolean
}): JSX.Element {
  const elapsedMs = useLiveElapsedMs(startedAt ?? undefined, live, 1000)
  return <>{formatElapsedDuration(elapsedMs)}</>
}

export function LiveSessionStack({
  sessions,
  startedAtBySession,
  onOpenSession,
}: LiveSessionStackProps): JSX.Element {
  const reducedMotion = useReducedMotion()
  const [open, setOpen] = useState(false)
  const count = sessions.length
  const front = sessions[sessions.length - 1]
  const panelSessions = [...sessions].reverse()

  if (!front) return <></>

  const frontTitle = front.title || '未命名会话'
  const frontStartedAt = startedAtBySession[front.sessionId]

  return (
    <div
      className={cn('status-ticker-stack', open && 'status-ticker-stack--open')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        className="status-ticker status-ticker--live status-ticker-stack__front titlebar-no-drag"
        aria-label={
          count > 1
            ? `${count} 个会话运行中，悬停查看全部`
            : `打开运行中的会话：${frontTitle}`
        }
        aria-expanded={count > 1 ? open : undefined}
        onClick={() => onOpenSession?.(front.sessionId, front.title)}
      >
        <span className="status-ticker__live-dot" aria-hidden />
        <span className="status-ticker-stack__text">
          {count > 1 ? `${count} 个运行中 · ` : '运行中 · '}
          {frontTitle}
          {' · '}
          <SessionElapsed startedAt={frontStartedAt} live />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && count > 1 ? (
          <motion.div
            key="stack-panel"
            className="status-ticker-stack__panel-anchor titlebar-no-drag"
            initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.98, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={
              reducedMotion
                ? undefined
                : {
                    opacity: 0,
                    y: -4,
                    scale: 0.98,
                    x: '-50%',
                    transition: { duration: 0.12 },
                  }
            }
            transition={
              reducedMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 480, damping: 34 }
            }
            role="list"
            aria-label="运行中的会话"
          >
            <div className="status-ticker-stack__panel session-glass-surface session-glass-popover">
            {panelSessions.map((session, index) => {
              const title = session.title || '未命名会话'
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  role="listitem"
                  className="status-ticker-stack__panel-row"
                  style={{ animationDelay: reducedMotion ? undefined : `${index * 36}ms` }}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenSession?.(session.sessionId, session.title)
                    setOpen(false)
                  }}
                >
                  <span className="status-ticker__live-dot" aria-hidden />
                  <span className="status-ticker-stack__panel-copy">
                    <span className="status-ticker-stack__panel-title">{title}</span>
                    <span className="status-ticker-stack__panel-meta">
                      运行中 ·{' '}
                      <SessionElapsed
                        startedAt={startedAtBySession[session.sessionId]}
                        live
                      />
                    </span>
                  </span>
                </button>
              )
            })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

