/**
 * ComposerUnderlay — 输入框下方可折叠功能栏
 *
 * 聚焦输入框时展开，显示权限模式 + 子代理积极性 + 思考强度。
 * 对齐 TAgent_General ComposerUnderlay 视觉：玻璃格子 + 玻璃 Popover（无内层再包一层）。
 */
import { useState, useCallback, useRef, useMemo } from 'react'
import { ShieldCheck, Bot, Brain, Check } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent, MenuPopoverItem } from '@tagent/ui'
import type { TAgentPermissionMode, SubagentEagerness, ReasoningEffort } from '@tagent/shared'
import { TAGENT_PERMISSION_MODE_ORDER, TAGENT_PERMISSION_MODE_CONFIG } from '@tagent/shared'
import { cn } from '../../lib/utils'

interface ComposerUnderlayProps {
  permissionMode: TAgentPermissionMode
  onPermissionModeChange: (mode: TAgentPermissionMode) => void
  subagentEagerness: SubagentEagerness
  onSubagentEagernessChange: (level: SubagentEagerness) => void
  reasoningEffort: ReasoningEffort
  onReasoningEffortChange: (effort: ReasoningEffort) => void
}

const EAGERNESS_LABELS: Record<SubagentEagerness, string> = {
  never: '禁用',
  conservative: '保守',
  balanced: '均衡',
  aggressive: '激进',
}

const EAGERNESS_DESCRIPTIONS: Record<SubagentEagerness, string> = {
  never: '不主动委派，仅在你明确要求时使用',
  conservative: '明确有益才委派（默认）',
  balanced: '积极委派，保持主上下文干净',
  aggressive: '尽可能委派，主会话只做编排与决策',
}

const EAGERNESS_ORDER = ['never', 'conservative', 'balanced', 'aggressive'] as const

const REASONING_LABELS: Record<ReasoningEffort, string> = {
  low: '轻量',
  medium: '均衡',
  high: '深度',
  max: '极限',
}

const REASONING_ORDER = ['low', 'medium', 'high', 'max'] as const

