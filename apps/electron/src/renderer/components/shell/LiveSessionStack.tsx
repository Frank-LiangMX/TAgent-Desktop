/**
 * 顶栏运行中会话堆叠卡片
 * 多会话并行时以卡片叠放展示，而非仅显示第一条 +N。
 */
import { useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import type { TabItem } from '../../atoms/tabs'
import { formatElapsedDuration, useLiveElapsedMs } from '../../lib/time-utils'
import { cn } from '../../lib/utils'

const MAX_VISIBLE = 3

export interface LiveSessionStackProps {
  sessions: TabItem[]
  startedAtBySession: Record<string, number | null | undefined>
  onOpenSession?: (sessionId: string, title: string) => void
}

function LiveSessionCard({
  session,
  startedAt,
  depth,
  spread,
  reducedMotion,
  onOpen,
}: {
  session: TabItem
  startedAt: number | null | undefined
  depth: number
  spread: number
  reducedMotion: boolean
  onOpen?: () => void
}): JSX.Element {
  const elapsedMs = useLiveElapsedMs(startedAt ?? undefined, true, 1000)
  const title = session.title || '未命名会话'
  const isFront = depth === 0
  const label = isFront
    ? `运行中 · ${title} · ${formatElapsedDuration(elapsedMs)}`
    : title

  return (
    <motion.button
      type="button"
      layout={!reducedMotion}
      initial={reducedMotion ? false : { opacity: 0, y: 10, scale: 0.94 }}
      animate={{
        opacity: depth === 0 ? 1 : depth === 1 ? 0.82 : 0.62,
        y: depth * -5 * spread,
        scale: 1 - depth * 0.028,
      }}
      exit={
        reducedMotion
          ? undefined
          : {
              opacity: 0,
              y: -8,
              scale: 0.96,
              transition: { duration: 0.16, ease: 'easeIn' },
            }
      }
      transition={
        reducedMotion
          ? { duration: 0 }
          : { type: 'spring', stiffness: 460, damping: 34, mass: 0.82 }
      }
      className={cn(
        'status-ticker status-ticker--live status-ticker-stack__card titlebar-no-drag',
        isFront && 'status-ticker-stack__card--front',
        !isFront && 'status-ticker-stack__card--back',
      )}
      style={{ zIndex: 20 - depth }}
      aria-label={isFront ? `打开运行中的会话：${title}` : `打开会话：${title}`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
    >
      {isFront ? <span className="status-ticker__live-dot" aria-hidden /> : null}
      <span className="status-ticker-stack__text">{label}</span>
    </motion.button>
  )
}

export function LiveSessionStack({
  sessions,
  startedAtBySession,
  onOpenSession,
}: LiveSessionStackProps): JSX.Element {
  const reducedMotion = useReducedMotion()
  const [spread, setSpread] = useState(1)
  const visible =
    sessions.length > MAX_VISIBLE ? sessions.slice(sessions.length - MAX_VISIBLE) : sessions

  return (
    <div
      className="status-ticker-stack"
      onMouseEnter={() => setSpread(1.55)}
      onMouseLeave={() => setSpread(1)}
      onFocus={() => setSpread(1.35)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setSpread(1)
        }
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {[...visible].reverse().map((session, reverseIndex) => {
          const depth = reverseIndex
          return (
            <LiveSessionCard
              key={session.sessionId}
              session={session}
              startedAt={startedAtBySession[session.sessionId]}
              depth={depth}
              spread={spread}
              reducedMotion={!!reducedMotion}
              onOpen={() => onOpenSession?.(session.sessionId, session.title)}
            />
          )
        })}
      </AnimatePresence>
    </div>
  )
}

export { MAX_VISIBLE as LIVE_SESSION_STACK_MAX_VISIBLE }
