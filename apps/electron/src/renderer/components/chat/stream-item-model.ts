/**
 * 会话级流式状态（与 DisplayItem 分离）。
 *
 * delta 只累加 streamState，永不因 delta 创建/修改 items。
 * 段边界由 Chat 按消息内容选择性清理：tool-only 中间态保留 thinking；
 * turn_end / result / 含 thinking 的终态消息才清空。
 */

import type { TAgentAssistantMessage, TAgentMessage } from "@tagent/shared";
import { sanitizeAssistantTextForDisplay } from "@tagent/shared";
type AssistantDisplayMessage = TAgentMessage & { __fullThinking?: string };

/** 会话级流式缓冲：正文 + 思考 */
export interface SessionStreamState {
  text: string;
  thinking: string;
}

export const EMPTY_STREAM_STATE: SessionStreamState = {
  text: "",
  thinking: "",
};

export function hasStreamContent(state: SessionStreamState): boolean {
  return Boolean(state.text || state.thinking);
}

export function applyTextDelta(
  state: SessionStreamState,
  delta: string,
): SessionStreamState {
  if (!delta) return state;
  return { ...state, text: state.text + delta };
}

/**
 * E（IPC delta resync）：整体替换 streamState.text（前缀不匹配时 main 发 replace delta 带全量）。
 * 不盲目 append，防重复/丢字。
 */
export function applyTextReplace(
  state: SessionStreamState,
  text: string,
): SessionStreamState {
  if (state.text === text) return state;
  return { ...state, text };
}

export function applyThinkingDeltaToState(
  state: SessionStreamState,
  delta: string,
): SessionStreamState {
  if (!delta) return state;
  return { ...state, thinking: state.thinking + delta };
}

/**
 * E（IPC delta resync）：整体替换 streamState.thinking（同 {@link applyTextReplace}）。
 */
export function applyThinkingReplaceToState(
  state: SessionStreamState,
  text: string,
): SessionStreamState {
  if (state.thinking === text) return state;
  return { ...state, thinking: text };
}

export function clearSessionStreamState(): SessionStreamState {
  return EMPTY_STREAM_STATE;
}

