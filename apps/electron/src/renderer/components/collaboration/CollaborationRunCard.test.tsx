// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

vi.mock("@phosphor-icons/react", () => {
  const Stub = (): null => null;
  return { StopCircle: Stub };
});
vi.mock("@tagent/ui", () => ({
  MessageResponse: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  useSmoothStream: ({ content }: { content: string }) => ({
    displayedContent: content,
  }),
}));
vi.mock("./CollaborationAvatars", () => ({
  MemberAvatar: (): null => null,
}));

import type {
  Channel,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRun,
} from "@tagent/shared";
import { CollaborationRunCard } from "./CollaborationRunCard";

function mkMember(over: Partial<CollaborationMember> = {}): CollaborationMember {
  return {
    id: "cm_1",
    roomId: "cr_1",
    displayName: "协调者",
    backend: "kscc-internal",
    isCoordinator: true,
    status: "idle",
    permissionProfile: "workspace-write",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as CollaborationMember;
}

function mkRun(over: Partial<CollaborationRun> = {}): CollaborationRun {
  return {
    id: "run_failed",
    roomId: "cr_1",
    memberId: "cm_1",
    triggerMessageId: "msg_1",
    idempotencyKey: "msg_1:cm_1",
    status: "failed",
    attempt: 1,
    error: { code: "UPSTREAM_FAILED", message: "上游不可用" },
    ...over,
  };
}

interface Mount {
  container: HTMLDivElement;
  unmount(): void;
}

function mount(element: React.ReactElement): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

const channels: Channel[] = [];
const messages: CollaborationMessage[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("CollaborationRunCard 恢复动作", () => {
  test("failed run 显示重试并回调同成员重试", () => {
    const onRetry = vi.fn();
    const m = mount(
      <CollaborationRunCard
        run={mkRun()}
        messages={messages}
        member={mkMember()}
        members={[mkMember()]}
        channels={channels}
        cancelling={false}
        retrying={false}
        onCancel={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(m.container.textContent).toContain("上游不可用");
    const retryButton = Array.from(m.container.querySelectorAll("button")).find(
      (button) => button.textContent === "重试",
    );
    expect(retryButton).toBeTruthy();
    act(() => retryButton!.click());
    expect(onRetry).toHaveBeenCalledWith();
    m.unmount();
  });

  test("多个成员可选择换成员重试", () => {
    const onRetry = vi.fn();
    const reviewer = mkMember({
      id: "cm_2",
      displayName: "审阅者",
      isCoordinator: false,
    });
    const m = mount(
      <CollaborationRunCard
        run={mkRun()}
        messages={messages}
        member={mkMember()}
        members={[mkMember(), reviewer]}
        channels={channels}
        cancelling={false}
        retrying={false}
        onCancel={vi.fn()}
        onRetry={onRetry}
      />,
    );
    const select = m.container.querySelector(
      'select[aria-label="重试执行成员"]',
    ) as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    act(() => {
      select!.value = reviewer.id;
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const switchButton = Array.from(
      m.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "换成员重试");
    expect(switchButton).toBeTruthy();
    act(() => switchButton!.click());
    expect(onRetry).toHaveBeenCalledWith(reviewer.id);
    m.unmount();
  });
});
