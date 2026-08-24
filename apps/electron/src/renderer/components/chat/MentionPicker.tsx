/**
 * Chat @ 角色选择器（Phase B1）
 * 浮在输入框**外侧**（fixed portal，不被 chat-input-glass overflow 裁切）。
 * 过滤与 ChatInput 键盘选择共用 filterMentionRoles。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { filterMentionRoles } from "@tagent/shared";
import { cn } from "../../lib/utils";

export interface MentionRoleOption {
  id: string;
  displayName: string;
  description?: string;
  /** 置顶到 @ 快捷列表（RolesPage 勾选写入角色库） */
  kind?: "role" | "bot";
  pinned?: boolean;
}

interface MentionPickerProps {
  open: boolean;
  query: string;
  roles: MentionRoleOption[];
  activeIndex: number;
  onSelect: (role: MentionRoleOption) => void;
  onActiveIndexChange: (index: number) => void;
  /** 锚定元素：输入浮岛外框，用于定位在输入框上方外侧 */
  anchorRef: React.RefObject<HTMLElement | null>;
  className?: string;
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
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    bottom: number;
  } | null>(null);

  const filtered = useMemo(
    () => filterMentionRoles(roles, query),
    [query, roles],
  );

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      onActiveIndexChange(Math.max(0, filtered.length - 1));
    }
  }, [activeIndex, filtered.length, onActiveIndexChange]);

  // 键盘高亮行滚入可视区
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-mention-idx="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, filtered.length]);

  // 贴在输入框上方外侧（fixed，相对视口）
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      setPos({
        left: Math.max(8, r.left),
        width: Math.min(r.width, window.innerWidth - 16),
        bottom: Math.max(8, window.innerHeight - r.top + 8),
      });
    };
    update();
    window.addEventListener("resize", update);
    // 捕获滚动：底栏/会话滚动时跟着重定位
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef]);

  if (!open || filtered.length === 0 || !pos) return null;

  return createPortal(
    <div
      ref={listRef}
      className={cn(
        "mention-picker fixed z-[200] max-h-64 overflow-auto rounded-2xl p-1",
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
      <div className="px-2.5 pb-1.5 pt-2 text-[11px] font-medium text-muted-foreground">
        选择提及对象
      </div>
      {filtered.map((role, i) => (
        <button
          key={role.id}
          type="button"
          role="option"
          data-mention-idx={i}
          aria-selected={i === activeIndex}
          aria-label={
            role.description
              ? `@${role.displayName}，${role.description}`
              : `@${role.displayName}`
          }
          title={role.description || `@${role.displayName}`}
          className={cn(
            "mx-0 flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors",
            i === activeIndex
              ? "bg-primary/10 text-foreground"
              : "text-foreground/85 hover:bg-foreground/5",
          )}
          onMouseEnter={() => onActiveIndexChange(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(role)}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[12px] font-semibold text-primary">
            @
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            @{role.displayName}
          </span>
          {role.id === "all" ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              全部成员
            </span>
          ) : role.kind === "bot" ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Bot
            </span>
          ) : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
