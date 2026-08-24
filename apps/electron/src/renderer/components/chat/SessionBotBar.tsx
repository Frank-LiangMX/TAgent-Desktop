import { useEffect, useMemo, useState } from "react";
import {
  Bot as BotIcon,
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import type { BotProfileRecord } from "@tagent/shared";
import {
  AppTooltip,
  Button,
  DestructiveConfirmDialog,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@tagent/ui";

export const BOT_RAIL_VISIBILITY_EVENT = "tagent:bot-rail-visibility";
const BOT_RAIL_VISIBILITY_STORAGE_KEY = "tagent:bot-rail-visible";

export function readBotRailVisibility(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(BOT_RAIL_VISIBILITY_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

export function setBotRailVisibility(visible: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      BOT_RAIL_VISIBILITY_STORAGE_KEY,
      String(visible),
    );
  } catch {
    // localStorage may be unavailable in restricted environments; the event still updates this window.
  }
  window.dispatchEvent(
    new CustomEvent(BOT_RAIL_VISIBILITY_EVENT, {
      detail: { visible },
    }),
  );
}

export interface SessionBotBarProps {
  sessionId: string;
  botProfileIds?: string[];
  fusionRoomId?: string;
  onOpenBot?: (record: BotProfileRecord) => void;
  variant?: "inline" | "rail";
}

/**
 * 会话级 Bot 参与者条。
 * 这里只保存会话对 BotProfile 的引用；Bot 的长期配置仍归 Bot 库所有。
 */
export function SessionBotBar({
  sessionId,
  botProfileIds,
  fusionRoomId,
  onOpenBot,
  variant = "inline",
}: SessionBotBarProps): JSX.Element {
  const [records, setRecords] = useState<BotProfileRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(botProfileIds ?? []);
  const [open, setOpen] = useState(false);
  const [railVisible, setRailVisible] = useState(readBotRailVisibility);
  const [railExpanded, setRailExpanded] = useState(false);
  /** 「开启协作」确认框：明示进房前必须用户确认，禁止静默自动升级（14 §1）。 */
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const handleVisibilityChange = (event: Event): void => {
      const visible = (event as CustomEvent<{ visible?: boolean }>).detail
        ?.visible;
      if (typeof visible === "boolean") setRailVisible(visible);
    };
    window.addEventListener(BOT_RAIL_VISIBILITY_EVENT, handleVisibilityChange);
    return () =>
      window.removeEventListener(
        BOT_RAIL_VISIBILITY_EVENT,
        handleVisibilityChange,
      );
  }, []);

  useEffect(() => {
    setSelectedIds(botProfileIds ?? []);
  }, [botProfileIds]);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI
      .listBots()
      .then((items) => {
        if (!disposed) setRecords(items);
      })
      .catch(() => {
        if (!disposed) setRecords([]);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId]);

  const selectedRecords = useMemo(
    () =>
      selectedIds
        .map((id) => records.find((item) => item.profile.id === id))
        .filter((item): item is BotProfileRecord => Boolean(item)),
    [records, selectedIds],
  );

  const toggleBot = async (profileId: string): Promise<void> => {
    if (fusionRoomId) {
      window.alert("当前会话已升级为协作室，请在协作室中管理成员");
      return;
    }
    const nextIds = selectedIds.includes(profileId)
      ? selectedIds.filter((id) => id !== profileId)
      : [...selectedIds, profileId];
    try {
      await window.electronAPI.updateSessionMeta(sessionId, {
        botProfileIds: nextIds,
      });
      setSelectedIds(nextIds);
      setOpen(false);
      // 选满 ≥2 Bot 不再静默升级为协作室；用户须明示点「开启协作」并确认（14 §1）。
    } catch {
      window.alert("Bot 参与者保存失败，请稍后重试");
    }
  };

  /**
   * 明示进房（14 §1）：用户确认后调 enter-with-bridge，主进程精炼前情提要写房间
   * goal + 系统消息。成功后由主进程推送 session_meta_changed，usePersistedSessionMeta 重读
   * fusionRoomId → Chat 自动切到协作壳。失败抛错由 DestructiveConfirmDialog 内联提示。
   * 禁止再走旧 upgradeFusionSessionToRoom 静默路径（无精炼桥）。
   */
  const handleEnterCollaboration = async (): Promise<void> => {
    await window.electronAPI.enterCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    window.dispatchEvent(
      new CustomEvent("tagent:session-meta-changed", {
        detail: { sessionId },
      }),
    );
    toast.success("已开启协作", {
      description: "已切换到协作室，单会话历史保留。",
    });
  };

  const availableRecords = records.filter((item) => !item.profile.archivedAt);
  const isRail = variant === "rail";

  return (
    <div
      className={
        isRail ? "session-bot-rail session-glass-rail" : "session-bot-bar"
      }
      data-expanded={isRail && railExpanded ? "true" : "false"}
      data-visible={isRail ? (railVisible ? "true" : "false") : undefined}
      role={isRail ? "region" : "status"}
      aria-label={isRail ? "会话 Bot" : undefined}
      aria-hidden={isRail && !railVisible ? true : undefined}
      aria-live={isRail ? undefined : "polite"}
    >
      {isRail ? (
        <div className="session-bot-rail__header">
          {railExpanded ? (
            <span className="session-bot-rail__title">Bot</span>
          ) : null}
          <button
            type="button"
            className="session-bot-rail__toggle"
            aria-label={railExpanded ? "收起 Bot 栏" : "展开 Bot 栏"}
            aria-expanded={railExpanded}
            onClick={() => setRailExpanded((current) => !current)}
          >
            {railExpanded ? (
              <ChevronRight aria-hidden />
            ) : (
              <ChevronLeft aria-hidden />
            )}
          </button>
        </div>
      ) : (
        <>
          <BotIcon className="session-bot-bar__icon" aria-hidden />
          <span className="session-bot-bar__label">Bot</span>
        </>
      )}
      {isRail ? (
        <div className="session-bot-rail__members">
          {selectedRecords.map((item) => (
            <AppTooltip
              key={item.profile.id}
              label={item.profile.displayName}
              side="left"
              sideOffset={8}
            >
              <button
                type="button"
                className="session-bot-rail__member"
                onClick={() => onOpenBot?.(item)}
                aria-label={"打开 " + item.profile.displayName + " 旁路窗口"}
              >
                <span className="session-bot-rail__avatar" aria-hidden>
                  {item.profile.displayName.trim().charAt(0) || "B"}
                </span>
                {railExpanded ? (
                  <span className="session-bot-rail__member-name">
                    @{item.profile.displayName}
                    {item.profile.archivedAt ? "（已归档）" : ""}
                  </span>
                ) : null}
              </button>
            </AppTooltip>
          ))}
        </div>
      ) : selectedRecords.length > 0 ? (
        <div className="session-bot-bar__chips">
          {selectedRecords.map((item) => (
            <button
              type="button"
              className="session-bot-bar__chip"
              key={item.profile.id}
              onClick={() => onOpenBot?.(item)}
              title="打开 Bot 旁路窗口"
            >
              @{item.profile.displayName}
              {item.profile.archivedAt ? "（已归档）" : ""}
            </button>
          ))}
        </div>
      ) : (
        <span className="session-bot-bar__empty">未加入</span>
      )}
      {isRail ? <div className="session-bot-rail__spacer" /> : null}{" "}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={
              isRail ? "session-bot-rail__manage" : "session-bot-bar__trigger"
            }
            aria-label={
              selectedRecords.length > 0 ? "管理本会话 Bot" : "加入 Bot"
            }
          >
            <Plus className="size-3.5" aria-hidden />
            {!isRail || railExpanded
              ? selectedRecords.length > 0
                ? "管理"
                : "加入 Bot"
              : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side={isRail ? "left" : "top"}
          sideOffset={8}
          className="session-bot-picker w-80 p-2"
        >
          <div className="session-bot-picker__title">本会话 Bot</div>
          <div className="session-bot-picker__hint">
            Bot 仅作为独立旁路窗口参与当前会话；加入 2 个及以上 Bot
            后，可点「开启协作」进入协作模式。
          </div>
          {availableRecords.length === 0 &&
          selectedRecords.every((item) => !item.profile.archivedAt) ? (
            <div className="session-bot-picker__empty">
              Bot 库暂无可用 Bot，请先在角色库创建。
            </div>
          ) : (
            <div className="session-bot-picker__list">
              {records.map((item) => {
                const selected = selectedIds.includes(item.profile.id);
                const archived = Boolean(item.profile.archivedAt);
                return (
                  <button
                    type="button"
                    className="session-bot-picker__item"
                    key={item.profile.id}
                    onClick={() => {
                      if (!archived || selected)
                        void toggleBot(item.profile.id);
                    }}
                  >
                    <span className="session-bot-picker__item-main">
                      <span className="session-bot-picker__item-name">
                        {item.profile.displayName}
                        {archived ? "（已归档）" : ""}
                      </span>
                      <span className="session-bot-picker__item-description">
                        {archived
                          ? "已归档，只能从本会话移除"
                          : item.profile.description || "未填写描述"}
                      </span>
                    </span>
                    {selected ? (
                      <Check
                        className="size-4 text-primary"
                        aria-label="已加入"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {selectedRecords.length >= 2 && !fusionRoomId ? (
        <Button
          variant="ghost"
          size="sm"
          className={
            isRail
              ? "session-bot-rail__collaborate"
              : "session-bot-bar__trigger"
          }
          onClick={() => setConfirmOpen(true)}
          title="开启协作，把当前会话升级为协作室"
          aria-label="开启协作"
        >
          {isRail && !railExpanded ? "协" : "开启协作"}
        </Button>
      ) : null}
      <DestructiveConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="开启协作？"
        description={
          <>
            <p className="mb-1">将为当前会话创建协作室，单会话历史保留。</p>
            <p>
              会把近期对话精炼为前情提要交给协作成员；协作期间在本标签内使用协作界面。
            </p>
          </>
        }
        confirmLabel="开启协作"
        pendingLabel="正在开启协作…"
        onConfirm={handleEnterCollaboration}
      />
    </div>
  );
}
