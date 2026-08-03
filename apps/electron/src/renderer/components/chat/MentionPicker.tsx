/**
 * Chat @ 角色选择器（Phase B1）
 * 无 query 时只显示已 pin 子集（B1：非全库）；有 query 时全库过滤、pin 优先。
 * 过滤逻辑与 ChatInput 键盘选择共用 filterMentionRoles，保证选中项一致。
 */
import { useEffect, useMemo, useState } from 'react'
import { filterMentionRoles } from '@tagent/shared'
import { cn } from '../../lib/utils'

export interface MentionRoleOption {
  id: string
  displayName: string
  description?: string
  /** 置顶到 @ 快捷列表（RolesPage 勾选写入角色库） */
  pinned?: boolean
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
  const filtered = useMemo(
    () => filterMentionRoles(roles, query),
    [query, roles],
  )

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
