// @vitest-environment jsdom
/**
 * 协作室「待确认续跑」列表组件单测（P2-1）。
 *
 * 遵循「不引入 @testing-library」约定：根级 react-dom/client + react act 自测。
 * 组件为纯展示（不触 IPC、不引重型依赖），直接渲染 + 断言文案 / 按钮交互 / loading / error 态。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import type { LocalCollaborationContinuationItem } from "@tagent/shared";
import {
  CollaborationContinuationList,
  continuationReadonlyHint,
} from "./CollaborationContinuationList";

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

function mkItem(
  over: Partial<LocalCollaborationContinuationItem> & {
    id: string;
    kind: LocalCollaborationContinuationItem["kind"];
  },
): LocalCollaborationContinuationItem {
  return {
    roomId: "cr_1",
    requiresUserConfirm: false,
    summary: "摘要",
    ...over,
  };
}

let originalBody: string;
beforeEach(() => {
  originalBody = document.body.innerHTML;
});
afterEach(() => {
  document.body.innerHTML = originalBody;
});

describe("CollaborationContinuationList", () => {
  test("空列表 → 不渲染", () => {
    const m = mount(
      <CollaborationContinuationList
        continuations={[]}
        resumingRunId={null}
        resumeErrorByRun={{}}
        onConfirmResume={vi.fn()}
      />,
    );
    expect(m.container.querySelector(".collab-continuations")).toBeNull();
    m.unmount();
  });

  test("blocked_run → 渲染 label + summary + tail + 「确认继续」按钮", () => {
    const onConfirm = vi.fn();
    const m = mount(
      <CollaborationContinuationList
        continuations={[
          mkItem({
            id: "run_blk1234",
            kind: "blocked_run",
            requiresUserConfirm: true,
            summary: "中断的 run，需确认续跑",
            refs: { runId: "run_blk1234", memberId: "cm_a" },
          }),
        ]}
        resumingRunId={null}
        resumeErrorByRun={{}}
        onConfirmResume={onConfirm}
      />,
    );
    const el = m.container.querySelector(".collab-continuations")!;
    expect(el).toBeTruthy();
    expect(el.textContent).toContain("待确认续跑 · 1");
    expect(el.textContent).toContain("中断的运行");
    expect(el.textContent).toContain("中断的 run，需确认续跑");
    expect(el.textContent).toContain("#_blk1234");
    const btn = m.container.querySelector<HTMLButtonElement>(
      'button[data-run-id="run_blk1234"]',
    )!;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("确认继续");
    expect(btn.disabled).toBe(false);
    act(() => {
      btn.click();
    });
    expect(onConfirm).toHaveBeenCalledWith("run_blk1234");
    m.unmount();
  });

  test("resumingRunId 命中 → 按钮显示「确认中…」并禁用", () => {
    const m = mount(
      <CollaborationContinuationList
        continuations={[
          mkItem({
            id: "run_x",
            kind: "blocked_run",
            requiresUserConfirm: true,
            refs: { runId: "run_x" },
          }),
        ]}
        resumingRunId="run_x"
        resumeErrorByRun={{}}
        onConfirmResume={vi.fn()}
      />,
    );
    const btn = m.container.querySelector<HTMLButtonElement>(
      'button[data-run-id="run_x"]',
    )!;
    expect(btn.textContent).toContain("确认中…");
    expect(btn.disabled).toBe(true);
    m.unmount();
  });

  test("resumeErrorByRun 命中 → 渲染行内错误", () => {
    const m = mount(
      <CollaborationContinuationList
        continuations={[
          mkItem({
            id: "run_x",
            kind: "blocked_run",
            requiresUserConfirm: true,
            refs: { runId: "run_x" },
          }),
        ]}
        resumingRunId={null}
        resumeErrorByRun={{ run_x: "房间未激活" }}
        onConfirmResume={vi.fn()}
      />,
    );
    expect(m.container.textContent).toContain("房间未激活");
    m.unmount();
  });

  test("pending_approval / depth_stop → 只读提示，无按钮，下钻既有卡片", () => {
    const m = mount(
      <CollaborationContinuationList
        continuations={[
          mkItem({
            id: "ap_1",
            kind: "pending_approval",
            requiresUserConfirm: true,
            summary: "是否继续？",
            refs: { approvalId: "ap_1", runId: "run_a" },
          }),
          mkItem({
            id: "env_ds",
            kind: "depth_stop",
            requiresUserConfirm: true,
            refs: { envelopeId: "env_ds" },
          }),
        ]}
        resumingRunId={null}
        resumeErrorByRun={{}}
        onConfirmResume={vi.fn()}
      />,
    );
    expect(m.container.textContent).toContain("待审批");
    expect(m.container.textContent).toContain("请使用下方审批卡片处理");
    expect(m.container.textContent).toContain("深度停止");
    expect(m.container.textContent).toContain("请使用下方深度停止卡片继续");
    expect(m.container.querySelector("button")).toBeNull();
    m.unmount();
  });

  test("awaiting_peer / awaiting_user / mailbox_outbox → 纯观察提示", () => {
    const m = mount(
      <CollaborationContinuationList
        continuations={[
          mkItem({ id: "run_p", kind: "awaiting_peer", refs: { runId: "run_p" } }),
          mkItem({ id: "run_u", kind: "awaiting_user", refs: { runId: "run_u" } }),
          mkItem({
            id: "env_o",
            kind: "mailbox_outbox",
            refs: { envelopeId: "env_o" },
          }),
        ]}
        resumingRunId={null}
        resumeErrorByRun={{}}
        onConfirmResume={vi.fn()}
      />,
    );
    expect(m.container.textContent).toContain("等待成员回复");
    expect(m.container.textContent).toContain("等待用户审批（见下方审批卡片）");
    expect(m.container.textContent).toContain("未投递消息（重启已尝试安全重投）");
    expect(m.container.querySelector("button")).toBeNull();
    m.unmount();
  });

  test("continuationReadonlyHint：各 kind 文案", () => {
    expect(continuationReadonlyHint("pending_approval")).toBe(
      "请使用下方审批卡片处理",
    );
    expect(continuationReadonlyHint("depth_stop")).toBe(
      "请使用下方深度停止卡片继续",
    );
    expect(continuationReadonlyHint("awaiting_user")).toBe(
      "等待用户审批（见下方审批卡片）",
    );
    expect(continuationReadonlyHint("awaiting_peer")).toBe("等待成员回复");
    expect(continuationReadonlyHint("mailbox_outbox")).toBe(
      "未投递消息（重启已尝试安全重投）",
    );
    // blocked_run 不走只读提示（有「确认继续」按钮），hint 为空
    expect(continuationReadonlyHint("blocked_run")).toBe("");
  });
});
