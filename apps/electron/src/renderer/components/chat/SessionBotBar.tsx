import { useEffect, useMemo, useState } from "react";
import { Bot as BotIcon, Check, Plus } from "lucide-react";
import type { BotProfileRecord } from "@tagent/shared";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@tagent/ui";

export interface SessionBotBarProps {
  sessionId: string;
  botProfileIds?: string[];
  fusionRoomId?: string;
  onOpenBot?: (record: BotProfileRecord) => void;
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
}: SessionBotBarProps): JSX.Element {
  const [records, setRecords] = useState<BotProfileRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(botProfileIds ?? []);
  const [open, setOpen] = useState(false);

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
      if (nextIds.length >= 2) {
        await upgradeToRoom(nextIds.length);
      }
    } catch {
      window.alert("Bot 参与者保存失败，请稍后重试");
    }
  };

  const upgradeToRoom = async (selectedCount = selectedRecords.length): Promise<void> => {
    if (selectedCount < 2) return;
    try {
      const room = await window.electronAPI.upgradeFusionSessionToRoom({
        sessionId,
      });
      window.dispatchEvent(
        new CustomEvent("tagent:open-collaboration-room", {
          detail: { roomId: room.id, sessionId },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("tagent:session-meta-changed", {
          detail: { sessionId },
        }),
      );
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(message || "升级为协作室失败，请稍后重试");
    }
  };

  const availableRecords = records.filter((item) => !item.profile.archivedAt);

  return (
    <div className="session-bot-bar" role="status" aria-live="polite">
      <BotIcon className="session-bot-bar__icon" aria-hidden />
      <span className="session-bot-bar__label">Bot</span>
      {selectedRecords.length > 0 ? (
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="session-bot-bar__trigger"
          >
            <Plus className="size-3.5" aria-hidden />
            {selectedRecords.length > 0 ? "管理" : "加入 Bot"}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="session-bot-picker w-80 p-2"
        >
          <div className="session-bot-picker__title">本会话 Bot</div>
          <div className="session-bot-picker__hint">
            1 个 Bot 直接作为当前对话对象；多个 Bot 将进入融合会话路由。
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
      {selectedRecords.length >= 2 ? (
        <Button
          variant="ghost"
          size="sm"
          className="session-bot-bar__trigger"
          onClick={() => void upgradeToRoom()}
          title={
            fusionRoomId
              ? "打开已关联协作室"
              : "复用现有协作室能力，升级当前融合会话"
          }
        >
          {fusionRoomId ? "打开协作" : "升级为协作"}
        </Button>
      ) : null}
    </div>
  );
}
