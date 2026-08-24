import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Maximize2, Minus, Send, X } from "lucide-react";
import type { BotProfileRecord, BotSidecarState } from "@tagent/shared";
import { Button, MessageResponse, Textarea } from "@tagent/ui";

export interface BotSidecarPanelProps {
  sessionId: string;
  bot: BotProfileRecord;
  /** 同一会话中多个 Bot 窗口的初始错位层级 */
  stackIndex?: number;
  contextText: string;
  fallbackChannelId?: string;
  fallbackModelId?: string;
  onClose: () => void;
}

type SidecarPosition = { x: number; y: number };
type DockedEdge = "left" | "right" | "top" | "bottom";
type DockedPosition = { edge: DockedEdge; position: SidecarPosition };

const DEFAULT_POSITION: SidecarPosition = { x: 24, y: 96 };
const SIDECAR_EDGE_INSET = 8;
const SIDECAR_DOCK_THRESHOLD = 24;
const SIDECAR_STACK_OFFSET = 28;

function dockPositionToEdge(
  position: SidecarPosition,
  panel: HTMLElement,
): DockedPosition | null {
  const container = panel.offsetParent as HTMLElement | null;
  const panelRect = panel.getBoundingClientRect();
  const containerRect = container?.getBoundingClientRect();
  if (!containerRect) return null;

  const maxX = Math.max(
    SIDECAR_EDGE_INSET,
    containerRect.width - panelRect.width - SIDECAR_EDGE_INSET,
  );
  const maxY = Math.max(
    SIDECAR_EDGE_INSET,
    containerRect.height - panelRect.height - SIDECAR_EDGE_INSET,
  );
  const x = Math.min(maxX, Math.max(SIDECAR_EDGE_INSET, position.x));
  const y = Math.min(maxY, Math.max(SIDECAR_EDGE_INSET, position.y));
  const snapLeft = Math.abs(x - SIDECAR_EDGE_INSET);
  const snapRight = Math.abs(maxX - x);
  const snapTop = Math.abs(y - SIDECAR_EDGE_INSET);
  const snapBottom = Math.abs(maxY - y);
  if (
    Math.min(snapLeft, snapRight, snapTop, snapBottom) > SIDECAR_DOCK_THRESHOLD
  ) {
    return null;
  }

  if (Math.min(snapLeft, snapRight) <= Math.min(snapTop, snapBottom)) {
    return {
      edge: snapLeft <= snapRight ? "left" : "right",
      position: {
        x: snapLeft <= snapRight ? SIDECAR_EDGE_INSET : maxX,
        y,
      },
    };
  }
  return {
    edge: snapTop <= snapBottom ? "top" : "bottom",
    position: {
      x,
      y: snapTop <= snapBottom ? SIDECAR_EDGE_INSET : maxY,
    },
  };
}
type BotSidecarStreamPacket = {
  sessionId?: string;
  payload?: {
    kind?: string;
    text?: string;
    replace?: boolean;
    message?: {
      content?: Array<{ type?: string; text?: string }>;
    };
    event?: { type?: string; message?: string };
  };
};

function assistantTextFromMessage(
  message:
    | { type?: string; content?: Array<{ type?: string; text?: string }> }
    | undefined,
): string {
  if (
    !message ||
    (message.type && message.type !== "assistant") ||
    !Array.isArray(message.content)
  )
    return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/** 判断历史行是否已是 TAgentMessage IR（pi 落盘），而不是 Claude SDKMessage（有 message 包装）。
 *  IR：顶层 type='assistant'|'user' + content 数组、无 message 字段；SDKMessage：有 message 包装。 */
function isIRMessage(raw: unknown): boolean {
  if (raw == null || typeof raw !== "object") return false;
  const r = raw as { type?: unknown; message?: unknown; content?: unknown };
  return (
    (r.type === "assistant" || r.type === "user") &&
    r.message === undefined &&
    Array.isArray(r.content)
  );
}

function textBlocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * 从历史行提取 user/assistant 文本（兼容 SDKMessage 与 IR 两种落盘格式）。
 * 无文本（tool/thinking/result 等）返回 null，不进入弹窗列表。
 */
export function extractSidecarMessageText(
  raw: unknown,
): { role: "user" | "assistant"; text: string } | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as {
    type?: unknown;
    message?: { content?: unknown };
    content?: unknown;
  };
  if (r.type !== "user" && r.type !== "assistant") return null;
  const blocks = isIRMessage(raw) ? r.content : r.message?.content;
  const text = textBlocksToText(blocks).trim();
  if (!text) return null;
  return { role: r.type, text };
}