/** sdk_message 内容块最小形状（避免拉满 IR 类型） */
export interface StreamClearMessageLike {
  type?: string;
  stop_reason?: string | null;
  content?: ReadonlyArray<{
    type: string;
    thinking?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
}

/**
 * 是否应清空 streamState.thinking。
 *
 * 仅 tool_use 的中间态（Pi tool_execution_start）**不得**清——
 * 思考还只在 streamState，清了就「出完即消失」。
 * 等消息已带非空 thinking，或回合真正结束（stop_reason）再清。
 */
export function shouldClearStreamThinking(
  msg: StreamClearMessageLike,
): boolean {
  if (msg.type !== "assistant") return true;
  // 仅当消息 content 已带非空 thinking 时才清 stream 缓冲（防重复）。
  // 禁止仅凭 stop_reason 清空：kscc final 常带 tool_use 却剥掉 thinking，
  // 一清 stream 又无 content 思考 → 时间线思考段闪没（REGRESS-E）。
  // 回合真正结束由 Chat result/turn_end 的 resetStreamState 全清。
  const blocks = msg.content ?? [];
  return blocks.some(
    (b) =>
      b.type === "thinking" &&
      typeof b.thinking === "string" &&
      b.thinking.trim().length > 0,
  );
}

/**
 * 是否应清空 streamState.text。
 * 对称：仅工具中间态保留已流出的正文；消息已带 text 或终态再清。
 */
export function shouldClearStreamText(msg: StreamClearMessageLike): boolean {
  if (msg.type !== "assistant") return true;
  if (msg.stop_reason) return true;
  const blocks = msg.content ?? [];
  return blocks.some(
    (b) =>
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim().length > 0,
  );
}

/** 按消息内容选择性清理 streamState（禁止 tool-only 中间态把思考打没） */
export function applySdkMessageToStreamState(
  state: SessionStreamState,
  msg: StreamClearMessageLike,
): SessionStreamState {
  const clearThinking = shouldClearStreamThinking(msg);
  const clearText = shouldClearStreamText(msg);
  if (!clearThinking && !clearText) return state;
  if (clearThinking && clearText) return EMPTY_STREAM_STATE;
  return {
    text: clearText ? "" : state.text,
    thinking: clearThinking ? "" : state.thinking,
  };
}

/** DisplayItem 的流式相关最小形状（Pi 落盘路径清理纯占位） */
export interface StreamItemLike {
  key: string;
  message?: TAgentMessage;
  streamingText?: string;
  streamingThinking?: string;
  streamUuid?: string;
  streaming?: boolean;
  taskCard?: unknown;
  compactStatus?: "compacting" | "complete";
  compactTrigger?: "auto" | "manual";
  /** MoA 圆桌卡（standalone，不被 purgeStreamingItems 清掉） */
  moaRoundtable?: unknown;
  /** 圆桌讨论入口卡（standalone，不被 purgeStreamingItems 清掉） */
  moaDiscussion?: unknown;
}

/** 清掉纯流式占位（无 message / 任务卡 / 压缩行 / MoA 圆桌卡 / 圆桌讨论入口卡） */
export function purgeStreamingItems<T extends StreamItemLike>(prev: T[]): T[] {
  return prev.filter((it) =>
    Boolean(
      it.message ||
      it.taskCard ||
      it.compactStatus ||
      it.moaRoundtable ||
      it.moaDiscussion,
    ),
  );
}

function isNonEmptyThinkingBlock(b: TAgentMessage["content"][number]): boolean {
  return (
    b.type === "thinking" &&
    typeof (b as { thinking?: string }).thinking === "string" &&
    (b as { thinking: string }).thinking.trim().length > 0
  );
}

function isNonEmptyTextBlock(b: TAgentMessage["content"][number]): boolean {
  return (
    b.type === "text" &&
    typeof (b as { text?: string }).text === "string" &&
    (b as { text: string }).text.trim().length > 0
  );
}

/** 用户可见思考摘要的上限；原始 thinking 仍保留在主进程会话上下文中。 */
export const MAX_DISPLAY_THINKING_CHARS = 900;

const THINKING_SIGNAL_RE =
  /结论|决定|下一步|完成|发现|问题|错误|失败|修复|实现|验证|测试|文件|路径|命令|方案|因此|已|will|next|done|error|fail|fix|test|file|path|command|implement|because/i;

function normalizeThinkingLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.replace(/\r/g, "").split(/\n+/)) {
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (!line) continue;
    const key = line.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

/** 将原始 thinking 压成用户可读的阶段摘要。 */
export function compactThinkingForDisplay(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  if (normalized.length <= MAX_DISPLAY_THINKING_CHARS) return normalized;

  const lines = normalizeThinkingLines(normalized);
  const selected: string[] = [];
  const add = (line: string | undefined): void => {
    if (line && !selected.includes(line)) selected.push(line);
  };
  lines.slice(0, 2).forEach(add);
  lines
    .filter((line) => THINKING_SIGNAL_RE.test(line))
    .slice(-4)
    .forEach(add);
  lines.slice(-2).forEach(add);

  let compact = (selected.length > 0 ? selected : lines).join("\n");
  if (compact.length <= MAX_DISPLAY_THINKING_CHARS) return compact;
  const head = Math.floor(MAX_DISPLAY_THINKING_CHARS * 0.34);
  const tail = MAX_DISPLAY_THINKING_CHARS - head - 24;
  return `${compact.slice(0, head).trimEnd()}\n…（中间重复推演已折叠）…\n${compact.slice(-tail).trimStart()}`;
}

/** 合并同一 assistant 的多个阶段，只保留一个 reasoning block。 */
export function mergeThinkingStageSummary(
  existing: string,
  incoming: string,
): string {
  const left = compactThinkingForDisplay(existing);
  const right = compactThinkingForDisplay(incoming);
  if (!left) return right;
  if (!right || left === right || left.includes(right)) return left;
  if (right.includes(left)) return right;
  if (right.length < 64 && !THINKING_SIGNAL_RE.test(right)) return left;
  return compactThinkingForDisplay(`${left}\n${right}`);
}

/**
 * 保留原始块顺序和内容。折叠由视图负责，不能在 upsert 时摘要/搬移块：
 * 时间线 key 包含 blockIndex，搬移会卸载已显示的正文和思考。
 * 函数名暂留以兼容历史加载入口；仅恢复旧版的单块摘要副本。
 */
export function compactAssistantMessageForDisplay(
  message: TAgentMessage,
): TAgentMessage {
  if (message.type !== "assistant") return message;
  const { __fullThinking, ...rest } = message as AssistantDisplayMessage;
  if (__fullThinking === undefined) return message;
  const singleThinking = message.content.filter((b) => b.type === "thinking").length === 1;
  return {
    ...rest,
    content: message.content.map((block) =>
      singleThinking && block.type === "thinking" && __fullThinking
        ? { ...block, thinking: __fullThinking }
        : block,
    ),
  } as TAgentMessage;
}
function thinkingBlockText(b: TAgentMessage["content"][number]): string {
  return b.type === "thinking" &&
    typeof (b as { thinking?: string }).thinking === "string"
    ? (b as { thinking: string }).thinking
    : "";
}

function textBlockText(b: TAgentMessage["content"][number]): string {
  return b.type === "text" && typeof (b as { text?: string }).text === "string"
    ? (b as { text: string }).text
    : "";
}

/**
 * 同 uuid / 流式替换时：后到消息若剥掉 thinking/text 主体（stripPartial 空壳或 tool-only），
 * 保留 existing 里已有的非空思考与段间 progress 正文。
 *
 * 截图回归：kscc 同会话结束后中间 progress 全没、工具并成一大阶段；reload 从 JSONL 又有——
 * 因 live 曾 commit 的 text 被后到剥空 partial / tool-only upsert 盖掉，而旧逻辑只 preserve thinking。
 */
export function preserveAssistantThinking(
  existing: TAgentMessage,
  incoming: TAgentMessage,
): TAgentMessage {
  if (existing.type !== "assistant" || incoming.type !== "assistant")
    return incoming;

  const prevThink = existing.content.filter(isNonEmptyThinkingBlock);
  const prevText = existing.content.filter(isNonEmptyTextBlock);
  if (prevThink.length === 0 && prevText.length === 0) return incoming;

  const incThink = incoming.content.filter(isNonEmptyThinkingBlock);
  const incText = incoming.content.filter(isNonEmptyTextBlock);

  // 逐块：空壳填 existing；incoming 更短前缀则用 existing 更长
  let usedThink = 0;
  let usedText = 0;
  const content = incoming.content.map((b) => {
    if (b.type === "thinking") {
      const inc = thinkingBlockText(b).trim();
      const prev = prevThink[usedThink];
      if (prev) {
        const prevT = thinkingBlockText(prev).trim();
        if (!inc || (prevT.length > inc.length && prevT.startsWith(inc))) {
          usedThink++;
          return { ...b, thinking: prevT };
        }
        if (inc) usedThink++;
      }
      return b;
    }
    if (b.type === "text") {
      const inc = textBlockText(b).trim();
      const prev = prevText[usedText];
      if (prev) {
        const prevT = textBlockText(prev).trim();
        if (!inc || (prevT.length > inc.length && prevT.startsWith(inc))) {
          usedText++;
          return { ...b, text: prevT };
        }
        if (inc) usedText++;
      }
      return b;
    }
    return b;
  });

  // incoming 完全没有对应块类型时，把 existing 非空块按顺序插回（tool-only 覆盖路径）
  const outThink = content.filter(isNonEmptyThinkingBlock);
  const outText = content.filter(isNonEmptyTextBlock);
  const missingThink = prevThink.slice(outThink.length);
  const missingText = prevText.slice(outText.length);
  if (missingThink.length === 0 && missingText.length === 0) {
    return { ...incoming, content };
  }

  // 插到第一个 tool_use 前，保持 思考/进度 → 工具 顺序
  const merged = [...content];
  const toolIdx = merged.findIndex((b) => b.type === "tool_use");
  const insertAt = toolIdx >= 0 ? toolIdx : 0;
  merged.splice(insertAt, 0, ...missingThink, ...missingText);
  return { ...incoming, content: merged };
}

/** 后到的 user 快照没带 attachments 时，保留已有图片/附件。 */
export function preserveUserAttachments(
  existing: TAgentMessage,
  incoming: TAgentMessage,
): TAgentMessage {
  if (existing.type !== "user" || incoming.type !== "user") return incoming;
  if (incoming.attachments?.length) return incoming;
  if (!existing.attachments?.length) return incoming;
  return { ...incoming, attachments: existing.attachments };
}

/**
 * turn_end / result / 段边界清 stream 前：把仍只在缓冲里的思考写入末条主线 assistant。
 *
 * - 优先填充末条「空 thinking 壳」（stripPartial 留下的）
 * - 否则前插到**尚无非空思考**的末条主线 assistant
 * - 末条已有相同/前缀思考 → no-op；若缓冲是更长续写则更新该块
 * - 禁止「末条已有思考就整函数 return」——那会丢掉后续段的 streamState 思考
 */
export function commitStreamThinkingToLastAssistant<T extends StreamItemLike>(
  prev: T[],
  thinking: string,
): T[] {
  const t = thinking.trim();
  if (!t) return prev;

  const patchAt = (i: number, content: TAgentAssistantMessage["content"]): T[] => {
    const m = prev[i]!.message!;
    if (m.type !== "assistant") return prev;
    const next = [...prev];
    next[i] = {
      ...prev[i]!,
      message: { ...m, content },
    };
    return next;
  };

  // 1) 自后向前：填空壳 / 续写已有块 / 落到无思考的 assistant
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]?.message;
    if (m?.type !== "assistant" || m.parentToolUseId) continue;

    const emptyThinkIdx = m.content.findIndex(
      (b) => b.type === "thinking" && !thinkingBlockText(b).trim(),
    );
    if (emptyThinkIdx >= 0) {
      const content = [...m.content];
      content[emptyThinkIdx] = { type: "thinking", thinking: t };
      return patchAt(i, content);
    }

    const thinkIdx = m.content.findIndex(isNonEmptyThinkingBlock);
    if (thinkIdx >= 0) {
      const existing = thinkingBlockText(m.content[thinkIdx]!).trim();
      // 已含相同或更长 → 本段已落，不再往更早的 assistant 重复写
      if (existing === t || existing.startsWith(t)) return prev;
      // 缓冲是续写 → 更新该块
      if (t.startsWith(existing)) {
        const content = [...m.content];
        content[thinkIdx] = { type: "thinking", thinking: t };
        return patchAt(i, content);
      }
      // 末条已有**另一段**思考：跳过，找更早的空位；若没有则在末条再追加一块
      continue;
    }

    // 无 thinking 块：前插
    return patchAt(i, [{ type: "thinking", thinking: t }, ...m.content]);
  }

  // 2) 所有主线 assistant 都已有不同思考：追加到真正的末条主线
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]?.message;
    if (m?.type !== "assistant" || m.parentToolUseId) continue;
    const thinkIdx = m.content.findIndex(isNonEmptyThinkingBlock);
    if (thinkIdx < 0) {
      return patchAt(i, [{ type: "thinking", thinking: t }, ...m.content]);
    }
    const existing = thinkingBlockText(m.content[thinkIdx]!).trim();
    const merged = existing === t || existing.startsWith(t)
      ? existing
      : t.startsWith(existing) ? t : `${existing}\n\n${t}`;
    if (merged === existing) return prev;
    const content = [...m.content];
    content[thinkIdx] = { type: "thinking", thinking: merged };
    return patchAt(i, content);
  }
  return prev;
}

