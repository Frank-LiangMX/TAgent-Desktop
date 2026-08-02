/**
 * Chat @ 角色选择器（Phase B1）
 * 输入 @ 后弹出可 pin 的角色短列表（当前 = 角色库全量，后续可缩 pin）。
 */
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'

export interface MentionRoleOption {
  id: string
  displayName: string
  description?: string
}

interface MentionPickerProps {
  open: boolean
  query: string
  roles: MentionRoleOption[]
  activeIndex: number
  onSelect: (role: MentionRoleOption) => void
  onActiveIndexChange: (index: number) => void
  className?: string
}

export function MentionPicker({
  open,
  query,
  roles,
  activeIndex,
  onSelect,
  onActiveIndexChange,
  className,
}: MentionPickerProps): JSX.Element | null {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return roles.slice(0, 12)
    return roles
      .filter(
        (r) =>
          r.id.toLowerCase().includes(q) ||
          r.displayName.toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q),
      )
      .slice(0, 12)
  }, [query, roles])

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      onActiveIndexChange(Math.max(0, filtered.length - 1))
    }
  }, [activeIndex, filtered.length, onActiveIndexChange])

  if (!open || filtered.length === 0) return null

  return (
    <div
      className={cn(
        'mention-picker absolute bottom-full left-2 right-2 z-40 mb-1 max-h-52 overflow-auto rounded-xl border border-border/60 bg-background/95 py-1 shadow-lg backdrop-blur-md',
        className,
      )}
      role="listbox"
      aria-label="选择 @ 角色"
    >
      <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        点名角色（Chat）
      </div>
      {filtered.map((role, i) => (
        <button
          key={role.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={cn(
            'flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left text-[12px] transition-colors',
            i === activeIndex ? 'bg-primary/10 text-foreground' : 'hover:bg-foreground/5',
          )}
          onMouseEnter={() => onActiveIndexChange(i)}
          onClick={() => onSelect(role)}
        >
          <span className="font-semibold">
            @{role.displayName}
            <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">
              {role.id}
            </span>
          </span>
          {role.description ? (
            <span className="line-clamp-1 text-[11px] text-muted-foreground">
              {role.description}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
