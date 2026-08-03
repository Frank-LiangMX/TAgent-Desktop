/**
 * AssistantMessage 累积状态机
 *
 * kscc bare 的流式输出是一段一段来的（text_delta / thinking_delta / input_json_delta），
 * 而 Pi 的 AssistantMessageEvent 要求每个非终止事件都带一个 `partial: AssistantMessage`
 * （当前累积状态）。这个 builder 负责按 contentIndex 增量累积这些片段，并产出 snapshot。
 *
 * 参考：pi-ai 的 packages/agent/src/proxy.ts 里 streamProxy 的 partial 重建逻辑。
 */

import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
  StopReason,
  Api,
  ProviderId,
  Model,
} from "@earendil-works/pi-ai";

// content 数组里每个槽位正在累积的内容。用 null 表示"已 finalize 的块"（不再变），
// 否则是正在流式累积的块。结构上跟 AssistantMessage.content 一致，但 text/thinking
// 是可变字符串、tool_use 的 arguments 是半成品 JSON 字符串。
type ContentSlot =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; rawArguments: string };

export class AssistantMessageBuilder {
  private content: ContentSlot[] = [];
  private stopReason: StopReason = "stop";
  private errorMessage: string | undefined;
  private usage: Usage = emptyUsage();
  private readonly modelInfo: { api: Api; provider: ProviderId; model: string };

  constructor(model: Model<Api>) {
    this.modelInfo = {
      api: model.api,
      provider: model.provider,
      model: model.id,
    };
  }

  /** content_block_start：开一个新内容块 */
  startContentBlock(
    index: number,
    block:
      | { type: "text" }
      | { type: "thinking" }
      | { type: "tool_use"; id: string; name: string },
  ): void {
    // 保证数组长度（kscc 可能跳着发 index，虽然实测是连续的，稳妥起见填充）
    while (this.content.length < index) {
      this.content.push({ type: "text", text: "" });
    }
    if (block.type === "text") {
      this.content[index] = { type: "text", text: "" };
    } else if (block.type === "thinking") {
      this.content[index] = { type: "thinking", thinking: "" };
    } else {
      this.content[index] = {
        type: "tool_use",
        id: block.id,
        name: block.name,
        rawArguments: "",
      };
    }
  }

  /** text_delta：累积文本块的增量 */
  appendTextDelta(index: number, delta: string): void {
    const slot = this.content[index];
    if (slot && slot.type === "text") {
      slot.text += delta;
    }
  }

  /** thinking_delta：累积思考块的增量 */
  appendThinkingDelta(index: number, delta: string): void {
    const slot = this.content[index];
    if (slot && slot.type === "thinking") {
      slot.thinking += delta;
    }
  }

  /** input_json_delta：累积 tool_use 的半成品 JSON 参数 */
  appendToolCallDelta(index: number, delta: string): void {
    const slot = this.content[index];
    if (slot && slot.type === "tool_use") {
      slot.rawArguments += delta;
    }
  }

  /** content_block_stop：finalize 该块（tool_use 解析完整 JSON） */
  endContentBlock(index: number): void {
    const slot = this.content[index];
    if (slot && slot.type === "tool_use") {
      // 解析半成品 JSON，失败则兜底空对象（不让流崩）
      // 空字符串也兜底成空对象
      try {
        const parsed = slot.rawArguments === "" ? {} : JSON.parse(slot.rawArguments);
        // 存已解析的 arguments，用 type 标记 finalize
        (slot as ContentSlot & { arguments?: Record<string, unknown> }).arguments = parsed;
      } catch {
        (slot as ContentSlot & { arguments?: Record<string, unknown> }).arguments = {};
      }
    }
  }

  /** 记录 stop_reason（来自 message_delta / result） */
  setStopReason(reason: StopReason): void {
    this.stopReason = reason;
  }

