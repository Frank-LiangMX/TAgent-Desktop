/**
 * 思考强度 — 常驻输入区 compact pill + 滑杆 popover
 * （从功能栏迁出，Chat/Work 均可用）
 */
import { useCallback, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import { AppTooltip, Popover, PopoverTrigger, PopoverContent } from '@tagent/ui'
import type { ReasoningEffort } from '@tagent/shared'
import { cn } from '../../lib/utils'

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  low: '轻量',
  medium: '均衡',
  high: '深度',
  max: '极限',
}

const REASONING_ORDER = ['low', 'medium', 'high', 'max'] as const

const THUMB_HALF = 8

function effortPosition(effort: ReasoningEffort): number {
  const idx = Math.max(0, REASONING_ORDER.indexOf(effort))
  return idx / (REASONING_ORDER.length - 1)
}

function effortForPosition(position: number): ReasoningEffort {
  const normalized = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0))
  const idx = Math.round(normalized * (REASONING_ORDER.length - 1))
  return REASONING_ORDER[idx] ?? 'medium'
}

function thumbLeft(position: number): string {
  const n = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0))
  return `${n * 100}%`
}

const PARTICLES = [
  { x: '6%', y: '55%', size: '3px', delay: '-2.1s', dur: '3.7s', dx: '5px', dy: '-6px' },
  { x: '13%', y: '30%', size: '2px', delay: '-0.4s', dur: '2.9s', dx: '-4px', dy: '5px' },
  { x: '20%', y: '65%', size: '4px', delay: '-1.6s', dur: '4.4s', dx: '5px', dy: '-4px' },
  { x: '27%', y: '40%', size: '2px', delay: '-3.1s', dur: '3.2s', dx: '-6px', dy: '-3px' },
  { x: '34%', y: '68%', size: '3px', delay: '-0.9s', dur: '4.1s', dx: '4px', dy: '-7px' },
  { x: '41%', y: '25%', size: '5px', delay: '-2.8s', dur: '3.8s', dx: '-3px', dy: '6px' },
  { x: '48%', y: '52%', size: '2px', delay: '-1.2s', dur: '2.7s', dx: '7px', dy: '-3px' },
  { x: '55%', y: '35%', size: '3px', delay: '-3.7s', dur: '4.6s', dx: '-5px', dy: '4px' },
  { x: '62%', y: '70%', size: '2px', delay: '-0.2s', dur: '3.4s', dx: '4px', dy: '-6px' },
  { x: '69%', y: '45%', size: '4px', delay: '-2.4s', dur: '4.2s', dx: '-7px', dy: '-4px' },
  { x: '76%', y: '28%', size: '2px', delay: '-1.4s', dur: '3.1s', dx: '5px', dy: '7px' },
  { x: '83%', y: '62%', size: '3px', delay: '-3.4s', dur: '3.9s', dx: '-4px', dy: '-6px' },
  { x: '90%', y: '38%', size: '4px', delay: '-0.7s', dur: '2.8s', dx: '6px', dy: '4px' },
  { x: '95%', y: '58%', size: '3px', delay: '-1.8s', dur: '3.5s', dx: '-5px', dy: '6px' },
  { x: '50%', y: '50%', size: '3px', delay: '-2.6s', dur: '4.5s', dx: '-5px', dy: '-7px' },
  { x: '75%', y: '72%', size: '2px', delay: '-3.9s', dur: '4.0s', dx: '6px', dy: '-4px' },
] as const

