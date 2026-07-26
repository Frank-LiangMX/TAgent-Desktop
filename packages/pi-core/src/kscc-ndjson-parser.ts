/**
 * kscc bare NDJSON 流解析器
 *
 * kscc 以 `--output-format stream-json --include-partial-messages --verbose` 启动时，
 * stdout 每行一个 JSON。本模块把每行解析后，映射成 Pi 的 AssistantMessageEvent 数组。
 *
 * 实测事件结构（kscc 1.1.28 + glm-5.2）：
 *   - {"type":"stream_event","event":{...Anthropic原生事件...}}  ← 核心
 *   - {"type":"system","subtype":"thinking_tokens|status|init"}  ← kscc 自管，忽略
 *   - {"type":"result","usage":{...},"stop_reason":"end_turn",...} ← 最终结果
 *
 * 内层 Anthropic 事件 → Pi AssistantMessageEvent 映射见 mapStreamEvent。
 */

import type { AssistantMessageEvent, StopReason, Usage } from "@earendil-works/pi-ai";
import { AssistantMessageBuilder } from "./assistant-message-builder.ts";
import { parseAntmlInvokes, hasAntmlInvoke } from "./antml-protocol.ts";

// ============ kscc 输出行的 TypeScript 类型（只覆盖我们关心的字段） ============

/** kscc stdout 的一行（顶层信封） */
export interface KsccLine {
  type: "stream_event" | "system" | "result" | string;
  // stream_event 时内层是 Anthropic 原生事件
  event?: AnthropicStreamEvent;
  // system 时的事件子类型
  subtype?: string;
  // result 时的最终结果
  usage?: KsccUsage;
  stop_reason?: string;
  total_cost_usd?: number;
  modelUsage?: Record<string, KsccModelUsage>;
  is_error?: boolean;
  result?: string;
}

/** Anthropic Messages API 原生流式事件（kscc 内层 event） */
export interface AnthropicStreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  index?: number;
  content_block?: { type: string; text?: string; thinking?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface KsccUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface KsccModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
}

// ============ 解析结果 ============

/** 一行 NDJSON 解析后产出的：要 push 给 Pi 的事件 + 对 builder 的副作用指令 */
export interface ParsedLine {
  /** 要 push 给 AssistantMessageEventStream 的 Pi 事件（可能 0~多个） */
  events: AssistantMessageEvent[];
  /** 终止信号：收到 result 或 message_stop 后表示流结束，reason 给 done/error 用 */
  done?: { reason: "stop" | "length" | "toolUse" | "error" | "aborted"; isError: boolean };
  /** 最终 usage（来自 result 事件） */
  finalUsage?: Partial<Usage>;
  /** 最终 stopReason（来自 result/message_delta） */
  finalStopReason?: StopReason;
}

// ============ 核心映射函数 ============

/**
 * 把 kscc 的一行 NDJSON（已 parse 成对象）映射成 Pi 事件 + builder 副作用。
 * 直接 mutate builder（累积 partial），并返回要 push 的事件。
 */
export function mapKsccLineToPiEvents(
  line: KsccLine,
  builder: AssistantMessageBuilder,
): ParsedLine {
  const result: ParsedLine = { events: [] };

  switch (line.type) {
    case "stream_event": {
      if (!line.event) return result;
      mapStreamEvent(line.event, builder, result);
      return result;
    }
    case "result": {
      // 最终结果：提取 usage + stop_reason，标记 done
      if (line.usage) {
        result.finalUsage = ksccUsageToPi(line.usage, line.total_cost_usd, line.modelUsage);
        builder.setUsage(result.finalUsage);
      }
      const stopReason = mapStopReason(line.stop_reason);
      result.finalStopReason = stopReason;
      builder.setStopReason(stopReason);
      result.done = {
        reason: line.is_error ? "error" : stopReason,
        isError: Boolean(line.is_error),
      };
      return result;
    }
    case "system":
    default:
      // kscc 自管事件（thinking_tokens / status / init）和未知类型：忽略
      return result;
  }
}