  /** 填充 usage（来自 result 事件） */
  setUsage(usage: Partial<Usage> = {}): void {
    this.usage = {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
      cost: usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  /** 标记错误 */
  setError(message: string): void {
    this.errorMessage = message;
    this.stopReason = "error";
  }

  /** 标记中断 */
  setAborted(): void {
    this.stopReason = "aborted";
  }

  /** 构建当前累积的 AssistantMessage（snapshot 用，非 finalize） */
  snapshot(): AssistantMessage {
    return this.build();
  }

  /** 构建最终 AssistantMessage */
  build(): AssistantMessage {
    return {
      role: "assistant",
      content: this.content.map(slotToContent),
      api: this.modelInfo.api,
      provider: this.modelInfo.provider,
      model: this.modelInfo.model,
      usage: this.usage,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      timestamp: Date.now(),
    };
  }

  /**
   * 在 text 块结束后注入 antml 工具调用。
   * kscc bare 把工具调用写在 text 块的文本里（<antml:invoke>），而非结构化 tool_use 块。
   * Pi 端解析出 ToolCall 后，用这个方法：
   *   1. 把该 text 块的文本剥离 antml 标记（只保留自然语言）
   *   2. 为每个解析出的 call 追加一个 toolCall content 块
   *
   * @param textIndex 要处理的 text 块的 contentIndex
   * @param calls 解析出的工具调用（name + arguments）
   * @param idPrefix toolCall id 前缀（Pi loop 用 id 关联 tool result，这里生成唯一 id）
   * @returns 追加的 toolCall 块的 contentIndex 数组（用于产 toolcall_start/end 事件）
   */
  injectAntmlToolCalls(
    textIndex: number,
    calls: { name: string; arguments: Record<string, string> }[],
    idPrefix: string,
  ): number[] {
    const slot = this.content[textIndex];
    if (slot && slot.type === "text") {
      // 剥离 text 块里的 antml 标记
      slot.text = stripAntmlFromText(slot.text);
    }
    const addedIndices: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const idx = this.content.length;
      // 按 schema coerce 类型：arguments 原始是 string，按 JSON 尝试解析对象/数组/数字
      const args = coerceArguments(call.arguments);
      this.content.push({
        type: "tool_use",
        id: `${idPrefix}-${i}`,
        name: call!.name,
        rawArguments: JSON.stringify(args),
      });
      // finalize：直接设已解析的 arguments
      (this.content[idx] as ContentSlot & { arguments?: Record<string, unknown> }).arguments = args;
      addedIndices.push(idx);
    }
    return addedIndices;
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** ContentSlot → AssistantMessage.content 的元素 */
function slotToContent(slot: ContentSlot): TextContent | ThinkingContent | ToolCall {
  if (slot.type === "text") {
    return { type: "text", text: slot.text };
  }
  if (slot.type === "thinking") {
    return { type: "thinking", thinking: slot.thinking };
  }
  // tool_use：用 finalize 时解析的 arguments，兜底空对象
  const args = (slot as ContentSlot & { arguments?: Record<string, unknown> }).arguments ?? {};
  return {
    type: "toolCall",
    id: slot.id,
    name: slot.name,
    arguments: args,
  };
}

/** 剥离文本里的 antml:invoke / antml:parameter 标记，保留自然语言 */
function stripAntmlFromText(text: string): string {
  return text
    .replace(/<antml:invoke\s+name\s*=\s*["']?[^"'\s>]+["']?[^>]*>[\s\S]*?<\/antml:invoke>/g, "")
    .replace(/<antml:invoke\s+name\s*=\s*["']?[^"'\s>]+["']?[^>]*>/g, "")
    .replace(/<\/antml:invoke>/g, "")
    .replace(/<antml:parameter\s+name\s*=\s*["']?[^"'\s>]+["']?[^>]*>[\s\S]*?<\/antml:parameter>/g, "")
    .trim();
}

/** 把 antml 参数（原始 string）按 JSON 尝试 coerce 成对象/数组/数字/布尔 */
function coerceArguments(args: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = coerceValue(v);
  }
  return out;
}

function coerceValue(v: string): unknown {
  const trimmed = v.trim();
  // 空串
  if (trimmed === "") return "";
  // 布尔
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // 数字
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }
  // JSON 对象/数组
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v; // 解析失败保留原样
    }
  }
  return v;
}