/**
 * tool_start 清 stream 前：把仍只在缓冲里的段间 progress 写入末条主线 assistant。
 *
 * 现象：concise 下阶段性总结常只活在 `streamState.text`（打字机 NarrativeRow）；
 * `tool_start` 若直接 `text=''`，总结秒消，等 sdk_message text 才回来（或永远闪没）。
 * 插入到第一个 tool_use 之前，保证过程链顺序 = 总结 → 工具。
 */
export function commitStreamTextToLastAssistant<T extends StreamItemLike>(
  prev: T[],
  text: string,
): T[] {
  const t = sanitizeAssistantTextForDisplay(text);
  if (!t) return prev;
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]?.message;
    if (m?.type !== "assistant" || m.parentToolUseId) continue;

    // 优先填充空 text 壳（stripPartial 留下的）
    const emptyTextIdx = m.content.findIndex(
      (b) => b.type === "text" && !textBlockText(b).trim(),
    );
    if (emptyTextIdx >= 0) {
      const content = [...m.content];
      content[emptyTextIdx] = { type: "text", text: t };
      const next = [...prev];
      next[i] = { ...prev[i]!, message: { ...m, content } };
      return next;
    }

    for (const b of m.content) {
      if (b.type !== "text") continue;
      const existing = textBlockText(b).trim();
      if (!existing) continue;
      // 已有内容更长或相同 → 视为已落盘，防与随后 sdk_message 双份。
      if (existing === t || existing.startsWith(t)) return prev;
      // streamState 可能比 sdk_message 先走完整；已有块只是它的前缀时，
      // 必须补全同一个正文块，否则下面清空 streamState 后只会留下半句话。
      if (t.startsWith(existing)) {
        const content = [...m.content];
        content[content.indexOf(b)] = { ...b, text: t };
        const next = [...prev];
        next[i] = { ...prev[i]!, message: { ...m, content } };
        return next;
      }
    }
    const content = [...m.content];
    const toolIdx = content.findIndex((b) => b.type === "tool_use");
    const block = { type: "text" as const, text: t };
    if (toolIdx >= 0) content.splice(toolIdx, 0, block);
    else content.push(block);
    const next = [...prev];
    next[i] = {
      ...prev[i]!,
      message: {
        ...m,
        content,
      },
    };
    return next;
  }
  return prev;
}

