/**
 * kscc bare 模型泵 streamFn
 *
 * 这是 M1 的核心：实现 Pi 的 StreamFn 接口，把 kscc -p --bare 当成"模型泵"接入 Pi 的 Agent loop。
 *
 * 流程：
 *   1. new AssistantMessageEventStream() 返回给 Pi（立即返回，不阻塞）
 *   2. 异步 spawn kscc bare，写 stdin（对话历史）
 *   3. 逐行读 stdout NDJSON，解析成 Pi 的 AssistantMessageEvent，push 给 stream
 *   4. 收到 result 事件 → push done（带最终 AssistantMessage）
 *   5. 任何失败 → push error（不 throw，遵守 StreamFn 契约）
 *   6. Pi 端过滤 <command> 等工具标记兜底（三件套第二道防线）
 *
 * 参考实现：pi-agent-core 的 packages/agent/src/proxy.ts 的 streamProxy，
 * 把 fetch(proxyUrl/api/stream) 换成 spawn('kscc', ['-p','--bare']) + 读 stdout NDJSON。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Api,
  Context,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { mapKsccLineToPiEvents, type KsccLine } from "./kscc-ndjson-parser.ts";
import { spawnKsccBare } from "./kscc-spawn.ts";
import { AssistantMessageBuilder } from "./assistant-message-builder.ts";
import type { ToolSchemaDescriptor } from "./antml-protocol.ts";

export interface CreateKsccBareStreamFnOptions {
  /** kscc 可执行文件路径，默认 "kscc" */
  ksccPath?: string;
  /** 默认模型 id（若 Agent 的 model 没指定用这个） */
  defaultModelId?: string;
  /** 可用工具的 schema 描述（注入 kscc bare system prompt，让模型用 antml:invoke 调用） */
  tools?: ToolSchemaDescriptor[];
}

/**
 * 创建一个接 kscc bare 的 streamFn。
 * 传给 `new Agent({ streamFn, ... })`。
 */
export function createKsccBareStreamFn(
  opts: CreateKsccBareStreamFnOptions = {},
): StreamFn {
  return ((
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const builder = new AssistantMessageBuilder(model);
    const modelId = resolveModelId(model, opts.defaultModelId);

    // 异步跑，不阻塞 stream 返回
    void runKsccBareStream({
      stream,
      builder,
      modelId,
      context,
      signal: options?.signal,
      ksccPath: opts.ksccPath,
      systemPromptAppend: context.systemPrompt,
      tools: opts.tools,
    });

    return stream;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as StreamFn;
}

// ============ 内部：跑一次 kscc bare 流 ============

interface RunOptions {
  stream: AssistantMessageEventStream;
  builder: AssistantMessageBuilder;
  modelId: string;
  context: Context;
  signal?: AbortSignal;
  ksccPath?: string;
  systemPromptAppend?: string;
  tools?: ToolSchemaDescriptor[];
}

async function runKsccBareStream(o: RunOptions): Promise<void> {
  let proc: ReturnType<typeof spawnKsccBare> | null = null;
  try {
    proc = spawnKsccBare({
      ksccPath: o.ksccPath,
      modelId: o.modelId,
      context: o.context,
      signal: o.signal,
      appendSystemPrompt: o.systemPromptAppend,
      tools: o.tools,
    });

    let sawDone = false;

    for await (const line of proc.lines) {
      // abort 检查
      if (o.signal?.aborted) {
        break;
      }

      let parsed: KsccLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 非 JSON 行（kscc 偶尔吐诊断信息），跳过
        continue;
      }

      const result = mapKsccLineToPiEvents(parsed, o.builder);

      // 过滤 <command> 标记兜底（三件套第二道防线）
      const cleanedEvents = result.events.map(filterCommandTags).filter(Boolean) as AssistantMessageEvent[];

      for (const ev of cleanedEvents) {
        if (o.stream) o.stream.push(ev);
      }

      if (result.done && !sawDone) {
        sawDone = true;
        const finalMessage = o.builder.build();
        if (result.done.isError) {
          o.stream.push({
            type: "error",
            reason: "error",
            error: { ...finalMessage, stopReason: "error", errorMessage: finalMessage.errorMessage ?? "kscc 返回错误" },
          });
        } else {
          o.stream.push({
            type: "done",
            reason: result.done.reason as "stop" | "length" | "toolUse",
            message: finalMessage,
          });
        }
        break;
      }
    }

    // 流正常结束但没收到 result 事件：补一个 done（防止 Pi loop 卡住）
    if (!sawDone) {
      if (o.signal?.aborted) {
        o.builder.setAborted();
        o.stream.push({ type: "error", reason: "aborted", error: o.builder.build() });
      } else {
        o.stream.push({ type: "done", reason: "stop", message: o.builder.build() });
      }
    }
  } catch (err) {
    // 不 throw，转成 error 事件（StreamFn 契约）
    const message = err instanceof Error ? err.message : String(err);
    o.builder.setError(message);
    if (o.signal?.aborted) {
      o.builder.setAborted();
      o.stream.push({ type: "error", reason: "aborted", error: o.builder.build() });
    } else {
      o.stream.push({ type: "error", reason: "error", error: o.builder.build() });
    }
  } finally {
    // 确保子进程被清理
    if (proc) proc.kill();
    o.stream.end();
  }
}

// ============ 工具函数 ============

/** 从 Pi 的 Model 对象解析出要传给 kscc --model 的模型 id */
function resolveModelId(model: Model<Api>, defaultId?: string): string {
  // Pi 的 Model.id 通常是 provider 的模型 id；kscc 要 kscc 认识的模型名
  // M1 简化：优先用 model.id，兜底 defaultModelId
  return model.id || defaultId || "glm-5.2";
}

/**
 * Pi 端过滤 <command> / <FilesystemTool> 等工具标记（三件套第二道防线）。
 * kscc bare 即使 --tools "" + system prompt 禁了，模型偶尔仍可能生成标记，
 * 在 streamFn 这层兜底剥离。
 *
 * 只处理 text_delta 和 text_end 的 content，把标记替换掉。
 */
function filterCommandTags(ev: AssistantMessageEvent): AssistantMessageEvent | null {
  // 只处理文本类事件
  if (ev.type === "text_delta") {
    const cleaned = stripCommandTags(ev.delta);
    if (!cleaned) return null; // 整段都是标记，丢弃
    return { ...ev, delta: cleaned };
  }
  if (ev.type === "text_end") {
    const cleaned = stripCommandTags(ev.content);
    return { ...ev, content: cleaned };
  }
  // 其他事件不动（thinking/toolcall 由 kscc 三件套保障，M1 阶段裸 kscc 无工具）
  return ev;
}

/** 剥离 <command>...</command>、<FilesystemTool>... 等标记 */
function stripCommandTags(text: string): string {
  return text
    .replace(/<command[^>]*>[\s\S]*?<\/command>/gi, "")
    .replace(/<command[^>]*>/gi, "")
    .replace(/<\/command>/gi, "")
    .replace(/<FilesystemTool>[\s\S]*?<\/FilesystemTool>/gi, "")
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, "");
}