/** 历史消息 → 弹窗消息列表（稳定 id，避免重复 key 与重复气泡）。 */
export function sidecarHistoryToMessages(raw: unknown[]): SidecarChatMessage[] {
  const out: SidecarChatMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = extractSidecarMessageText(raw[i]);
    if (!item) continue;
    const row = raw[i] as { uuid?: unknown; createdAt?: unknown };
    const stamp =
      typeof row.uuid === "string" && row.uuid
        ? row.uuid
        : typeof row.createdAt === "number"
          ? String(row.createdAt)
          : String(i);
    out.push({
      id: "hist-" + i + "-" + stamp,
      role: item.role,
      text: item.text,
    });
  }
  return out;
}

type SidecarChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

function updateAssistantMessageList(
  current: SidecarChatMessage[],
  text: string,
  replace: boolean,
): SidecarChatMessage[] {
  const lastIndex = current.length - 1;
  const last = current[lastIndex];
  if (last?.role === "assistant") {
    return [
      ...current.slice(0, lastIndex),
      { ...last, text: replace ? text : last.text + text },
    ];
  }
  return [
    ...current,
    { id: "assistant-" + Date.now(), role: "assistant", text },
  ];
}

export function BotSidecarPanel({
  sessionId,
  bot,
  stackIndex = 0,
  contextText,
  fallbackChannelId,
  fallbackModelId,
  onClose,
}: BotSidecarPanelProps): JSX.Element {
  const [state, setState] = useState<BotSidecarState | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [analysisText, setAnalysisText] = useState("");
  const [messages, setMessages] = useState<SidecarChatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const messageIdRef = useRef(0);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const stackOffset =
    Math.max(0, Math.min(stackIndex, 6)) * SIDECAR_STACK_OFFSET;
  const [position, setPosition] = useState<SidecarPosition>(() => ({
    x: DEFAULT_POSITION.x + stackOffset,
    y: DEFAULT_POSITION.y + stackOffset,
  }));
  const sidecarRef = useRef<HTMLElement | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [dockedEdge, setDockedEdge] = useState<DockedEdge | null>(null);
  const dragRef = useRef<{
    dx: number;
    dy: number;
    originX: number;
    originY: number;
    containerLeft: number;
    containerTop: number;
    pointerId: number;
    moved: boolean;
    target: HTMLElement | null;
    panel: HTMLElement | null;
  } | null>(null);
  const lastDragMovedRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let openedSidecarId: string | null = null;
    void window.electronAPI
      .openBotSidecar({ sessionId, botProfileId: bot.profile.id })
      .then((next) => {
        openedSidecarId = next.sidecarId;
        if (!disposed) {
          setState(next);
          setMinimized(next.lifecycle === "minimized");
        } else {
          void window.electronAPI.closeBotSidecar({
            sidecarId: next.sidecarId,
          });
        }
      })
      .catch((error) => {
        if (!disposed)
          setNotice(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
      if (openedSidecarId) {
        void window.electronAPI.closeBotSidecar({ sidecarId: openedSidecarId });
      }
    };
  }, [bot.profile.id, sessionId]);

  useEffect(() => {
    const agentSessionId = state?.agentSessionId;
    if (!agentSessionId) return;
    const off = window.electronAPI.onStreamEvent((raw: unknown) => {
      const packet = raw as BotSidecarStreamPacket;
      if (packet.sessionId !== agentSessionId) return;
      const payload = packet.payload;
      if (!payload) return;

      // KSCC 可能发送增量控制事件；Pi 主要发送累计的 sdk_message 快照。
      if (payload.kind === "stream_text_delta" && payload.text) {
        const text = payload.text;
        setAnalysisText((current) => (payload.replace ? text : current + text));
        setMessages((current) =>
          updateAssistantMessageList(current, text, payload.replace === true),
        );
      } else if (payload.kind === "sdk_message") {
        const text = assistantTextFromMessage(payload.message);
        if (text) {
          setAnalysisText(text);
          setMessages((current) =>
            updateAssistantMessageList(current, text, true),
          );
        }
      } else if (
        payload.kind === "tagent_event" &&
        (payload.event?.type === "turn_end" ||
          payload.event?.type === "complete")
      ) {
        setAnalysisRunning(false);
      } else if (
        payload.kind === "tagent_event" &&
        payload.event?.type === "session_error"
      ) {
        const message = payload.event.message ?? "Bot 回复失败";
        setAnalysisRunning(false);
        setNotice(message);
        setAnalysisText(message);
        setMessages((current) =>
          updateAssistantMessageList(current, message, true),
        );
      }
    });
    return () => off();
  }, [state?.agentSessionId]);

  // 打开弹窗时把隐藏专属会话的历史读回来；关闭再打开不丢对话。
  useEffect(() => {
    const agentSessionId = state?.agentSessionId;
    if (!agentSessionId) return;
    let cancelled = false;
    setHistoryLoading(true);
    void window.electronAPI
      .getMessages(agentSessionId)
      .then((raw) => {
        if (!cancelled) {
          setMessages(sidecarHistoryToMessages(raw as unknown[]));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : String(error);
          setNotice(
            message
              ? "读取 Bot 历史对话失败：" + message
              : "读取 Bot 历史对话失败",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state?.agentSessionId]);

  useEffect(() => {
    const node = messageScrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, analysisRunning]);
  useEffect(() => {
    if (!minimized) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = sidecarRef.current;
      if (!panel) return;
      const docked = dockPositionToEdge(positionRef.current, panel);
      if (!docked) {
        setDockedEdge(null);
        return;
      }
      setDockedEdge(docked.edge);
      if (
        docked.position.x !== positionRef.current.x ||
        docked.position.y !== positionRef.current.y
      ) {
        setPosition(docked.position);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [minimized]);

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (
        Math.abs(event.clientX - drag.originX) > 3 ||
        Math.abs(event.clientY - drag.originY) > 3
      ) {
        drag.moved = true;
      }
      const panelRect = drag.panel?.getBoundingClientRect();
      const container = drag.panel?.offsetParent as HTMLElement | null;
      const containerRect = container?.getBoundingClientRect();
      if (!panelRect || !containerRect) return;
      const edge = 8;
      const maxX = Math.max(edge, containerRect.width - panelRect.width - edge);
      const maxY = Math.max(
        edge,
        containerRect.height - panelRect.height - edge,
      );
      const nextX = event.clientX - drag.containerLeft - drag.dx;
      const nextY = event.clientY - drag.containerTop - drag.dy;
      setPosition({
        x: Math.min(maxX, Math.max(edge, nextX)),
        y: Math.min(maxY, Math.max(edge, nextY)),
      });
    };
    const up = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      lastDragMovedRef.current = drag.moved;
      const panel = drag.panel;
      if (panel?.classList.contains("bot-sidecar-orb")) {
        const docked = dockPositionToEdge(
          { x: panel.offsetLeft, y: panel.offsetTop },
          panel,
        );
        if (docked?.edge === "right") {
          setDockedEdge(null);
          onCloseRef.current();
        } else if (docked) {
          setPosition(docked.position);
          setDockedEdge(docked.edge);
        } else {
          setDockedEdge(null);
        }
      }
      drag.target?.releasePointerCapture?.(drag.pointerId);
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const target = event.currentTarget;
    const panel = target.closest<HTMLElement>(
      ".bot-sidecar-panel, .bot-sidecar-orb",
    );
    const container = panel?.offsetParent as HTMLElement | null;
    const panelRect = panel?.getBoundingClientRect();
    const containerRect = container?.getBoundingClientRect();
    if (!panelRect || !containerRect) return;
    if (panel?.classList.contains("bot-sidecar-orb")) {
      setDockedEdge(null);
    }
    lastDragMovedRef.current = false;
    dragRef.current = {
      dx: event.clientX - panelRect.left,
      dy: event.clientY - panelRect.top,
      originX: event.clientX,
      originY: event.clientY,
      containerLeft: containerRect.left,
      containerTop: containerRect.top,
      pointerId: event.pointerId,
      moved: false,
      target,
      panel,
    };
    target.setPointerCapture?.(event.pointerId);
  };

  const minimize = async (): Promise<void> => {
    if (!state) return;
    const next = await window.electronAPI.minimizeBotSidecar(state.sidecarId);
    if (next) {
      setState(next);
      setMinimized(true);
    }
  };

  const restore = async (): Promise<void> => {
    const next = await window.electronAPI.openBotSidecar({
      sessionId,
      botProfileId: bot.profile.id,
    });
    setState(next);
    setMinimized(false);
  };

  const close = async (): Promise<void> => {
    if (state)
      await window.electronAPI.closeBotSidecar({ sidecarId: state.sidecarId });
    onClose();
  };

  const analyze = async (): Promise<void> => {
    const question = draft.trim();
    if (
      !question ||
      !state?.agentSessionId ||
      analysisRunning ||
      historyLoading
    )
      return;

    const revision = bot.revisions.find(
      (item) => item.id === bot.profile.currentConfigRevisionId,
    );
    const sequence = messageIdRef.current++;
    const timestamp = Date.now();
    setMessages((current) => [
      ...current,
      {
        id: "user-" + timestamp + "-" + sequence,
        role: "user",
        text: question,
      },
      {
        id: "assistant-" + timestamp + "-" + sequence,
        role: "assistant",
        text: "",
      },
    ]);
    setAnalysisText("");
    setDraft("");
    setAnalysisRunning(true);
    setNotice("");
    try {
      const result = await window.electronAPI.sendMessage({
        sessionId: state.agentSessionId,
        prompt: question,
        contextPrompt: [
          "你是独立 Bot，正在与用户进行旁路对话。",
          "如果用户要求分析主会话，可以参考下面的主会话最近内容；否则优先处理用户当前消息。",
          "主会话最近内容：",
          contextText || "（暂无）",
          "不要声称已经修改主会话。",
        ].join("\n\n"),
        // 独立旁路 Bot 只使用自己的会话，不得被父会话的多 Bot 配置带入协作室路由。
        skipFusionRouting: true,
        channelId: revision?.channelId ?? fallbackChannelId,
        model:
          revision?.modelId ??
          (revision?.channelId ? undefined : fallbackModelId),
      });
      if (!result?.ok) {
        const message = result?.error ?? "Bot 消息未接受";
        setAnalysisRunning(false);
        setNotice(message);
        setAnalysisText(message);
        setMessages((current) =>
          updateAssistantMessageList(current, message, true),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAnalysisRunning(false);
      setNotice(message);
      setAnalysisText(message);
      setMessages((current) =>
        updateAssistantMessageList(current, message, true),
      );
    }
  };

  const bridge = async (): Promise<void> => {
    const content = (analysisText || draft).trim();
    if (!content || !state || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await window.electronAPI.requestBotSidecarBridge({
        sidecarId: state.sidecarId,
        sessionId,
        botProfileId: bot.profile.id,
        content,
      });
      if (!result.ok || !result.accepted) {
        setNotice(result.error ?? "主会话没有接受这条桥接");
        return;
      }
      const forwarded = await window.electronAPI.steerAgent(
        sessionId,
        "【Bot 旁路建议｜" + bot.profile.displayName + "】\n" + content,
      );
      if (!forwarded.ok) {
        setNotice(forwarded.error ?? "已通过桥接校验，但主会话未接受");
        return;
      }
      setDraft("");
      setNotice("已交给主会话 Agent");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const currentRevision = useMemo(
    () =>
      bot.revisions.find(
        (revision) => revision.id === bot.profile.currentConfigRevisionId,
      ),
    [bot],
  );
  const roleDescription = currentRevision?.roleSnapshot.description;
  const modelLabel = currentRevision?.modelId
    ? currentRevision.modelId
    : currentRevision?.channelId
      ? "渠道默认模型"
      : fallbackModelId
        ? "沿用主会话 · " + fallbackModelId
        : "未配置模型";
  if (minimized) {
    return (
      <button
        type="button"
        ref={(node) => {
          sidecarRef.current = node;
        }}
        className="bot-sidecar-orb session-glass-surface"
        data-docked-edge={dockedEdge ?? undefined}
        style={{
          left: position.x,
          top: position.y,
          zIndex: 30 + Math.max(0, stackIndex),
        }}
        onPointerDown={startDrag}
        onClick={() => {
          const moved = lastDragMovedRef.current;
          lastDragMovedRef.current = false;
          if (!moved) void restore();
        }}
        aria-label={"恢复 Bot " + bot.profile.displayName + " 旁路窗口"}
      >
        <span className="session-bot-rail__avatar" aria-hidden>
          {bot.profile.displayName.trim().charAt(0) || "B"}
        </span>
      </button>
    );
  }

  return (
    <section
      ref={(node) => {
        sidecarRef.current = node;
      }}
      className="bot-sidecar-panel session-glass-surface session-glass-popover"
      style={{
        left: position.x,
        top: position.y,
        zIndex: 30 + Math.max(0, stackIndex),
      }}
      aria-label={"Bot " + bot.profile.displayName + " 旁路窗口"}
    >
      <div className="bot-sidecar-panel__header">
        <div
          className="bot-sidecar-panel__drag-handle min-w-0"
          onPointerDown={startDrag}
        >
          <div className="bot-sidecar-panel__title">
            {bot.profile.displayName}
          </div>
          <div className="bot-sidecar-panel__subtitle">
            独立上下文 · 可读取主会话 · 不直接写入主会话
          </div>
        </div>
        <div className="bot-sidecar-panel__controls flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void minimize()}
            aria-label="收起为悬浮球"
          >
            <Minus className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void close()}
            aria-label="关闭旁路窗口"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="bot-sidecar-panel__body">
        <div className="bot-sidecar-panel__context-strip">
          <div className="bot-sidecar-panel__context-summary">
            <span className="bot-sidecar-panel__section-label">
              主会话上下文
            </span>
            <span>已读取最近内容 · 独立 Bot 对话</span>
          </div>
          <details className="bot-sidecar-panel__context-details">
            <summary>查看上下文</summary>
            <div className="bot-sidecar-panel__context-preview">
              <div>
                职责：
                {roleDescription || bot.profile.description || "未填写描述"}
              </div>
              <pre>{contextText || "主会话暂时没有可供旁路读取的内容。"}</pre>
            </div>
          </details>
        </div>

        <div
          ref={messageScrollRef}
          className="bot-sidecar-panel__messages scrollbar-thin"
          aria-live="polite"
          aria-label="Bot 对话内容"
        >
          {messages.length === 0 ? (
            <div className="bot-sidecar-panel__empty">
              <div className="bot-sidecar-panel__empty-title">
                和 {bot.profile.displayName} 开始对话
              </div>
              <div>可以让它分析主会话，也可以直接询问一个问题。</div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={
                  "bot-sidecar-panel__message " +
                  (message.role === "user"
                    ? "bot-sidecar-panel__message--user"
                    : "bot-sidecar-panel__message--assistant")
                }
              >
                <div className="bot-sidecar-panel__message-meta">
                  {message.role === "user" ? "你" : bot.profile.displayName}
                </div>
                <div className="bot-sidecar-panel__message-text">
                  {message.role === "assistant" ? (
                    message.text ? (
                      <MessageResponse
                        className="bot-sidecar-panel__markdown"
                        streaming={
                          analysisRunning &&
                          message.id === messages[messages.length - 1]?.id
                        }
                      >
                        {message.text}
                      </MessageResponse>
                    ) : analysisRunning ? (
                      <span className="bot-sidecar-panel__typing">
                        正在思考…
                      </span>
                    ) : null
                  ) : (
                    message.text
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="bot-sidecar-panel__composer chat-input-glass">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void analyze();
              }
            }}
            placeholder="给这个 Bot 发消息…（Enter 发送，Shift+Enter 换行）"
            className="composer-editor bot-sidecar-panel__input"
            disabled={busy || analysisRunning}
            aria-label="发送给 Bot 的消息"
          />
          <div className="bot-sidecar-panel__composer-footer">
            <div className="bot-sidecar-panel__composer-meta">
              <span
                className="bot-sidecar-panel__model-label"
                title={modelLabel}
              >
                <span className="bot-sidecar-panel__model-dot" aria-hidden />
                <span className="bot-sidecar-panel__model-name">
                  {modelLabel}
                </span>
              </span>
              {notice ? (
                <span className="bot-sidecar-panel__notice" aria-live="polite">
                  {notice}
                </span>
              ) : null}
            </div>
            <div className="bot-sidecar-panel__composer-actions">
              <Button
                size="icon-sm"
                variant="ghost"
                className="bot-sidecar-panel__action"
                disabled={
                  (!draft.trim() && !analysisText.trim()) ||
                  busy ||
                  analysisRunning ||
                  !state
                }
                onClick={() => void bridge()}
                aria-label="交给主会话"
                title="交给主会话"
              >
                <ArrowUpRight className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="bot-sidecar-panel__action bot-sidecar-panel__send-action"
                disabled={
                  !draft.trim() ||
                  busy ||
                  analysisRunning ||
                  historyLoading ||
                  !state
                }
                onClick={() => void analyze()}
                aria-label="发送给 Bot"
                title="发送给 Bot"
              >
                <Send className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div className="bot-sidecar-panel__resize-hint" aria-hidden>
        <Maximize2 className="size-3" />
      </div>
    </section>
  );
}
