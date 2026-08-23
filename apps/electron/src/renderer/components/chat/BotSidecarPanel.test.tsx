// @vitest-environment jsdom
/**
 * Bot 旁路窗口「关闭再打开不丢对话」切片测试。
 *
 * 遵循「不引入 @testing-library」约定：根级 react-dom/client + react act 自测。
 * - 纯函数：sidecarHistoryToMessages / extractSidecarMessageText 兼容 SDK（kscc）与 IR（pi）两种落盘格式。
 * - 组件：打开时以隐藏会话 ID 调用 getMessages 并把历史渲染出来；失败不阻塞、空历史显示空态。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import type { BotProfileRecord } from "@tagent/shared";
import {
  BotSidecarPanel,
  extractSidecarMessageText,
  sidecarHistoryToMessages,
} from "./BotSidecarPanel";

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

/** 刷新所有已 resolve 的 promise + 一个宏任务，等 IPC mock 的 effect 链落定。 */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {});
}

const SDK_USER = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: "你好" }],
  },
  createdAt: 1000,
};

const SDK_ASSISTANT = {
  type: "assistant",
  message: {
    content: [{ type: "text", text: "我是 Bot" }],
    stop_reason: "end_turn",
  },
  uuid: "uuid-1",
  createdAt: 2000,
};

const IR_USER = {
  type: "user",
  content: [{ type: "text", text: "直接问" }],
  createdAt: 3000,
};

const IR_ASSISTANT = {
  type: "assistant",
  content: [{ type: "text", text: "直接答" }],
  uuid: "uuid-2",
  createdAt: 4000,
};

const TOOL_ONLY = {
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "workspace_read_file" }],
  },
};

const RESULT = { type: "result", usage: {} };

function mkBot(): BotProfileRecord {
  return {
    profile: {
      id: "bot_1",
      displayName: "小明",
      description: "测试 Bot",
      currentConfigRevisionId: "rev_1",
    },
    revisions: [
      {
        id: "rev_1",
        roleSnapshot: { description: "测试角色" },
      },
    ],
  } as unknown as BotProfileRecord;
}

interface ElectronApiOverrides {
  getMessages?: ReturnType<typeof vi.fn>;
  openBotSidecar?: ReturnType<typeof vi.fn>;
}

function installElectronApi(over: ElectronApiOverrides = {}): void {
  const electronAPI = {
    openBotSidecar: vi.fn().mockResolvedValue({
      sidecarId: "sidecar_1",
      sessionId: "s1",
      botProfileId: "bot_1",
      agentSessionId: "bot_sidecar_s1_bot_1",
      lifecycle: "open",
      openedAt: 1,
      updatedAt: 1,
    }),
    closeBotSidecar: vi.fn().mockResolvedValue(null),
    minimizeBotSidecar: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    requestBotSidecarBridge: vi.fn().mockResolvedValue({
      ok: true,
      accepted: true,
    }),
    steerAgent: vi.fn().mockResolvedValue({ ok: true }),
    onStreamEvent: vi.fn().mockReturnValue(() => {}),
    ...over,
  };
  (window as unknown as { electronAPI: typeof electronAPI }).electronAPI =
    electronAPI;
}

function mountPanel(): Mount {
  return mount(
    <BotSidecarPanel
      sessionId="s1"
      bot={mkBot()}
      contextText="主会话上下文"
      fallbackChannelId="channel_x"
      fallbackModelId="model_x"
      onClose={vi.fn()}
    />,
  );
}

let originalBody: string;
beforeEach(() => {
  originalBody = document.body.innerHTML;
  installElectronApi();
});

afterEach(() => {
  document.body.innerHTML = originalBody;
});

describe("extractSidecarMessageText", () => {
  test("SDK（kscc）user/assistant 提取文本", () => {
    expect(extractSidecarMessageText(SDK_USER)).toEqual({
      role: "user",
      text: "你好",
    });
    expect(extractSidecarMessageText(SDK_ASSISTANT)).toEqual({
      role: "assistant",
      text: "我是 Bot",
    });
  });

  test("IR（pi）user/assistant 提取文本", () => {
    expect(extractSidecarMessageText(IR_USER)).toEqual({
      role: "user",
      text: "直接问",
    });
    expect(extractSidecarMessageText(IR_ASSISTANT)).toEqual({
      role: "assistant",
      text: "直接答",
    });
  });

  test("无文本 / 非 user-assistant 行返回 null", () => {
    expect(extractSidecarMessageText(TOOL_ONLY)).toBeNull();
    expect(extractSidecarMessageText(RESULT)).toBeNull();
    expect(extractSidecarMessageText(null)).toBeNull();
    expect(extractSidecarMessageText(undefined)).toBeNull();
  });
});

describe("sidecarHistoryToMessages", () => {
  test("混合 SDK + IR 历史按序映射，tool/result 行跳过", () => {
    const items = sidecarHistoryToMessages([
      SDK_USER,
      SDK_ASSISTANT,
      TOOL_ONLY,
      IR_USER,
      IR_ASSISTANT,
      RESULT,
    ]);
    expect(items).toEqual([
      { id: "hist-0-1000", role: "user", text: "你好" },
      { id: "hist-1-uuid-1", role: "assistant", text: "我是 Bot" },
      { id: "hist-3-3000", role: "user", text: "直接问" },
      { id: "hist-4-uuid-2", role: "assistant", text: "直接答" },
    ]);
  });

  test("空历史 / 全跳过行 → 空列表", () => {
    expect(sidecarHistoryToMessages([])).toEqual([]);
    expect(sidecarHistoryToMessages([TOOL_ONLY, RESULT])).toEqual([]);
  });
});

describe("BotSidecarPanel 历史加载", () => {
  test("打开时用隐藏会话 ID 读取历史并渲染两种格式", async () => {
    const getMessages = vi
      .fn()
      .mockResolvedValue([SDK_USER, SDK_ASSISTANT, IR_USER, IR_ASSISTANT]);
    installElectronApi({ getMessages });

    const m = mountPanel();
    await flushAsync();

    expect(getMessages).toHaveBeenCalledWith("bot_sidecar_s1_bot_1");
    const text = m.container.textContent ?? "";
    expect(text).toContain("你好");
    expect(text).toContain("我是 Bot");
    expect(text).toContain("直接问");
    expect(text).toContain("直接答");
    expect(
      m.container.querySelectorAll(".bot-sidecar-panel__message--user"),
    ).toHaveLength(2);
    expect(
      m.container.querySelectorAll(".bot-sidecar-panel__message--assistant"),
    ).toHaveLength(2);
    m.unmount();
  });

  test("历史为空 → 显示空态，不渲染气泡", async () => {
    const m = mountPanel();
    await flushAsync();

    expect(m.container.textContent).toContain("开始对话");
    expect(
      m.container.querySelectorAll(".bot-sidecar-panel__message"),
    ).toHaveLength(0);
    m.unmount();
  });

  test("读取历史失败 → 显示错误提示且不崩溃，仍可继续使用弹窗", async () => {
    const getMessages = vi.fn().mockRejectedValue(new Error("磁盘读失败"));
    installElectronApi({ getMessages });

    const m = mountPanel();
    await flushAsync();

    expect(m.container.textContent).toContain("读取 Bot 历史对话失败");
    expect(m.container.querySelector(".bot-sidecar-panel__composer")).toBeTruthy();
    m.unmount();
  });
});