function ReasoningSlider({
  value,
  onChange,
}: {
  value: ReasoningEffort
  onChange: (effort: ReasoningEffort) => void
}): JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const dragPointerRef = useRef<number | null>(null)
  const position = effortPosition(value)
  const index = REASONING_ORDER.indexOf(value)
  const particleCount = Math.round(PARTICLES.length * position)
  const speedFactor = 1 + position * 0.6

  const selectAtPointer = useCallback(
    (clientX: number): void => {
      const rail = railRef.current
      if (!rail) return
      const rect = rail.getBoundingClientRect()
      const usable = rect.width - THUMB_HALF * 2
      if (usable <= 0) return
      const pos = Math.min(1, Math.max(0, (clientX - rect.left - THUMB_HALF) / usable))
      const next = effortForPosition(pos)
      if (next !== value) onChange(next)
    },
    [value, onChange],
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      dragPointerRef.current = e.pointerId
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      selectAtPointer(e.clientX)
    },
    [selectAtPointer],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (dragPointerRef.current !== e.pointerId) return
      selectAtPointer(e.clientX)
    },
    [selectAtPointer],
  )

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragPointerRef.current === e.pointerId) dragPointerRef.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const curIdx = REASONING_ORDER.indexOf(value)
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const next = REASONING_ORDER[Math.max(0, curIdx - 1)]
        if (next && next !== value) onChange(next)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const next = REASONING_ORDER[Math.min(REASONING_ORDER.length - 1, curIdx + 1)]
        if (next && next !== value) onChange(next)
      } else if (e.key === 'Home') {
        e.preventDefault()
        if (REASONING_ORDER[0] !== value) onChange(REASONING_ORDER[0])
      } else if (e.key === 'End') {
        e.preventDefault()
        const last = REASONING_ORDER[REASONING_ORDER.length - 1] as ReasoningEffort
        if (last !== value) onChange(last)
      }
    },
    [value, onChange],
  )

  return (
    <div className={cn('reasoning-slider', `reasoning-slider--${value}`)}>
      <div className="reasoning-slider-scale">
        <span>更快</span>
        <span>更深</span>
      </div>
      <div
        ref={railRef}
        className="reasoning-slider-rail"
        role="slider"
        tabIndex={0}
        aria-label="思考强度"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={REASONING_ORDER.length - 1}
        aria-valuenow={index}
        aria-valuetext={REASONING_LABELS[value]}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        {particleCount > 0 && (
          <span className="reasoning-slider-particles" aria-hidden="true">
            {PARTICLES.slice(0, particleCount).map((p, i) => (
              <i
                key={i}
                className="reasoning-slider-particle"
                style={
                  {
                    left: p.x,
                    top: p.y,
                    width: p.size,
                    height: p.size,
                    animationDelay: p.delay,
                    animationDuration: `${parseFloat(p.dur) / speedFactor}s`,
                    '--particle-dx': p.dx,
                    '--particle-dy': p.dy,
                  } as React.CSSProperties
                }
              />
            ))}
          </span>
        )}
        <div className="reasoning-slider-track" aria-hidden="true">
          <span className="reasoning-slider-fill" style={{ width: thumbLeft(position) }} />
        </div>
        <span
          className="reasoning-slider-thumb"
          style={{ left: thumbLeft(position) }}
          aria-hidden="true"
        />
      </div>
      <div className="reasoning-slider-labels">
        {REASONING_ORDER.map((effort) => (
          <span
            key={effort}
            className={cn('reasoning-slider-label', effort === value && 'is-active')}
          >
            {REASONING_LABELS[effort]}
          </span>
        ))}
      </div>
    </div>
  )
}

export interface ReasoningEffortPickerProps {
  value: ReasoningEffort
  onChange: (effort: ReasoningEffort) => void
  className?: string
}

export function ReasoningEffortPicker({
  value,
  onChange,
  className,
}: ReasoningEffortPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const label = REASONING_LABELS[value] ?? value

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip label={`思考强度：${label}（点按调节）`} side="top">
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'reasoning-effort-picker',
              open && 'reasoning-effort-picker--open',
              className,
            )}
            aria-label={`思考强度：${label}`}
          >
            <Brain className="reasoning-effort-picker__icon" aria-hidden strokeWidth={2} />
            <span className="reasoning-effort-picker__label">{label}</span>
          </button>
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="agent-toolbar-popover w-auto min-w-[200px] p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          思考强度
        </div>
        <div className="w-48 px-0.5 py-1">
          <ReasoningSlider value={value} onChange={onChange} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
