import { useEffect, type RefObject } from "react";
import type { ChatInputHandle } from "./ChatInput";

/** Deliver only after the final composer mounts, retaining any existing input. */
export function usePendingSuggestion(
  inputRef: RefObject<ChatInputHandle>,
  ready: boolean,
  suggestion: string | null,
  consume: (value: null) => void,
  sessionId: string,
): void {
  useEffect(() => {
    if (!ready || !suggestion || !inputRef.current) return;
    const input = inputRef.current;
    const existing = input.getText().trim();
    input.setText(existing ? `${existing}\n\n${suggestion}` : suggestion);
    input.focus();
    consume(null);
  }, [ready, suggestion, consume, sessionId, inputRef]);
}
