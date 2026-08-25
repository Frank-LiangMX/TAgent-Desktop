import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  FolderOpen,
  Settings2,
} from "lucide-react";
import type { KnowledgeBaseRecord } from "@tagent/shared";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@tagent/ui";
import { cn } from "../../lib/utils";
import { usePersistedSessionMeta } from "../../hooks/usePersistedSessionMeta";

type KnowledgeBaseMode = "off" | "preferred" | "strict";

const modeOptions: Array<{
  value: KnowledgeBaseMode;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "不使用",
    description: "普通对话，不主动检索知识库",
  },
  {
    value: "preferred",
    label: "优先使用",
    description: "先检索知识库，必要时补充通用知识",
  },
  {
    value: "strict",
    label: "仅使用",
    description: "只依据知识库，找不到就明确说明",
  },
];

export function KnowledgeBaseSelector({
  sessionId,
}: {
  sessionId: string;
}): JSX.Element {
  const meta = usePersistedSessionMeta(sessionId);
  const [items, setItems] = useState<KnowledgeBaseRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedIds = meta?.knowledgeBaseIds ?? [];
  const mode: KnowledgeBaseMode = meta?.knowledgeBaseMode ?? "off";
  const selected = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id)),
    [items, selectedIds],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void window.electronAPI
      .listKnowledgeBases()
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const toggle = async (id: string) => {
    const wasSelected = selectedIds.includes(id);
    const next = wasSelected
      ? selectedIds.filter((value) => value !== id)
      : [...selectedIds, id];
    const nextMode: KnowledgeBaseMode =
      next.length === 0
        ? "off"
        : !wasSelected && selectedIds.length === 0 && mode === "off"
          ? "preferred"
          : mode;
    try {
      await window.electronAPI.updateSessionMeta(sessionId, {
        knowledgeBaseIds: next,
        knowledgeBaseMode: nextMode,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setKnowledgeBaseMode = async (nextMode: KnowledgeBaseMode) => {
    if (nextMode !== "off" && selectedIds.length === 0) return;
    try {
      await window.electronAPI.updateSessionMeta(sessionId, {
        knowledgeBaseMode: nextMode,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const manage = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("tagent:open-knowledge-bases"));
  };
  const modeLabel = mode === "strict" ? " · 仅使用" : mode === "preferred" ? " · 优先" : "";
  const label =
    selected.length === 0
      ? "知识库"
      : selected.length === 1
        ? (selected[0]?.name ?? "知识库") + modeLabel
        : "知识库 · " + selected.length + modeLabel;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "max-w-[220px] gap-1.5",
            selected.length > 0 && mode !== "off" && "text-primary",
          )}
          aria-label="选择知识库和使用模式"
        >
          <BookOpen size={15} />
          <span className="truncate">{label}</span>
          <ChevronDown size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">本次会话的知识范围</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            先选择知识库，再决定 Agent 是否主动使用。知识库可以跨项目复用。
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto p-2">
          {error && (
            <p className="px-2 py-2 text-xs text-destructive">{error}</p>
          )}
          {items.length === 0 ? (
            <div className="px-3 py-5 text-center">
              <FolderOpen
                size={22}
                className="mx-auto mb-2 text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                还没有可用的知识库。
              </p>
              <Button
                variant="link"
                size="sm"
                className="mt-1"
                onClick={manage}
              >
                去创建
              </Button>
            </div>
          ) : (
            items.map((item) => {
              const checked = selectedIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent",
                    checked && "bg-primary/5",
                  )}
                  onClick={() => void toggle(item.id)}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                      checked &&
                        "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {checked && <Check size={12} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{item.name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {item.sources.length
                        ? item.sources.length + " 个来源目录"
                        : "待添加来源"}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t px-3 py-3">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            Agent 使用方式
          </p>
          <div className="mt-2 space-y-1">
            {modeOptions.map((option) => {
              const disabled = option.value !== "off" && selectedIds.length === 0;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={mode === option.value}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left transition-colors",
                    mode === option.value ? "bg-primary/10" : "hover:bg-accent",
                    disabled && "cursor-not-allowed opacity-40",
                  )}
                  onClick={() => void setKnowledgeBaseMode(option.value)}
                >
                  <span className="block text-xs font-medium">{option.label}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={manage}
          >
            <Settings2 size={15} />
            管理知识库
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
