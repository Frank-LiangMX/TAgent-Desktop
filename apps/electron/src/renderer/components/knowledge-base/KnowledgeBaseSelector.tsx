import { useEffect, useState } from "react";
import { Check, FolderOpen, Settings2 } from "lucide-react";
import type { KnowledgeBaseRecord } from "@tagent/shared";
import {
  MenuPopoverItem,
  MenuPopoverSeparator,
  SegmentedTabs,
  SegmentedTabsItem,
} from "@tagent/ui";
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
    label: "优先",
    description: "先检索知识库，必要时补充通用知识",
  },
  {
    value: "strict",
    label: "仅用",
    description: "只依据知识库，找不到就明确说明",
  },
];

/**
 * 知识库绑定 / 使用方式面板（无 Popover 外壳）。
 * 供 ComposerPlusMenu「+」→「知识库」子视图挂载；紧凑菜单态，不堆说明文案。
 */
export function KnowledgeBasePanel({
  sessionId,
  onManage,
}: {
  sessionId: string;
  onManage?: () => void;
}): JSX.Element {
  const meta = usePersistedSessionMeta(sessionId);
  const [items, setItems] = useState<KnowledgeBaseRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const selectedIds = meta?.knowledgeBaseIds ?? [];
  const mode: KnowledgeBaseMode = meta?.knowledgeBaseMode ?? "off";
  const hasSelection = selectedIds.length > 0;

  const notifySessionMetaChanged = (): void => {
    window.dispatchEvent(
      new CustomEvent("tagent:session-meta-changed", {
        detail: { sessionId },
      }),
    );
  };

  useEffect(() => {
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
  }, []);

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
      const updated = await window.electronAPI.updateSessionMeta(sessionId, {
        knowledgeBaseIds: next,
        knowledgeBaseMode: nextMode,
      });
      if (!updated) throw new Error("当前会话无法保存知识库设置");
      notifySessionMetaChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setKnowledgeBaseMode = async (nextMode: KnowledgeBaseMode) => {
    if (nextMode !== "off" && selectedIds.length === 0) return;
    try {
      const updated = await window.electronAPI.updateSessionMeta(sessionId, {
        knowledgeBaseMode: nextMode,
      });
      if (!updated) throw new Error("当前会话无法保存知识库设置");
      notifySessionMetaChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const manage = () => {
    onManage?.();
    window.dispatchEvent(new CustomEvent("tagent:open-knowledge-bases"));
  };

  const sourceMeta = (item: KnowledgeBaseRecord): string => {
    if (!item.sources.length) return "无来源";
    return item.sources.length + " 个来源";
  };

  return (
    <div className="flex flex-col">
      <div className="max-h-52 overflow-y-auto px-1 py-1">
        {error && (
          <p className="px-2 py-1.5 text-[11px] text-destructive">{error}</p>
        )}
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <FolderOpen
              size={18}
              className="mx-auto mb-2 text-muted-foreground/70"
            />
            <p className="text-[11px] text-muted-foreground">还没有知识库</p>
            <button
              type="button"
              className="mt-1.5 text-[11px] text-primary hover:underline"
              onClick={manage}
            >
              去创建
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((item) => {
              const checked = selectedIds.includes(item.id);
              return (
                <MenuPopoverItem
                  key={item.id}
                  selected={checked}
                  label={item.name}
                  trailing={
                    <span className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">
                        {sourceMeta(item)}
                      </span>
                      {checked ? (
                        <Check className="size-3.5 text-primary" />
                      ) : null}
                    </span>
                  }
                  onClick={() => void toggle(item.id)}
                />
              );
            })}
          </div>
        )}
      </div>

      <MenuPopoverSeparator className="mx-2 my-1" />

      <div className="px-2.5 pb-2 pt-0.5">
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground/80">
            使用方式
          </span>
          {!hasSelection && (
            <span className="text-[10px] text-muted-foreground/60">
              先勾选知识库
            </span>
          )}
        </div>
        <SegmentedTabs
          value={mode}
          onValueChange={(v) =>
            void setKnowledgeBaseMode(v as KnowledgeBaseMode)
          }
          className="flex w-full"
        >
          {modeOptions.map((option) => {
            const disabled = option.value !== "off" && !hasSelection;
            return (
              <SegmentedTabsItem
                key={option.value}
                value={option.value}
                disabled={disabled}
                title={option.description}
                className={cn(
                  "min-w-0 flex-1 justify-center px-1 text-[11px]",
                  disabled && "opacity-40",
                )}
              >
                {option.label}
              </SegmentedTabsItem>
            );
          })}
        </SegmentedTabs>
      </div>

      <MenuPopoverSeparator className="mx-2 my-1" />

      <div className="px-1 pb-1">
        <MenuPopoverItem
          icon={<Settings2 className="size-3.5" />}
          label="管理知识库"
          onClick={manage}
        />
      </div>
    </div>
  );
}
