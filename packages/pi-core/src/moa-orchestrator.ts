/**
 * MoA (Mixture-of-Agents) 编排器
 *
 * 参考 Hermes Agent 的 MoA 实现，适配 Pi + kscc bare。
 *
 * 架构：
 *   1. 参考模型层 (References)：多个模型并行跑同一问题，纯文本推理，无工具调用
 *   2. 聚合器层 (Aggregator)：接收所有参考输出 + 原始问题，综合判断给出最终答案（可调工具）
 *
 * 与 Xfast 的关系：MoA 是上层架构，Xfast 是下层优化（参考层内部可用 Xfast 竞争）
 */

import type { Context } from "@earendil-works/pi-ai";
import { spawnKsccBare } from "./kscc-spawn.ts";

/** 参考模型配置 */
export interface ReferenceModelConfig {
  /** 标识名（如 "glm-5.2-lite"） */
  name: string;
  /** kscc --model 参数 */
  modelId: string;
  /** 可选：覆盖 system prompt */
  systemPrompt?: string;
}

/** 参考模型输出结果 */
export interface ReferenceOutput {
  name: string;
  modelId: string;
  /** 参考模型生成的纯文本回答 */
  text: string;
  /** 耗时 ms */
  latencyMs: number;
  /** 是否成功（失败时 text 为错误信息） */
  ok: boolean;
}

/** 并行跑多个参考模型，收集输出 */
export async function runReferenceModels(
  userQuestion: string,
  references: ReferenceModelConfig[],
  opts: {
    /** 单个参考模型超时（默认 30s） */
    timeoutMs?: number;
    /** kscc 路径 */
    ksccPath?: string;
  } = {},
): Promise<ReferenceOutput[]> {
  const timeoutMs = opts.timeoutMs ?? 30000;

  // 并发启动所有参考模型
  const tasks = references.map(async (ref): Promise<ReferenceOutput> => {
    const start = Date.now();
    try {
      const text = await runOneReference(ref, userQuestion, timeoutMs, opts.ksccPath);
      return {
        name: ref.name,
        modelId: ref.modelId,
        text,
        latencyMs: Date.now() - start,
        ok: true,
      };
    } catch (err) {
      return {
        name: ref.name,
        modelId: ref.modelId,
        text: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
        ok: false,
      };
    }
  });

  return Promise.all(tasks);
}

/** 跑单个参考模型：纯文本推理，禁用工具 */
async function runOneReference(
  ref: ReferenceModelConfig,
  userQuestion: string,
  timeoutMs: number,
  ksccPath?: string,
): Promise<string> {
  const context: Context = {
    messages: [{ role: "user", content: userQuestion, timestamp: Date.now() }],
  };

  const proc = spawnKsccBare({
    ksccPath,
    modelId: ref.modelId,
    context: context as any,
    // 参考模型层：无工具（--tools ""），纯文本推理
    // 由 kscc-spawn 的 tools 参数控制，这里传空数组表示无可用工具
    tools: [],
  });

  // 收集 stdout NDJSON 中的文本内容
  let fullText = "";
  const timer = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  try {
    for await (const line of proc.lines) {
      try {
        const obj = JSON.parse(line);
        // 取 result 事件的最终文本，或累积 text_delta
        if (obj.type === "stream_event" && obj.event?.type === "content_block_delta" && obj.event.delta?.type === "text_delta") {
          fullText += obj.event.delta.text;
        }
        if (obj.type === "result" && typeof obj.result === "string") {
          // result.result 是最终完整回答
          fullText = obj.result; // 直接取最终，覆盖之前的增量
        }
      } catch {
        // 非 JSON 行忽略
      }
    }
  } finally {
    clearTimeout(timer);
    proc.kill();
  }

  await proc.wait();
  return fullText.trim();
}

// ============ 聚合器构造 ============

/** 构造聚合器的 system prompt，包含参考模型输出 */
export function buildAggregatorPrompt(
  userQuestion: string,
  refOutputs: ReferenceOutput[],
): string {
  const refSections = refOutputs.map((r) => {
    const status = r.ok ? "" : " [该参考模型运行失败]";
    return `\n[参考模型 ${r.name}${status}]\n<参考输出>\n${r.text}\n</参考输出>`;
  }).join("\n");

  return [
    "你是聚合器模型。你会看到多个参考模型对同一问题的回答。",
    "你的任务是：",
    "1. 分析各参考模型的优缺点",
    "2. 综合判断给出最佳答案",
    "3. 如有需要，可调用工具（Read/Bash/Edit）验证或执行",
    "",
    "参考模型输出已用 <参考输出> 标签包裹。",
    refSections,
    "",
    "[原始问题]",
    userQuestion,
    "",
    "请综合以上参考意见，给出最佳回答。可直接回答，或在需要时调用工具验证。",
  ].join("\n");
}

/** 构造聚合器的初始 Context */
export function buildAggregatorContext(
  userQuestion: string,
  refOutputs: ReferenceOutput[],
): Context {
  return {
    systemPrompt: buildAggregatorPrompt(userQuestion, refOutputs),
    messages: [], // 聚合器从 systemPrompt 开始，首条 user message 是隐含的原始问题
  };
}
