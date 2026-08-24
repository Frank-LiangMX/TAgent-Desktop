/**
 * TabBar — 会话标签栏（多会话 tab，顶对齐 rail/sidebar）
 *
 * 选中态用滑动底板（active-plate）：绝对定位在 tab 列后，JS 测 active tab 位置
 * 驱动 transform 平滑滑动（对齐 TAgent_General updateActivePlate）。
 * tab 本身选中时透明，只 primary 文字/icon；底板显玻璃填充。
 * 状态色点：与侧栏同源（sessionStatus + run + 权限/AskUser 待选择）。
 */
import { useAtomValue, useSetAtom } from "jotai";
import { Bot as BotIcon } from "lucide-react";
import { AppTooltip } from "@tagent/ui";
import { useEffect, useRef, useState } from "react";
import { TabBarItem } from "./TabBarItem";
import {
  tabsAtom,
  activeTabIdAtom,
  closeTab,
  type TabItem,
} from "../../atoms/tabs";
import { dockApiAtom } from "../../atoms/dock-api";
import { usePersistedSessionMeta } from "../../hooks/usePersistedSessionMeta";
import { SessionSummaryTabButton } from "../chat/SessionSummaryTabButton";
import {
  BOT_RAIL_VISIBILITY_EVENT,
  readBotRailVisibility,
  setBotRailVisibility,
} from "../chat/SessionBotBar";
import {
  sessionStatusMapAtom,
  resolveSessionUiStatus,
  type SessionUiStatus,
} from "../../atoms/session-status-atoms";
import { sessionRunMapAtom } from "../../atoms/session-run-atoms";
import { pendingPermissionMapAtom } from "../../atoms/permission-atoms";
import { allPendingAskUserRequestsAtom } from "../../atoms/ask-user-atoms";

export function TabBar(): JSX.Element | null {
  const tabs = useAtomValue(tabsAtom);
  const activeTabId = useAtomValue(activeTabIdAtom);
  const activeSessionMeta = usePersistedSessionMeta(activeTabId ?? undefined);
  const showBotRailAction = Boolean(
    activeSessionMeta && !activeSessionMeta.fusionRoomId,
  );
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTabId = useSetAtom(activeTabIdAtom);
  const dockApi = useAtomValue(dockApiAtom);
  const statusMap = useAtomValue(sessionStatusMapAtom);
  const runMap = useAtomValue(sessionRunMapAtom);
  const pendingPermissionMap = useAtomValue(pendingPermissionMapAtom);
  const pendingAskUserMap = useAtomValue(allPendingAskUserRequestsAtom);

  const [botRailVisible, setBotRailVisible] = useState(readBotRailVisibility);

  const listRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleVisibilityChange = (event: Event): void => {
      const visible = (event as CustomEvent<{ visible?: boolean }>).detail
        ?.visible;
      if (typeof visible === "boolean") setBotRailVisible(visible);
    };
    window.addEventListener(BOT_RAIL_VISIBILITY_EVENT, handleVisibilityChange);
    return () =>
      window.removeEventListener(
        BOT_RAIL_VISIBILITY_EVENT,
        handleVisibilityChange,
      );
  }, []);
  const statusOf = (sessionId: string): SessionUiStatus => {
    const awaitingUser =
      (pendingPermissionMap[sessionId]?.length ?? 0) > 0 ||
      (pendingAskUserMap.get(sessionId)?.length ?? 0) > 0;
    return resolveSessionUiStatus({
      stored: statusMap[sessionId]?.status,
      running: runMap[sessionId]?.running === true,
      awaitingUser,
    });
  };

  // 测 active tab 位置，驱动 plate 滑动
  useEffect(() => {
    const list = listRef.current;
    const plate = plateRef.current;
    if (!list || !plate) return;

    const update = (): void => {
      const active = list.querySelector<HTMLElement>("[data-active]");
      if (!active) {
        plate.style.opacity = "0";
        return;
      }
      plate.style.opacity = "1";
      plate.style.width = `${active.offsetWidth}px`;
      plate.style.transform = `translateX(${active.offsetLeft}px)`;
    };

    update();
    // tab 列变化/active 变化时重测；ResizeObserver 抓容器尺寸变化
    const ro = new ResizeObserver(update);
    ro.observe(list);
    return () => ro.disconnect();
  }, [tabs, activeTabId]);

  if (tabs.length === 0) return null;

  const handleClose = (tab: TabItem): void => {
    const { tabs: next, activeTabId: nextActive } = closeTab(
      tabs,
      activeTabId,
      tab.id,
    );
    setTabs(next);
    setActiveTabId(nextActive);
    // split 模式：reconcile 不再关 orphan，须显式关 panel
    dockApi?.getPanel(tab.sessionId)?.api.close();
  };

  return (
    <div className="app-workspace-tab-strip titlebar-drag-region shrink-0">
      <div
        ref={listRef}
        role="tablist"
        className="app-workspace-tab-list titlebar-no-drag"
      >
        {/* 滑动底板：绝对定位在 tab 列后，opacity/width/transform 由 JS 驱动 */}
        <div ref={plateRef} className="app-workspace-tab-active-plate" />
        {tabs.map((tab) => (
          <TabBarItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            status={statusOf(tab.sessionId)}
            onActivate={() => setActiveTabId(tab.id)}
            onClose={() => handleClose(tab)}
          />
        ))}
      </div>
      <div className="app-workspace-tab-actions titlebar-no-drag">
        {showBotRailAction ? (
          <AppTooltip
            label={botRailVisible ? "隐藏 Bot rail" : "显示 Bot rail"}
            side="bottom"
            sideOffset={6}
          >
            <button
              type="button"
              className="app-workspace-tab-action app-workspace-tab-action--bot"
              aria-label={botRailVisible ? "隐藏 Bot rail" : "显示 Bot rail"}
              aria-pressed={botRailVisible}
              onClick={() => setBotRailVisibility(!botRailVisible)}
            >
              <BotIcon aria-hidden />
            </button>
          </AppTooltip>
        ) : null}
        <SessionSummaryTabButton sessionId={activeTabId} />
      </div>
    </div>
  );
}
