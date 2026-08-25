/**
 * 会话错误条 — session_error 独立 UI（非 assistant 气泡）
 *
 * 标题 + 详情；复制错误；关闭；retryable 时「重试」（由 Chat 注入是否可重试与回调）。
 * 样式克制，无大动画；放在底栏栈内、composer 上方。
 */
import { useCallback, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  WarningCircle,
  Copy,
  Check,
  X,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { AppTooltip } from "@tagent/ui";
import { cn } from "../../lib/utils";
import {
  sessionErrorMapAtom,
  setSessionErrorAtom,
} from "../../atoms/session-error-atoms";

export interface SessionErrorBannerProps {
  sessionId: string;
  /**
   * 是否允许点重试：error.retryable 且存在上一条真实用户输入、且当前未 running。
   * 由 Chat 计算（依赖 items / running）。
   */
  canRetry: boolean;
  /** 重试：重发上一条真实用户输入（Chat 负责找消息并走 send 路径） */
  onRetry: () => void | Promise<void>;
}

export function SessionErrorBanner({
  sessionId,
  canRetry,
  onRetry,
}: SessionErrorBannerProps): JSX.Element | null {
  const map = useAtomValue(sessionErrorMapAtom);
  const error = map[sessionId] ?? null;
  const setError = useSetAtom(setSessionErrorAtom);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

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

  const handleRetry = useCallback(async () => {
    if (!canRetry || retrying) return;
    setRetrying(true);
    try {
      // 先收起，避免重试过程中条仍占位；若再失败会重新推 session_error
      setError({ sessionId, error: null });
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }, [canRetry, retrying, sessionId, setError, onRetry]);

  if (!error) return null;

  const isChatModeBlock = error.code === "chat_mode_blocked";
  const showRetry = error.retryable;
  const retryDisabled = !canRetry || retrying;

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
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1">
          {showRetry ? (
            <AppTooltip
              label={
                !error.retryable
                  ? undefined
                  : !canRetry
                    ? "无可重发的用户消息"
                    : "重发上一条用户消息"
              }
            >
              <span className="inline-flex">
                <button
                  type="button"
                  disabled={retryDisabled}
                  onClick={() => void handleRetry()}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                    "bg-destructive/15 text-destructive hover:bg-destructive/25",
                    "disabled:cursor-not-allowed disabled:opacity-45",
                  )}
                >
                  <ArrowsClockwise
                    size={14}
                    weight="bold"
                    className={cn(retrying && "animate-spin")}
                    aria-hidden
                  />
                  {retrying ? "重试中…" : "重试"}
                </button>
              </span>
            </AppTooltip>
          ) : null}
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
