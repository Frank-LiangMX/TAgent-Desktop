/**
 * Xfast 竞争调度 streamFn（简化版）
 *
 * 并发 spawn N 个 kscc bare，取最快完成的 winner。
 * 简化为：同时跑，第一个返回完整结果的作为 winner，其他 kill。
 * 暂不做 session 锁定（M3 基础版），M3.5 再加锁定和统计。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Model,
  type Api,
  type Context,
  type SimpleStreamOptions,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { AssistantMessageBuilder } from "./assistant-message-builder.ts";
import { mapKsccLineToPiEvents } from "./kscc-ndjson-parser.ts";
import { spawnKsccBare } from "./kscc-spawn.ts";
import type { ToolSchemaDescriptor } from "./antml-protocol.ts";

export interface XfastConfig {
  /** 候选模型池（modelId 列表） */
  modelPool: string[];
  /** 每轮竞争并发数（默认 3） */
  competitorCount?: number;
  /** kscc 路径 */
  ksccPath?: string;
  /** 工具 schema（注入 system prompt） */
  tools?: ToolSchemaDescriptor[];
}

export function createXfastStreamFn(config: XfastConfig): StreamFn {
  const competitorCount = config.competitorCount ?? 3;

  return (async (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessageEventStream> => {
    const stream = createAssistantMessageEventStream();
    const candidates = config.modelPool.slice(0, competitorCount);
    if (candidates.length === 0) throw new Error("Xfast modelPool 为空");

    // 并发启动所有候选
    const runners = candidates.map((modelId) => {
      const builder = new AssistantMessageBuilder(model);
      const proc = spawnKsccBare({
        ksccPath: config.ksccPath,
        modelId,
        context: context as any,
        signal: options?.signal,
        tools: config.tools,
      });
      return { modelId, proc, builder, events: [] as AssistantMessageEvent[], done: false };
    });

    // 为每个 runner pump 事件
    const pumpTasks = runners.map(async (r) => {
      try {
        for await (const line of r.proc.lines) {
          if (options?.signal?.aborted) break;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const result = mapKsccLineToPiEvents(parsed as any, r.builder);
          r.events.push(...result.events);
          if (result.done) {
            r.done = true;
            break;
          }
        }
      } catch {
        r.done = true;
      }
    });

    // 后台跑 pump，前台 race 取第一个 done
    void Promise.all(pumpTasks).finally(() => {
      // 全部结束后清理
      runners.forEach((r) => r.proc.kill());
    });

    // race 取 winner
    void (async () => {
      try {
        // 轮询等第一个 done
        while (true) {
          const winner = runners.find((r) => r.done);
          if (winner) {
            // push winner 的事件
            for (const ev of winner.events) stream.push(ev);
            // 最终 done
            const msg = winner.builder.build();
            stream.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg });
            break;
          }
          // 检查是否全部 done 但无 winner（理论上不会）
          if (runners.every((r) => r.done)) {
            const fallback = runners[0]!;
            for (const ev of fallback.events) stream.push(ev);
            const msg = fallback.builder.build();
            stream.push({ type: "done", reason: "stop", message: msg });
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      } catch (err) {
        const dummy = new AssistantMessageBuilder(model);
        dummy.setError(String(err));
        stream.push({ type: "error", reason: "error", error: dummy.build() });
      } finally {
        stream.end();
      }
    })();

    return stream;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as StreamFn;
}
