// @vitest-environment jsdom
/**
 * FusionRoomRemotePage 组件单测（P2-2）。
 *
 * 遵循「不引入 @testing-library」约定：根级 react-dom/client + react act 自测。
 * 用 mock controller（满足 FusionRoomActionAdapter 所需 controller 表面）驱动远程页，
 * 验证 owner-only 编辑闸门（view.canEditMetadata）：owner 见标题/目标编辑按钮、非 owner 不见；
 * owner 编辑目标经 actions.updateMetadata 派发 update-metadata（roomId + goal，不含 actorUserId）。
 * 不触真实 HTTP / Electron GUI。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import type { FusionRoomRemoteSession } from "./fusion-room-remote-session";
import type { FusionRoomViewModel } from "./fusion-room-view-model";
import { FusionRoomRemotePage } from "./FusionRoomRemotePage";

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function mkView(over: Partial<FusionRoomViewModel> = {}): FusionRoomViewModel {
  return {
    roomId: "room-remote",
    title: "远程房间",
    goal: "原目标",
    ownerUserId: "owner",
    canEditMetadata: false,
    status: "active",
    humanMembers: [],
    bots: [],
    messages: [],
    workspace: {
      id: "ws",
      roomId: "room-remote",
      kind: "server",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    files: [],
    locks: [],
    runs: [],
    tasks: [],
    artifacts: [],
    approvals: [],
    mailbox: [],
    continuations: [],
    lastSequence: 1,
    ...over,
  };
}

interface MockSession {
  session: FusionRoomRemoteSession;
  dispatch: ReturnType<typeof vi.fn>;
}

function mkSession(view: FusionRoomViewModel): MockSession {
  const listeners = new Set<(next: FusionRoomViewModel) => void>();
  const dispatch = vi.fn(async (_action: unknown) => {});
  const controller = {
    currentView: view,
    subscribe: vi.fn((listener: (next: FusionRoomViewModel) => void) => {
      listeners.add(listener);
      listener(view);
      return () => {
        listeners.delete(listener);
      };
    }),
    load: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    dispatch,
    close: vi.fn(async () => {}),
  };
  const session = {
    client: { downloadPublishedFile: vi.fn(async () => new ArrayBuffer(0)) },
    adapter: {},
    controller,
    close: () => controller.close(),
  } as unknown as FusionRoomRemoteSession;
  return { session, dispatch };
}

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

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`未找到文案为 ${text} 的按钮`);
  return btn;
}

/** 在 React 受控 textarea 上可靠写入 value（jsdom 下需走原生 setter 触发 onChange）。 */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let originalBody: string;
beforeEach(() => {
  originalBody = document.body.innerHTML;
});
afterEach(() => {
  document.body.innerHTML = originalBody;
});

describe("FusionRoomRemotePage metadata edit (P2-2)", () => {
  test("owner（canEditMetadata=true）见标题与目标编辑按钮", async () => {
    const { session } = mkSession(mkView({ canEditMetadata: true }));
    const m = mount(<FusionRoomRemotePage session={session} onClose={vi.fn()} />);
    await act(async () => {});
    expect(
      m.container.querySelector('button[aria-label="编辑标题"]'),
    ).toBeTruthy();
    expect(
      m.container.querySelector('button[aria-label="编辑目标"]'),
    ).toBeTruthy();
    // goal 独立一行，未拼进 debug 串
    expect(m.container.textContent).toContain("目标：原目标");
    m.unmount();
  });

  test("非 owner（canEditMetadata=false）不见编辑按钮（只读）", async () => {
    const { session } = mkSession(mkView({ canEditMetadata: false }));
    const m = mount(<FusionRoomRemotePage session={session} onClose={vi.fn()} />);
    await act(async () => {});
    expect(
      m.container.querySelector('button[aria-label="编辑标题"]'),
    ).toBeNull();
    expect(
      m.container.querySelector('button[aria-label="编辑目标"]'),
    ).toBeNull();
    // 目标仍以只读形式展示
    expect(m.container.textContent).toContain("目标：原目标");
    m.unmount();
  });

  test("owner 编辑目标 → 经 actions.updateMetadata 派发 update-metadata（roomId + goal，无 actorUserId）", async () => {
    const { session, dispatch } = mkSession(
      mkView({ canEditMetadata: true, goal: "原目标" }),
    );
    const m = mount(<FusionRoomRemotePage session={session} onClose={vi.fn()} />);
    await act(async () => {});

    // 打开目标编辑弹层
    await act(async () => {
      m.container.querySelector<HTMLButtonElement>(
        'button[aria-label="编辑目标"]',
      )!.click();
    });
    const dialog = m.container.querySelector('[role="dialog"]');
    const textarea = dialog?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).toBeTruthy();
    setTextareaValue(textarea!, "新目标内容");

    await act(async () => {
      findButton(m.container, "保存").click();
    });
    // flush fire-and-forget submitMetadataGoal 的 await 链
    await act(async () => {});

    expect(dispatch).toHaveBeenCalledWith({
      type: "update-metadata",
      input: { roomId: "room-remote", goal: "新目标内容" },
    });
    // wire payload 绝不含 actorUserId
    const call = dispatch.mock.calls[0]![0] as { type: string; input: Record<string, unknown> };
    expect("actorUserId" in call).toBe(false);
    expect("actorUserId" in call.input).toBe(false);
    m.unmount();
  });

  test("owner 编辑标题 → 派发 update-metadata（roomId + title）", async () => {
    const { session, dispatch } = mkSession(
      mkView({ canEditMetadata: true, title: "远程房间" }),
    );
    const m = mount(<FusionRoomRemotePage session={session} onClose={vi.fn()} />);
    await act(async () => {});

    await act(async () => {
      m.container.querySelector<HTMLButtonElement>(
        'button[aria-label="编辑标题"]',
      )!.click();
    });
    const dialog = m.container.querySelector('[role="dialog"]');
    const input = dialog?.querySelector<HTMLInputElement>("input");
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input!, "新标题");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      findButton(m.container, "保存").click();
    });
    await act(async () => {});

    expect(dispatch).toHaveBeenCalledWith({
      type: "update-metadata",
      input: { roomId: "room-remote", title: "新标题" },
    });
    m.unmount();
  });
});
