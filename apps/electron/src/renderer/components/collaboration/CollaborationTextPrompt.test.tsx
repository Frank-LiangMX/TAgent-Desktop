// @vitest-environment jsdom
/**
 * CollaborationTextPrompt 组件单测（P2-2）。
 *
 * 遵循「不引入 @testing-library」约定：根级 react-dom/client + react act 自测。
 * 覆盖新增能力：multiline（Textarea）、allowEmpty（允许清空）、pending（busy）、error（弹层内错误）。
 * 默认分支（单行 + 拒绝空串）保持与既有重命名弹层一致。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { CollaborationTextPrompt } from "./CollaborationTextPrompt";

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

/** 在 React 受控输入上可靠写入 value（jsdom 下需走原生 setter 触发 onChange）。 */
function setInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`未找到文案为 ${text} 的按钮`);
  return btn;
}

let originalBody: string;
beforeEach(() => {
  originalBody = document.body.innerHTML;
});
afterEach(() => {
  document.body.innerHTML = originalBody;
});

describe("CollaborationTextPrompt", () => {
  test("默认单行：渲染 Input（无 Textarea），空值时确认按钮禁用", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(m.container.querySelector("input")).toBeTruthy();
    expect(m.container.querySelector("textarea")).toBeNull();
    expect(findButton(m.container, "确定").disabled).toBe(true);
    m.unmount();
  });

  test("默认单行：输入非空后 Enter 提交 trim 后的值", () => {
    const onConfirm = vi.fn();
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue=""
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const input = m.container.querySelector("input")!;
    setInputValue(input, "  hello  ");
    expect(findButton(m.container, "确定").disabled).toBe(false);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onConfirm).toHaveBeenCalledWith("hello");
    m.unmount();
  });

  test("默认单行：空值时点击确认不回调（拒绝空串）", () => {
    const onConfirm = vi.fn();
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue=""
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    act(() => {
      findButton(m.container, "确定").click();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    m.unmount();
  });

  test("multiline：渲染 Textarea（无 Input）", () => {
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue="目标"
        multiline
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(m.container.querySelector("textarea")).toBeTruthy();
    expect(m.container.querySelector("input")).toBeNull();
    m.unmount();
  });

  test("allowEmpty：空值时确认按钮可用，提交回调空串（清空目标）", () => {
    const onConfirm = vi.fn();
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue=""
        allowEmpty
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(findButton(m.container, "确定").disabled).toBe(false);
    act(() => {
      findButton(m.container, "确定").click();
    });
    expect(onConfirm).toHaveBeenCalledWith("");
    m.unmount();
  });

  test("pending：确认按钮禁用并改显 pendingLabel，取消仍可用", () => {
    const onCancel = vi.fn();
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue="x"
        pending
        pendingLabel="保存中…"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const confirm = Array.from(m.container.querySelectorAll("button")).find(
      (b) => b.textContent === "保存中…",
    )!;
    expect(confirm).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    // 取消按钮仍存在且可用
    const cancel = findButton(m.container, "取消");
    expect(cancel.disabled).toBe(false);
    act(() => {
      cancel.click();
    });
    expect(onCancel).toHaveBeenCalledOnce();
    m.unmount();
  });

  test("error：弹层内渲染错误文案", () => {
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue="x"
        error="只有房主可以编辑"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(m.container.textContent).toContain("只有房主可以编辑");
    m.unmount();
  });

  test("Escape 触发 onCancel", () => {
    const onCancel = vi.fn();
    const m = mount(
      <CollaborationTextPrompt
        open
        title="t"
        defaultValue="x"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const input = m.container.querySelector("input")!;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledOnce();
    m.unmount();
  });

  test("open=false 不渲染", () => {
    const m = mount(
      <CollaborationTextPrompt
        open={false}
        title="t"
        defaultValue=""
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(m.container.querySelector("input")).toBeNull();
    m.unmount();
  });
});
