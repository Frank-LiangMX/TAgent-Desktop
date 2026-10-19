// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ChatInputHandle } from "./ChatInput";
import { usePendingSuggestion } from "./use-pending-suggestion";

it("waits for the final composer and consumes the handoff once without losing existing input", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const consumed = vi.fn();
  const Composer = forwardRef<ChatInputHandle, { initial: string }>(({ initial }, ref) => {
    const [text, setText] = useState(initial);
    useImperativeHandle(ref, () => ({ getText: () => text, setText, focus: vi.fn(), clear: () => setText("") }));
    return <div>{text}</div>;
  });
  function Harness({ ready }: { ready: boolean }) {
    const ref = useRef<ChatInputHandle>(null);
    const [pending, setPending] = useState<string | null>("补充回归结果，引用记录 note-1");
    const consume = (value: null) => { consumed(value); setPending(value); };
    usePendingSuggestion(ref, ready, pending, consume, "draft-1");
    return <Composer key={ready ? "landing" : "loading"} ref={ref} initial={ready ? "尚未发送的内容" : ""} />;
  }
  try {
    await act(async () => root.render(<Harness ready={false} />));
    expect(consumed).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    await act(async () => root.render(<Harness ready />));
    expect(container.textContent).toBe("尚未发送的内容\n\n补充回归结果，引用记录 note-1");
    expect(consumed).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Harness ready />));
    expect(consumed).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
