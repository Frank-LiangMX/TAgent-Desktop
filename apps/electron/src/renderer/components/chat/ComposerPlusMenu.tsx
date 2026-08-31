/**
 * Composer「+」菜单：附件 + 知识库收拢
 *
 * 替换原裸「+」按钮（直开文件对话框）+ 底栏常驻「知识库」按钮，对齐 Cursor 输入框「+」菜单：
 * - 触发器：保持现有 icon-sm ghost 圆形 Plus，aria-label「添加附件与知识库」
 * - 主菜单（上→下）：图片 / 文件 → 知识库（右侧 Chevron）
 * - 点「图片 / 文件」：关菜单 + 打开系统文件对话框（选完进 pendingAttachments，与原行为一致）
 * - 点「知识库」：同一 Popover 切到知识库面板（不关菜单）；面板复用 KnowledgeBasePanel，
 *   交互与原 KnowledgeBaseSelector PopoverContent 一致（多选列表 / 使用方式 / 管理入口）
 * - 勾选知识库 / 切模式不关菜单（受控 Popover + 视图态，点击只切视图不触发外层关闭）；
 *   点「管理知识库」经 onManage 关菜单并派发 open-knowledge-bases
 * - 已绑定且 mode≠off：primary 色轻微强调「+」触发器与「知识库」行
 *
 * 草稿会话（onDraftWorkspaceChange 存在）无 session meta，写知识库会失败：传 showKnowledgeBase=false
 * 隐藏「知识库」项，与原底栏 !onDraftWorkspaceChange 逻辑一致。
 */
import { useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Paperclip,
  Plus,
} from "lucide-react";
import {
  Button,
  MenuPopoverItem,
  MenuPopoverSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@tagent/ui";
import { cn } from "../../lib/utils";
import { usePersistedSessionMeta } from "../../hooks/usePersistedSessionMeta";
import { KnowledgeBasePanel } from "../knowledge-base/KnowledgeBaseSelector";

type ComposerPlusView = "main" | "kb";

export function ComposerPlusMenu({
  sessionId,
  onPickFiles,
  showKnowledgeBase = true,
  className,
}: {
  sessionId: string;
  /** 点「图片 / 文件」时打开系统文件对话框（Chat 的 handleOpenFileDialog） */
  onPickFiles: () => void;
  /** 是否展示「知识库」项；草稿会话无 meta 写失败风险，隐藏 */
  showKnowledgeBase?: boolean;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ComposerPlusView>("main");
  const meta = usePersistedSessionMeta(sessionId);
  const selectedIds = meta?.knowledgeBaseIds ?? [];
  const mode = meta?.knowledgeBaseMode ?? "off";
  const kbActive = selectedIds.length > 0 && mode !== "off";

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    // 关闭后重置视图，避免下次打开停在知识库面板
    if (!next) setView("main");
  };

  const handlePickFiles = (): void => {
    setOpen(false);
    setView("main");
    onPickFiles();
  };

  // 点「管理知识库」：关菜单 + 由面板派发 tagent:open-knowledge-bases
  const handleManage = (): void => {
    setOpen(false);
    setView("main");
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "shrink-0 rounded-xl text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
            kbActive && "text-primary hover:text-primary",
            className,
          )}
          aria-label="添加附件与知识库"
        >
          <Plus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("p-0", view === "kb" ? "w-72" : "w-48")}
      >
        {view === "main" ? (
          <div className="flex flex-col gap-0.5 p-1.5">
            <MenuPopoverItem
              icon={<Paperclip className="size-4" />}
              label="图片 / 文件"
              onClick={handlePickFiles}
            />
            {showKnowledgeBase && (
              <>
                <MenuPopoverSeparator />
                <MenuPopoverItem
                  icon={
                    <BookOpen
                      className={cn("size-4", kbActive && "text-primary")}
                    />
                  }
                  label={
                    <span className={cn(kbActive && "text-primary")}>
                      知识库
                    </span>
                  }
                  trailing={
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  }
                  onClick={() => setView("kb")}
                />
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col">
            <button
              type="button"
              className="flex h-9 w-full items-center gap-1.5 border-b border-border/40 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04]"
              onClick={() => setView("main")}
            >
              <ChevronLeft className="size-3.5 text-muted-foreground" />
              知识库
            </button>
            <KnowledgeBasePanel sessionId={sessionId} onManage={handleManage} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
