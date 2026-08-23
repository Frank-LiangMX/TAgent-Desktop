// @vitest-environment jsdom
/**
 * SessionBotBar「明示进房」切片测试（14-SESSION-COLLAB-BRIDGE-SPEC §1）。
 *
 * 遵循「不引入 @testing-library」约定：根级 react-dom/client + react act 自测。
 * - 选满 ≥2 Bot 不再静默调 enterCollaborationWithBridge / 旧 upgradeFusionSessionToRoom。
 * - 「开启协作」按钮点击只开确认框（confirm-gated），不直接 IPC。
 * - 确认后才调 enterCollaborationWithBridge({ sessionId, userConfirmed: true })。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import type { BotProfileRecord } from "@tagent/shared";
import { SessionBotBar } from "./SessionBotBar";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Mount {
  container: HTMLDivElement;
  root: Root;
  unmount(): void;
}

function mount(jsx: React.ReactElement): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(jsx);
  });
  return {
    container,
    root,
    unmount() {
      act(() => {
        root.unmount();
      });
      document.body.removeChild(container);
    },
  };
}

/** 刷新已 resolve 的 promise + 一个宏任务，等 IPC mock 的 effect / async 链落定。 */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {});
}

function mkBot(id: string, displayName: string): BotProfileRecord {
  return {
    profile: {
      id,
      displayName,
      description: `${displayName} 描述`,
      currentConfigRevisionId: `${id}_rev`,
    },
    revisions: [{ id: `${id}_rev`, roleSnapshot: { description: "测试角色" } }],
  } as unknown as BotProfileRecord;
}

const BOTS = [mkBot("b1", "小明"), mkBot("b2", "小红")];

interface ElectronApiOverrides {
  enterCollaborationWithBridge?: ReturnType<typeof vi.fn>;
  upgradeFusionSessionToRoom?: ReturnType<typeof vi.fn>;
}

function installElectronApi(
  over: ElectronApiOverrides = {},
): {
  enterCollaborationWithBridge: ReturnType<typeof vi.fn>;
  upgradeFusionSessionToRoom: ReturnType<typeof vi.fn>;
} {
  const enterCollaborationWithBridge = vi.fn().mockResolvedValue({
    roomId: "room_1",
    sourceSessionId: "s1",
    brief: {},
    briefSource: "heuristic",
    reusedExistingRoom: false,
  });
  const upgradeFusionSessionToRoom = vi.fn().mockResolvedValue({ id: "room_1" });
  const electronAPI = {
    listBots: vi.fn().mockResolvedValue(BOTS),
    updateSessionMeta: vi.fn().mockResolvedValue(undefined),
    enterCollaborationWithBridge,
    upgradeFusionSessionToRoom,
    ...over,
  };
  (window as unknown as { electronAPI: typeof electronAPI }).electronAPI =
    electronAPI;
  return { enterCollaborationWithBridge, upgradeFusionSessionToRoom };
}

function mountBar(props: {
  botProfileIds?: string[];
  fusionRoomId?: string;
}): Mount {
  return mount(
    <SessionBotBar
      sessionId="s1"
      botProfileIds={props.botProfileIds ?? []}
      fusionRoomId={props.fusionRoomId}
    />,
  );
}

let originalBody: string;
beforeEach(() => {
  originalBody = document.body.innerHTML;
});
afterEach(() => {
  document.body.innerHTML = originalBody;
});

describe("SessionBotBar 明示进房", () => {
  test("选满 2 Bot 不再静默升级（无 enter / 旧 upgrade 自动调用）", async () => {
    const { enterCollaborationWithBridge, upgradeFusionSessionToRoom } =
      installElectronApi();

    const m = mountBar({ botProfileIds: ["b1", "b2"] });
    await flushAsync();

    // 2 Bot 已就位：不自动调进房，旧静默升级路径也断开。
    expect(enterCollaborationWithBridge).not.toHaveBeenCalled();
    expect(upgradeFusionSessionToRoom).not.toHaveBeenCalled();
    // 「开启协作」按钮可见（confirm-gated 入口）。
    expect(m.container.textContent ?? "").toContain("开启协作");
    m.unmount();
  });

  test("点「开启协作」只开确认框，不直接 IPC", async () => {
    const { enterCollaborationWithBridge } = installElectronApi();

    const m = mountBar({ botProfileIds: ["b1", "b2"] });
    await flushAsync();

    const trigger = Array.from(m.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "开启协作",
    );
    expect(trigger).toBeTruthy();
    act(() => {
      trigger!.click();
    });
    await flushAsync();

    // 确认框打开（Radix AlertDialog 挂到 body），但尚未调 IPC。
    expect(document.body.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(enterCollaborationWithBridge).not.toHaveBeenCalled();
    m.unmount();
  });

  test("确认后才调 enterCollaborationWithBridge 且带 userConfirmed:true", async () => {
    const { enterCollaborationWithBridge } = installElectronApi();

    const m = mountBar({ botProfileIds: ["b1", "b2"] });
    await flushAsync();

    const trigger = Array.from(m.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "开启协作",
    );
    act(() => {
      trigger!.click();
    });
    await flushAsync();

    const dialog = document.body.querySelector('[role="alertdialog"]');
    const confirmBtn = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find(
      (b) =>
        (b.textContent ?? "").includes("开启协作") &&
        !b.hasAttribute("disabled"),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
    });
    await flushAsync();

    expect(enterCollaborationWithBridge).toHaveBeenCalledTimes(1);
    expect(enterCollaborationWithBridge).toHaveBeenCalledWith({
      sessionId: "s1",
      userConfirmed: true,
    });
    m.unmount();
  });
});