/** 单元格 + popover，对齐 General 的 agent-toolbar-popover（玻璃本身即菜单，不再内套一层） */
function UnderlayCell({
  icon, label, value, open, onOpenChange, children,
}: {
  icon: React.ReactNode
  label: string
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn('composer-underlay-cell', open && 'composer-underlay-cell--open')}
          type="button"
        >
          {icon}
          <span className="composer-underlay-cell__label">{label}</span>
          <span className="composer-underlay-cell__value">{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="agent-toolbar-popover w-auto min-w-[168px] p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** 选项行改用通用积木 MenuPopoverItem（见下文权限/子代理弹窗） */


/* ------------------------------------------------------------------ */
// 思考强度滑杆 — 粗条 + 能量动画
// 越往右（高强度）：填充越亮、粒子越多越快、thumb 脉冲越强

const THUMB_HALF = 8 // px, thumb 半宽

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

/** 预设粒子位置（对齐 Kun REASONING_PARTICLES，16 颗，x% 在轨道上均匀分布） */
const PARTICLES = [
  { x: '6%',  y: '55%', size: '3px', delay: '-2.1s', dur: '3.7s', dx: '5px',  dy: '-6px' },
  { x: '13%', y: '30%', size: '2px', delay: '-0.4s', dur: '2.9s', dx: '-4px', dy: '5px' },
  { x: '20%', y: '65%', size: '4px', delay: '-1.6s', dur: '4.4s', dx: '5px',  dy: '-4px' },
  { x: '27%', y: '40%', size: '2px', delay: '-3.1s', dur: '3.2s', dx: '-6px', dy: '-3px' },
  { x: '34%', y: '68%', size: '3px', delay: '-0.9s', dur: '4.1s', dx: '4px',  dy: '-7px' },
  { x: '41%', y: '25%', size: '5px', delay: '-2.8s', dur: '3.8s', dx: '-3px', dy: '6px' },
  { x: '48%', y: '52%', size: '2px', delay: '-1.2s', dur: '2.7s', dx: '7px',  dy: '-3px' },
  { x: '55%', y: '35%', size: '3px', delay: '-3.7s', dur: '4.6s', dx: '-5px', dy: '4px' },
  { x: '62%', y: '70%', size: '2px', delay: '-0.2s', dur: '3.4s', dx: '4px',  dy: '-6px' },
  { x: '69%', y: '45%', size: '4px', delay: '-2.4s', dur: '4.2s', dx: '-7px', dy: '-4px' },
  { x: '76%', y: '28%', size: '2px', delay: '-1.4s', dur: '3.1s', dx: '5px',  dy: '7px' },
  { x: '83%', y: '62%', size: '3px', delay: '-3.4s', dur: '3.9s', dx: '-4px', dy: '-6px' },
  { x: '90%', y: '38%', size: '4px', delay: '-0.7s', dur: '2.8s', dx: '6px',  dy: '4px' },
  { x: '95%', y: '58%', size: '3px', delay: '-1.8s', dur: '3.5s', dx: '-5px', dy: '6px' },
  { x: '50%', y: '50%', size: '3px', delay: '-2.6s', dur: '4.5s', dx: '-5px', dy: '-7px' },
  { x: '75%', y: '72%', size: '2px', delay: '-3.9s', dur: '4.0s', dx: '6px',  dy: '-4px' },
] as const

interface ReasoningSliderProps {
  value: ReasoningEffort
  onChange: (effort: ReasoningEffort) => void
}

function ReasoningSlider({ value, onChange }: ReasoningSliderProps): JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const dragPointerRef = useRef<number | null>(null)

  const position = effortPosition(value)
  const index = REASONING_ORDER.indexOf(value)

  // 粒子数随强度递增：low=0, medium=5, high=10, max=16
  const particleCount = Math.round(PARTICLES.length * position)
  // 动画速度：高强度更快
  const speedFactor = 1 + position * 0.6 // 1x ~ 1.6x

  const selectAtPointer = useCallback((clientX: number): void => {
    const rail = railRef.current
    if (!rail) return
    const rect = rail.getBoundingClientRect()
    const usable = rect.width - THUMB_HALF * 2
    if (usable <= 0) return
    const pos = Math.min(1, Math.max(0, (clientX - rect.left - THUMB_HALF) / usable))
    const next = effortForPosition(pos)
    if (next !== value) onChange(next)
  }, [value, onChange])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    dragPointerRef.current = e.pointerId
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch { /* ignore */ }
    selectAtPointer(e.clientX)
  }, [selectAtPointer])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragPointerRef.current !== e.pointerId) return
    selectAtPointer(e.clientX)
  }, [selectAtPointer])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragPointerRef.current === e.pointerId) {
      dragPointerRef.current = null
    }
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch { /* ignore */ }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
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
  }, [value, onChange])

  // 强度对应的动画 class
  const intensityClass = `reasoning-slider--${value}`

  return (
    <div className={cn('reasoning-slider', intensityClass)}>
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
        {/* 能量粒子层 */}
        {particleCount > 0 && (
          <span className="reasoning-slider-particles" aria-hidden="true">
            {PARTICLES.slice(0, particleCount).map((p, i) => (
              <i
                key={i}
                className="reasoning-slider-particle"
                style={{
                  left: p.x,
                  top: p.y,
                  width: p.size,
                  height: p.size,
                  animationDelay: p.delay,
                  animationDuration: `${parseFloat(p.dur) / speedFactor}s`,
                  '--particle-dx': p.dx,
                  '--particle-dy': p.dy,
                } as React.CSSProperties}
              />
            ))}
          </span>
        )}
        {/* 粗轨道 */}
        <div className="reasoning-slider-track" aria-hidden="true">
          <span
            className="reasoning-slider-fill"
            style={{ width: thumbLeft(position) }}
          />
        </div>
        {/* Thumb */}
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

/* ------------------------------------------------------------------ */

export function ComposerUnderlay({
  permissionMode,
  onPermissionModeChange,
  subagentEagerness,
  onSubagentEagernessChange,
  reasoningEffort,
  onReasoningEffortChange,
}: ComposerUnderlayProps): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null)

  return (
    <div className="composer-underlay">
      <UnderlayCell
        icon={<ShieldCheck className="composer-underlay-cell__icon" aria-hidden />}
        label="权限"
        value={TAGENT_PERMISSION_MODE_CONFIG[permissionMode]?.label ?? permissionMode}
        open={openKey === 'permission'}
        onOpenChange={(o) => setOpenKey(o ? 'permission' : null)}
      >
        <div className="flex w-56 flex-col gap-0.5">
          {TAGENT_PERMISSION_MODE_ORDER.map((mode) => {
            const cfg = TAGENT_PERMISSION_MODE_CONFIG[mode]
            return (
              <MenuPopoverItem
                key={mode}
                label={cfg.label}
                description={cfg.description}
                selected={permissionMode === mode}
                trailing={permissionMode === mode && (
                  <Check className="size-3.5 text-primary" strokeWidth={2.5} />
                )}
                onClick={() => {
                  onPermissionModeChange(mode)
                  setOpenKey(null)
                }}
              />
            )
          })}
        </div>
      </UnderlayCell>

      <UnderlayCell
        icon={<Bot className="composer-underlay-cell__icon" aria-hidden />}
        label="子代理"
        value={EAGERNESS_LABELS[subagentEagerness] ?? subagentEagerness}
        open={openKey === 'eagerness'}
        onOpenChange={(o) => setOpenKey(o ? 'eagerness' : null)}
      >
        <div className="flex w-52 flex-col gap-0.5">
          {EAGERNESS_ORDER.map((level) => (
            <MenuPopoverItem
              key={level}
              label={EAGERNESS_LABELS[level]}
              description={EAGERNESS_DESCRIPTIONS[level]}
              selected={subagentEagerness === level}
              trailing={subagentEagerness === level && (
                <Check className="size-3.5 text-primary" strokeWidth={2.5} />
              )}
              onClick={() => {
                onSubagentEagernessChange(level)
                setOpenKey(null)
              }}
            />
          ))}
        </div>
      </UnderlayCell>

      <UnderlayCell
        icon={<Brain className="composer-underlay-cell__icon" aria-hidden />}
        label="思考"
        value={REASONING_LABELS[reasoningEffort] ?? reasoningEffort}
        open={openKey === 'reasoning'}
        onOpenChange={(o) => setOpenKey(o ? 'reasoning' : null)}
      >
        <div className="w-48 px-0.5 py-1">
          <ReasoningSlider
            value={reasoningEffort}
            onChange={(next) => {
              onReasoningEffortChange(next)
            }}
          />
        </div>
      </UnderlayCell>
    </div>
  )
}
