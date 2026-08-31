/**
 * KbProposeSaveBanner — 知识库受控写入确认横幅（kb_propose_save，刀 1）
 *
 * 视觉对齐 ExitPlanModeBanner / AskUserQuestionBanner（玻璃、全宽、不透明正文）；复用 ask-user-card 材质。
 * 展示标题 + 目标库名「保存到《库名》」+ 正文 Markdown 预览 + 两选项：
 * 1. 确认保存 — 写入当前绑定库（service 调 createKnowledgeBaseDocument）
 * 2. 取消 — 零写入（service resolve user_rejected）
 *
 * 会话停止 / 切走时由主进程 clearSessionPending → 推 KB_PROPOSE_SAVE_RESOLVED 出队（兜底）。
 *
 * 见 docs/dev/knowledge-base/KB-P1-5-CONTROLLED-WRITE-brief.md §D。
 */
import { useAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import Markdown from "react-markdown";
import { BookBookmark, Check, WarningCircle, X } from "@phosphor-icons/react";
import * as React from "react";

import { AppTooltip } from "@tagent/ui";
import { cn } from "../../lib/utils";
import { allPendingKbProposeSaveRequestsAtom } from "../../atoms/kb-propose-save-atoms";

/** 正文预览最长 64KB（避免超大 Markdown 撑爆渲染层；超出按字符保守截） */
const PREVIEW_MAX_CHARS = 64 * 1024;

interface KbProposeSaveBannerProps {
  sessionId: string;
}

export function KbProposeSaveBanner({
  sessionId,
}: KbProposeSaveBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(
    allPendingKbProposeSaveRequestsAtom,
  );
  const requests = allRequests.get(sessionId) ?? [];
  const [submitting, setSubmitting] = React.useState(false);

  const request = requests[0] ?? null;
  const content =
    typeof request?.content === "string" ? request.content : "";
  const preview =
    content.length <= PREVIEW_MAX_CHARS
      ? content
      : content.slice(0, PREVIEW_MAX_CHARS);
  const draft = request?.draft;

  const remeasureComposerTop = (): void => {
    window.dispatchEvent(new CustomEvent("tagent:composer-top-remeasure"));
  };

  const respond = async (action: "confirm" | "reject"): Promise<void> => {
    if (submitting || !request) return;
    setSubmitting(true);
    try {
      await window.electronAPI.respondKbProposeSave({
        requestId: request.requestId,
        action,
      });
      // 乐观出队
      setAllRequests((prev) => {
        const map = new Map(prev);
        const current = map.get(sessionId) ?? [];
        const newValue = current.filter(
          (r) => r.requestId !== request.requestId,
        );
        if (newValue.length === 0) map.delete(sessionId);
        else map.set(sessionId, newValue);
        return map;
      });
    } catch (error) {
      console.error("[KbProposeSaveBanner] 响应失败:", error);
    } finally {
      setSubmitting(false);
    }
  };

  /** 关闭确认横幅 & 终止 Agent（X）。stopAgent → run 级 abort → clearSessionPending 兜底 aborted 出队 */
  const handleDismiss = (): void => {
    setAllRequests((prev) => {
      const map = new Map(prev);
      map.delete(sessionId);
      return map;
    });
    window.electronAPI.stopAgent(sessionId).catch(console.error);
  };

  if (!request) return null;

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          key={request.requestId}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onAnimationComplete={remeasureComposerTop}
          className="session-permission-banner pointer-events-auto"
        >
          <div className="ask-user-card kb-propose-save-card">
            {/* 顶栏 */}
            <header className="ask-user-card__head">
              <div className="ask-user-card__head-left">
                <span className="ask-user-card__icon" aria-hidden>
                  <BookBookmark size={15} weight="duotone" />
                </span>
                <div className="ask-user-card__titles">
                  <span className="ask-user-card__title">知识库写入待确认</span>
                  <span className="ask-user-card__meta">
                    {request.knowledgeBaseName
                      ? `保存到《${request.knowledgeBaseName}》`
                      : "保存到当前知识库"}
                  </span>
                </div>
              </div>
              <div className="ask-user-card__head-right">
                {requests.length > 1 ? (
                  <AppTooltip label={`另有 ${requests.length - 1} 份待确认`} side="top">
                    <span className="ask-user-card__queue">
                      +{requests.length - 1}
                    </span>
                  </AppTooltip>
                ) : null}
                <AppTooltip label="关闭并终止 Agent" side="top">
                  <button
                    type="button"
                    className="ask-user-card__icon-btn"
                    onClick={handleDismiss}
                    aria-label="关闭并终止 Agent"
                  >
                    <X size={14} weight="bold" />
                  </button>
                </AppTooltip>
              </div>
            </header>

            {/* 标题 */}
            <div className="kb-propose-save-card__title">{request.title}</div>

            {draft?.summary ? (
              <p className="text-sm leading-6 text-foreground/80">{draft.summary}</p>
            ) : null}

            {draft?.sources?.length ? (
              <section className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                <div className="mb-1.5 font-medium text-foreground/80">来源</div>
                <ul className="space-y-1 text-muted-foreground">
                  {draft.sources.map((source, index) => (
                    <li key={`${source.label}-${source.location ?? ""}-${index}`}>
                      {source.label}
                      {source.location ? ` · ${source.location}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {draft?.uncertainties?.length ? (
              <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
                <div className="mb-1.5 flex items-center gap-1.5 font-medium">
                  <WarningCircle size={14} weight="fill" />
                  待确认内容
                </div>
                <ul className="space-y-1">
                  {draft.uncertainties.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {draft?.warnings?.length ? (
              <section className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <div className="mb-1.5 font-medium text-foreground/80">解析提示</div>
                <ul className="space-y-1">
                  {draft.warnings.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* 正文预览（Markdown） */}
            {preview.trim() ? (
              <div className="exit-plan-card__plan">
                <Markdown>{preview}</Markdown>
              </div>
            ) : null}

            {/* 选项 */}
            <div className="ask-user-card__body">
              <div className="kb-propose-save-actions">
                <button
                  type="button"
                  className={cn("ask-user-card__btn", "ask-user-card__btn--ghost")}
                  onClick={() => void respond("reject")}
                  disabled={submitting}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={cn(
                    "ask-user-card__btn",
                    "ask-user-card__btn--primary",
                  )}
                  onClick={() => void respond("confirm")}
                  disabled={submitting}
                >
                  <Check size={13} weight="bold" />
                  确认保存
                </button>
              </div>
            </div>

            <footer className="ask-user-card__foot">
              <span className="ask-user-card__hint">
                确认后写入《{request.knowledgeBaseName || "知识库"}》，之后 kb_search 可命中
              </span>
            </footer>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