/**
 * 单真源流式（S2.1）：把一条 sdk_message assistant/user 按 **uuid 原地 upsert** 进 items。
 *
 * - 同 uuid：就地替换（partial→final 同 uuid 一条），不新增、不覆盖上一轮已完成 assistant。
 * - final（有 stop_reason 且非 `_partial`）**不被**后续 partial 覆盖（竞态保护，对齐 Proma）。
 * - 无 uuid 的 tool-only 中间态：按 tool_use id 就地更新，否则追加（禁止覆盖上一轮已完成 assistant）。
 * - 有 uuid 未命中时新增，绝不因位置/tool id 与另一个 uuid 合并。
 * - 无 uuid 终态才兼容落入最后一个 streaming assistant；否则 append（并清纯占位）。
 *
 * 与 Chat 的 streamState 清理分离：本函数只管 items 真源，streamState 由 Chat 按内容选择性清。
 * 见 docs/dev/core-loop/S1S2-single-source-brief.md。
 */
export function applySdkMessageToItems<T extends StreamItemLike>(
  prev: T[],
  message: TAgentMessage,
  allocKey: () => string,
): T[] {
  const msg = compactAssistantMessageForDisplay(message);
  const msgUuid =
    msg.type === "assistant" || msg.type === "user" ? msg.uuid : undefined;
  const stopReason = msg.type === "assistant" ? msg.stop_reason : undefined;
  const stillStreaming = msg.type === "assistant" && !stopReason;
  const incomingPartial = msg.type === "assistant" && msg._partial === true;

  const applyMsg = (it: T, merged: TAgentMessage = msg): T => ({
    ...it,
    message: merged,
    streamUuid: msgUuid ?? it.streamUuid,
    streaming: stillStreaming,
    streamingText: undefined,
    streamingThinking: undefined,
  });

  // 1) 同 uuid 就地更新（partial→final / partial→partial）
  if (msgUuid) {
    const uuidIdx = prev.findIndex(
      (it) =>
        it.streamUuid === msgUuid ||
        (it.message?.type === "assistant" && it.message.uuid === msgUuid) ||
        (it.message?.type === "user" && it.message.uuid === msgUuid),
    );
    if (uuidIdx >= 0) {
      const existing = prev[uuidIdx];
      const existingIsFinal =
        existing?.message?.type === "assistant" &&
        Boolean(existing.message.stop_reason) &&
        existing.message._partial !== true;
      // S2.1：final 不被迟到的 partial 覆盖（避免终态退回流式）
      if (existingIsFinal && incomingPartial) {
        return prev;
      }
      // 同 uuid 后到快照若剥掉 thinking，保留已有思考块（REGRESS-E：防「最后一段也没了」）
      // user：后到快照若没带 attachments，保留已有图（旁路回显 / 历史回放不要冲掉）
      const merged =
        existing?.message && msg.type === "assistant" && !msg._contentSnapshot
          ? preserveAssistantThinking(existing.message, msg)
          : existing?.message?.type === "user" && msg.type === "user"
            ? preserveUserAttachments(existing.message, msg)
            : msg;
      return prev.map((it, i) => (i === uuidIdx ? applyMsg(it, merged) : it));
    }
  }

  // 2) 仍在流式：无 uuid 的 tool-only 中间态应追加/就地更新，禁止覆盖上一轮已完成 assistant
  if (stillStreaming && !msgUuid) {
    const lastIdx = prev.length - 1;
    const last = prev[lastIdx];
    const onlyTools =
      msg.type === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      msg.content.every((b) => b.type === "tool_use");
    if (onlyTools) {
      const toolBlock = msg.content.find((b) => b.type === "tool_use");
      const toolId =
        toolBlock && typeof toolBlock === "object" && "id" in toolBlock
          ? String((toolBlock as { id: string }).id)
          : null;
      if (toolId) {
        const toolIdx = prev.findIndex(
          (it) =>
            it.message?.type === "assistant" &&
            Array.isArray(it.message.content) &&
            it.message.content.some(
              (b) =>
                b.type === "tool_use" &&
                typeof b === "object" &&
                "id" in b &&
                String((b as { id: string }).id) === toolId,
            ),
        );
        if (toolIdx >= 0) {
          const existing = prev[toolIdx];
          const merged =
            existing?.message && msg.type === "assistant"
              ? preserveAssistantThinking(existing.message, msg)
              : msg;
          return prev.map((it, i) =>
            i === toolIdx ? applyMsg(it, merged) : it,
          );
        }
      }
      return [
        ...prev,
        {
          key: allocKey(),
          message: msg,
          streamUuid: msgUuid,
          streaming: true,
        } as T,
      ];
    }
    if (last?.message?.type === "assistant" && last.streaming) {
      const merged =
        msg.type === "assistant"
          ? preserveAssistantThinking(last.message, msg)
          : msg;
      return prev.map((it, i) => (i === lastIdx ? applyMsg(it, merged) : it));
    }
  }

  // 3) Pi 核完成（有 stop_reason）→ 落盘最终 message：清 streaming 标记
  if (msg.type === "assistant" && stopReason && !msgUuid) {
    const lastIdx = prev.length - 1;
    const last = prev[lastIdx];
    if (last?.message?.type === "assistant" && last.streaming) {
      const merged = preserveAssistantThinking(last.message, msg);
      return prev.map((it, i) => (i === lastIdx ? applyMsg(it, merged) : it));
    }
  }

  return [
    ...purgeStreamingItems(prev),
    {
      key: allocKey(),
      message: msg,
      streamUuid: msgUuid,
      streaming: stillStreaming,
    } as T,
  ];
}
