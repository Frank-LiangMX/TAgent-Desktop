/**
 * 会话错误条 — session_error 独立 UI（非 assistant 气泡）
 *
 * 标题 + 详情；复制错误；关闭；由 Chat 注入显式恢复操作。
 * 样式克制，无大动画；放在底栏栈内、composer 上方。
 */
import { useCallback, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  WarningCircle,
  Copy,
  Check,
  X,
} from "@phosphor-icons/react";
import { AppTooltip } from "@tagent/ui";
import { cn } from "../../lib/utils";
import {
  sessionErrorMapAtom,
  setSessionErrorAtom,
} from "../../atoms/session-error-atoms";

export interface SessionErrorBannerProps {
  sessionId: string;
  recovery?: (retryable: boolean) => ReactNode;
}

export function SessionErrorBanner({
  sessionId,
  recovery,
}: SessionErrorBannerProps): JSX.Element | null {
  const map = useAtomValue(sessionErrorMapAtom);
  const error = map[sessionId] ?? null;
  const setError = useSetAtom(setSessionErrorAtom);
  const [copied, setCopied] = useState(false);

  const dismiss = useCallback(() => {
    setError({ sessionId, error: null });
  }, [sessionId, setError]);

  const copyText = error
    ? [error.title, error.message].filter(Boolean).join("\n")
    : "";

  const onCopy = useCallback(async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.warn("[SessionErrorBanner] clipboard failed:", err);
    }
  }, [copyText]);

  if (!error) return null;

  const isChatModeBlock = error.code === "chat_mode_blocked";

  return (
    <div
      className="session-error-banner pointer-events-auto"
      role="alert"
      aria-live="assertive"
    >
      <div
        className={cn(
          "session-error-banner__card mb-2 flex flex-col gap-2 rounded-2xl border p-3 shadow-sm backdrop-blur-xl sm:flex-row sm:items-start",
          "pl-[calc(var(--app-shell-session-gutter,16px)_-_3px)] pr-[calc(var(--app-shell-session-gutter,16px)_-_3px)]",
          isChatModeBlock
            ? "border-primary/35 bg-primary/10"
            : "border-destructive/35 bg-destructive/8",
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <WarningCircle
            size={20}
            weight="fill"
            className={cn(
              "mt-0.5 shrink-0",
              isChatModeBlock ? "text-primary" : "text-destructive",
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "text-xs font-semibold",
                isChatModeBlock ? "text-primary" : "text-destructive",
              )}
            >
              {error.title}
            </div>
            {error.message ? (
              <p className="session-error-banner__detail mt-0.5 text-[12px] leading-snug text-muted-foreground">
                {error.message}
              </p>
            ) : null}
            {!isChatModeBlock && recovery?.(error.retryable)}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1">
          <AppTooltip label={copied ? "已复制" : "复制错误"} side="top">
            <button
              type="button"
              onClick={() => void onCopy()}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label={copied ? "已复制" : "复制错误"}
            >
              {copied ? (
                <Check size={16} weight="bold" className="text-foreground" />
              ) : (
                <Copy size={16} weight="regular" />
              )}
            </button>
          </AppTooltip>
          <button
            type="button"
            onClick={dismiss}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            aria-label="关闭错误"
          >
            <X size={16} weight="regular" />
          </button>
        </div>
      </div>
    </div>
  );
}
