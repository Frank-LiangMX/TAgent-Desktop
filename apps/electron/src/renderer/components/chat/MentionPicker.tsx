/**
 * Chat @ 角色选择器（Phase B1）
 * 浮在输入框**外侧**（fixed portal，不被 chat-input-glass overflow 裁切）。
 * 过滤与 ChatInput 键盘选择共用 filterMentionRoles。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  /** 锚定元素：输入浮岛外框，用于定位在输入框上方外侧 */
  anchorRef: React.RefObject<HTMLElement | null>
  className?: string
}

export function MentionPicker({
  open,
  query,
  roles,
  activeIndex,
  onSelect,
  onActiveIndexChange,
  anchorRef,
  className,
}: MentionPickerProps): JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; width: number; bottom: number } | null>(null)

  const filtered = useMemo(() => filterMentionRoles(roles, query), [query, roles])

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      onActiveIndexChange(Math.max(0, filtered.length - 1))
    }
  }, [activeIndex, filtered.length, onActiveIndexChange])

  // 键盘高亮行滚入可视区
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-mention-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, filtered.length])

  // 贴在输入框上方外侧（fixed，相对视口）
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const update = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      setPos({
        left: Math.max(8, r.left),
        width: Math.min(r.width, window.innerWidth - 16),
        bottom: Math.max(8, window.innerHeight - r.top + 8),
      })
    }
    update()
    window.addEventListener('resize', update)
    // 捕获滚动：底栏/会话滚动时跟着重定位
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef])

  if (!open || filtered.length === 0 || !pos) return null

  return createPortal(
    <div
      ref={listRef}
      className={cn(
        'mention-picker fixed z-[200] max-h-52 overflow-auto rounded-xl border border-border/60',
        'bg-background/95 py-1 shadow-lg backdrop-blur-md',
        className,
      )}
      style={{
        left: pos.left,
        width: pos.width,
        bottom: pos.bottom,
      }}
      role="listbox"
      aria-label="选择 @ 提及对象"
    >
      <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        选择提及对象
      </div>
      {filtered.map((role, i) => (
        <button
          key={role.id}
          type="button"
          role="option"
          data-mention-idx={i}
          aria-selected={i === activeIndex}
          className={cn(
            'flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left text-[12px] transition-colors',
            i === activeIndex ? 'bg-primary/10 text-foreground' : 'hover:bg-foreground/5',
          )}
          onMouseEnter={() => onActiveIndexChange(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(role)}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="mention-chip mention-chip--picker">@{role.displayName}</span>
            <span className="font-mono text-[10px] font-normal text-muted-foreground">
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
    </div>,
    document.body,
  )
}