/** 映射 Anthropic 原生 stream event → Pi AssistantMessageEvent */
function mapStreamEvent(
  ev: AnthropicStreamEvent,
  builder: AssistantMessageBuilder,
  result: ParsedLine,
): void {
  switch (ev.type) {
    case "message_start": {
      // 流开始，发 start 事件（带空 partial）
      result.events.push({ type: "start", partial: builder.snapshot() });
      return;
    }
    case "content_block_start": {
      const idx = ev.index ?? 0;
      const block = ev.content_block;
      if (!block) return;
      if (block.type === "text") {
        builder.startContentBlock(idx, { type: "text" });
        result.events.push({ type: "text_start", contentIndex: idx, partial: builder.snapshot() });
      } else if (block.type === "thinking") {
        builder.startContentBlock(idx, { type: "thinking" });
        result.events.push({
          type: "thinking_start",
          contentIndex: idx,
          partial: builder.snapshot(),
        });
      } else if (block.type === "tool_use") {
        builder.startContentBlock(idx, {
          type: "tool_use",
          id: block.id ?? "",
          name: block.name ?? "",
        });
        result.events.push({
          type: "toolcall_start",
          contentIndex: idx,
          partial: builder.snapshot(),
        });
      }
      return;
    }
    case "content_block_delta": {
      const idx = ev.index ?? 0;
      const delta = ev.delta;
      if (!delta) return;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        builder.appendTextDelta(idx, delta.text);
        result.events.push({
          type: "text_delta",
          contentIndex: idx,
          delta: delta.text,
          partial: builder.snapshot(),
        });
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        builder.appendThinkingDelta(idx, delta.thinking);
        result.events.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: delta.thinking,
          partial: builder.snapshot(),
        });
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        builder.appendToolCallDelta(idx, delta.partial_json);
        result.events.push({
          type: "toolcall_delta",
          contentIndex: idx,
          delta: delta.partial_json,
          partial: builder.snapshot(),
        });
      }
      // 其他 delta 类型忽略
      return;
    }
    case "content_block_stop": {
      const idx = ev.index ?? 0;
      builder.endContentBlock(idx);
      // 找出该 index 对应的块类型，发对应的 end 事件
      const slot = builder.snapshot().content[idx];
      if (slot?.type === "text") {
        // kscc bare 把工具调用写在 text 块里（antml:invoke 标记），非结构化 tool_use 块。
        // text 块结束时解析 antml，若有调用则注入为 toolCall content 块。
        const rawText = slot.text;
        if (hasAntmlInvoke(rawText)) {
          const calls = parseAntmlInvokes(rawText);
          if (calls.length > 0) {
            // 注入：剥离 text 里的标记 + 追加 toolCall 块
            const addedIndices = builder.injectAntmlToolCalls(
              idx,
              calls.map((c) => ({ name: c.name, arguments: c.arguments })),
              `antml-${idx}`,
            );
            // 先 push text_end（剥离后的自然语言文本）
            const strippedSlot = builder.snapshot().content[idx];
            result.events.push({
              type: "text_end",
              contentIndex: idx,
              content: strippedSlot?.type === "text" ? strippedSlot.text : "",
              partial: builder.snapshot(),
            });
            // 再为每个注入的 toolCall 块 push toolcall_start + toolcall_end
            for (let i = 0; i < addedIndices.length; i++) {
              const tcIdx = addedIndices[i]!;
              const tcSlot = builder.snapshot().content[tcIdx];
              result.events.push({
                type: "toolcall_start",
                contentIndex: tcIdx,
                partial: builder.snapshot(),
              });
              result.events.push({
                type: "toolcall_end",
                contentIndex: tcIdx,
                toolCall: tcSlot?.type === "toolCall" ? tcSlot : { type: "toolCall" as const, id: `antml-${idx}-${i}`, name: calls[i]!.name, arguments: {} },
                partial: builder.snapshot(),
              });
            }
            // 有工具调用 → 标记 stopReason 为 toolUse（Pi loop 据此跑工具循环）
            builder.setStopReason("toolUse");
            return;
          }
        }
        result.events.push({
          type: "text_end",
          contentIndex: idx,
          content: slot.text,
          partial: builder.snapshot(),
        });
      } else if (slot?.type === "thinking") {
        result.events.push({
          type: "thinking_end",
          contentIndex: idx,
          content: slot.thinking,
          partial: builder.snapshot(),
        });
      } else if (slot?.type === "toolCall") {
        result.events.push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: slot,
          partial: builder.snapshot(),
        });
      }
      return;
    }
    case "message_delta": {
      // 记录 stop_reason（kscc 用 "end_turn" 等）
      if (ev.delta?.stop_reason) {
        builder.setStopReason(mapStopReason(ev.delta.stop_reason));
      }
      // message_delta 也可能带 usage
      if (ev.usage) {
        builder.setUsage(ksccUsageToPi(ev.usage));
      }
      return;
    }
    case "message_stop": {
      // message_stop 本身不发 done，等 result 事件统一发 done
      // （result 事件紧跟在 message_stop 后，含完整 usage）
      return;
    }
    default:
      // 未知 Anthropic 事件类型：忽略
      return;
  }
}

// ============ 工具函数 ============

/** kscc 的 stop_reason → Pi 的 StopReason */
export function mapStopReason(reason?: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case undefined:
      return "stop";
    default:
      // 未知 reason 默认 stop
      return "stop";
  }
}

/** kscc usage → Pi Usage */
function ksccUsageToPi(
  usage: KsccUsage,
  totalCostUsd?: number,
  modelUsage?: Record<string, KsccModelUsage>,
): Partial<Usage> {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  // cost 优先用 total_cost_usd，其次从 modelUsage 取
  const costUSD = totalCostUsd ?? firstModelCostUsd(modelUsage) ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costUSD,
    },
  };
}

function firstModelCostUsd(modelUsage?: Record<string, KsccModelUsage>): number | undefined {
  if (!modelUsage) return undefined;
  const first = Object.values(modelUsage)[0];
  return first?.costUSD;
}
