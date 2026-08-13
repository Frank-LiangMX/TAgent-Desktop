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

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import { spawnKsccBare } from "./kscc-spawn.ts";
import { createHttpDirectStreamFn } from "./http-direct-stream-fn.ts";

/** 参考模型配置 */
export interface ReferenceModelConfig {
  /** 标识名（如 "glm-5.2-lite"） */
  name: string;
  /** kscc --model 参数 */
  modelId: string;
  /** 可选：覆盖 system prompt */
  systemPrompt?: string;
  /** 席位稳定标识（透传给 onSeatUpdate，供主进程对位 panel 席位） */
  seatId?: string;
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

/** 单席进度回调载荷（runReferenceModels → 调用方，用于驱动圆桌卡） */
export type ReferenceSeatStatus = 'running' | 'ok' | 'failed' | 'cancelled'

export interface ReferenceSeatUpdate {
  seatId?: string;
  name: string;
  modelId: string;
  status: ReferenceSeatStatus;
  text?: string;
  error?: string;
  latencyMs?: number;
}

// ============ 单席 runner：kscc bare vs Pi HTTP 直连 ============

/**
 * 单席运行参数（参考席 / 汇总席共用）。
 * 编排层（`runReferenceModels` / `runAggregatorModel`）已把「会话上下文 + 本轮议题」
 * 拼进 `prompt`；`systemPrompt` 仅汇总席（`buildAggregatorPrompt`）或同模多角色参考席填。
 */
export interface MoASeatRunArgs {
  /** 真实 modelId（当前渠道下已启用；绝非 moa:*） */
  modelId: string;
  /** 已拼好「会话上下文 + 本轮议题」的完整用户消息 */
  prompt: string;
  /** 可选 system 段（汇总席 / 同模多角色参考席用） */
  systemPrompt?: string;
  /** 取消信号：abort 后 runner 尽快终止 */
  signal?: AbortSignal;
  /** 单席超时（ms） */
  timeoutMs?: number;
  /** 流式正文增量（汇总席推 UI；参考席不传） */
  onTextDelta?: (text: string) => void;
}

/**
 * 单席 runner：跑完一段纯文本（tools 语义=无工具）。
 * - 抛错 = 失败（调用方按 `signal.aborted` 区分 failed / cancelled）。
 * - 成功返回纯文本（已 trim）。
 *
 * 唯一可替换点：kscc 渠用 `createKsccSeatRunner`，外部渠用 `createPiHttpSeatRunner`。
 * 同场不混核：一个 runMoaTurn 全程只用一种 runner（由主进程按 channel 选定注入）。
 */
export interface MoASeatRunner {
  runSeat(args: MoASeatRunArgs): Promise<string>;
}

/**
 * kscc bare 席 runner：复用既有 `spawnKsccBare`，收集 NDJSON 中的 text_delta / result。
 * 与历史行为一致：`appendSystemPrompt` 仅在 `systemPrompt` 非空时注入。
 */
export function createKsccSeatRunner(opts: { ksccPath?: string }): MoASeatRunner {
  return {
    async runSeat(args: MoASeatRunArgs): Promise<string> {
      const context: Context = {
        messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
      };
      const proc = spawnKsccBare({
        ksccPath: opts.ksccPath,
        modelId: args.modelId,
        context: context as any,
        // 参考席 / 汇总席：纯文本无工具
        tools: [],
        ...(args.systemPrompt ? { appendSystemPrompt: args.systemPrompt } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });

      let fullText = "";
      let timedOut = false;
      const timeoutMs = args.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      const onAbort = () => proc.kill();
      if (args.signal) {
        if (args.signal.aborted) proc.kill();
        else args.signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        for await (const line of proc.lines) {
          if (args.signal?.aborted) break;
          try {
            const obj = JSON.parse(line);
            if (
              obj.type === "stream_event" &&
              obj.event?.type === "content_block_delta" &&
              obj.event.delta?.type === "text_delta"
            ) {
              const delta: string = obj.event.delta.text ?? "";
              if (delta) {
                fullText += delta;
                args.onTextDelta?.(delta);
              }
            }
            if (obj.type === "result" && typeof obj.result === "string") {
              fullText = obj.result;
            }
          } catch {
            // 非 JSON 行忽略
          }
        }
      } finally {
        clearTimeout(timer);
        if (args.signal) args.signal.removeEventListener("abort", onAbort);
        proc.kill();
      }

      const exitCode = await proc.wait();
      // 取消不是失败：交给上层按 signal 统一标成“已取消”。
      if (args.signal?.aborted) return "";
      if (timedOut) {
        throw new Error(`单席请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
      }
      if (exitCode !== 0) {
        const detail = typeof proc.stderr === "string" ? proc.stderr.trim() : "";
        throw new Error(detail || `kscc 进程异常退出（退出码 ${exitCode}）`);
      }
      const text = fullText.trim();
      if (!text) throw new Error("模型未返回正文");
      return text;
    },
  };
}

/** 从 AssistantMessage 抽取纯文本（拼接所有 text 块，跳过 thinking / toolCall） */
function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Pi HTTP 直连席 runner：复用 `createHttpDirectStreamFn` / `streamSimple`，tools=[]。
 * 凭据（apiKey / baseUrl / provider）由主进程解密后注入；runner 不落盘、不进圆桌卡。
 *
 * - 首包超时用 `timeoutMs`（预置 timeoutMsPerSeat），**不**用 30min 默认（SPEC §7）。
 * - 取消：`signal` 透传给 streamOptions；pi-ai 收到 abort 后流以 error 事件终止。
 * - 文本：迭代 `AssistantMessageEvent`，text_delta 流式推 `onTextDelta`，done.message 为权威终值。
 */
export function createPiHttpSeatRunner(opts: {
  provider: string;
  apiKey: string;
  baseUrl?: string;
}): MoASeatRunner {
  return {
    async runSeat(args: MoASeatRunArgs): Promise<string> {
      // 每席 modelId 不同 → 现场建 streamFn（createHttpDirectStreamFn 在工厂层固化 modelId）
      const streamFn = createHttpDirectStreamFn({
        provider: opts.provider,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        modelId: args.modelId,
      });
      const context: Context = {
        ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
        messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
        tools: [],
      };
      // http-direct streamFn 同步返回流（StreamFn 类型含 Promise 分支，先 await 规一化）
      const stream = await Promise.resolve(
        streamFn(undefined as unknown as Model<Api>, context, {
          ...(args.signal ? { signal: args.signal } : {}),
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        }),
      );

      let fullText = "";
      let finalMessage: AssistantMessage | undefined;
      for await (const ev of stream) {
        if (args.signal?.aborted) break;
        if (ev.type === "text_delta") {
          const delta = ev.delta ?? "";
          if (delta) {
            fullText += delta;
            args.onTextDelta?.(delta);
          }
        } else if (ev.type === "done") {
          finalMessage = ev.message;
        } else if (ev.type === "error") {
          throw new Error(ev.error.errorMessage || "外部模型请求失败");
        }
      }
      const text = finalMessage ? extractAssistantText(finalMessage) : fullText;
      return text.trim();
    },
  };
}

/** 并行跑多个参考模型，收集输出 */
export async function runReferenceModels(
  userQuestion: string,
  references: ReferenceModelConfig[],
  opts: {
    /** 单个参考模型超时（默认 30s） */
    timeoutMs?: number;
    /** kscc 路径（仅默认 kscc runner 用；注入 seatRunner 时忽略） */
    ksccPath?: string;
    /** 取消信号：abort 后未完成席位被 kill，标 cancelled */
    signal?: AbortSignal;
    /** 每席状态变更回调（running → ok/failed/cancelled） */
    onSeatUpdate?: (seat: ReferenceSeatUpdate) => void;
    /**
     * MoA 会话上下文文本（不带本轮议题，已含 header/footer）。
     * 主进程 runMoaTurn 调用 `composeMoaPrompt` 拼到 userQuestion 前。
     * 不传 = 行为不变（旧调用 / 普通对话兼容）。
     */
    historyText?: string;
    /**
     * 单席 runner（kscc bare / Pi HTTP 直连）。不传 → 默认 kscc bare（兼容旧行为）。
     * 主进程按渠道 provider 选定注入；同场不混核。
     */
    seatRunner?: MoASeatRunner;
  } = {},
): Promise<ReferenceOutput[]> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  // runner 分流：注入则用（外部渠 Pi HTTP）；否则默认 kscc bare（兼容旧调用 / 单测）
  const runner = opts.seatRunner ?? createKsccSeatRunner({ ksccPath: opts.ksccPath });
  // 拼装最终 user 消息：历史 + 本轮议题（来自 composeMoaPrompt，纯函数做）
  const composedQuestion = opts.historyText
    ? `${opts.historyText}[本轮议题]\n${userQuestion}`
    : userQuestion;

  // 并发启动所有参考模型
  const tasks = references.map(async (ref): Promise<ReferenceOutput> => {
    const start = Date.now();
    opts.onSeatUpdate?.({ seatId: ref.seatId, name: ref.name, modelId: ref.modelId, status: "running" });
    try {
      const text = await runner.runSeat({
        modelId: ref.modelId,
        prompt: composedQuestion,
        systemPrompt: ref.systemPrompt,
        signal: opts.signal,
        timeoutMs,
      });
      const latencyMs = Date.now() - start;
      if (opts.signal?.aborted) {
        opts.onSeatUpdate?.({ seatId: ref.seatId, name: ref.name, modelId: ref.modelId, status: "cancelled", latencyMs });
        return { name: ref.name, modelId: ref.modelId, text: "已取消", latencyMs, ok: false };
      }
      opts.onSeatUpdate?.({ seatId: ref.seatId, name: ref.name, modelId: ref.modelId, status: "ok", text, latencyMs });
      return { name: ref.name, modelId: ref.modelId, text, latencyMs, ok: true };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      const status: ReferenceSeatStatus = opts.signal?.aborted ? "cancelled" : "failed";
      opts.onSeatUpdate?.({ seatId: ref.seatId, name: ref.name, modelId: ref.modelId, status, error: errMsg, latencyMs });
      return { name: ref.name, modelId: ref.modelId, text: errMsg, latencyMs, ok: false };
    }
  });

  return Promise.all(tasks);
}

// ============ 聚合器 ============

/** 聚合器运行结果 */
export interface AggregatorOutput {
  text: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * 跑汇总模型：把参考席输出 + 原始问题喂给汇总模型，流式回调正文 delta。
 *
 * 本期 tools:[]（纯文本无工具）——参考席同样无工具。只读工具（Read 等）下轮再开，
 * 见 IMPLEMENT-FIX-NOTES。取消用 signal；abort 后尽快 kill 子进程。
 *
 * 可选 `historyText`（MoA 会话上下文）会被前置拼到 userQuestion；同步注入
 * `buildAggregatorPrompt` 的 system 段（保留「原始问题」语义标签）。
 */
export async function runAggregatorModel(
  userQuestion: string,
  refOutputs: ReferenceOutput[],
  aggregatorModelId: string,
  opts: {
    timeoutMs?: number;
    /** kscc 路径（仅默认 kscc runner 用；注入 seatRunner 时忽略） */
    ksccPath?: string;
    signal?: AbortSignal;
    /** 流式正文增量回调（每段 text_delta 一次） */
    onTextDelta?: (text: string) => void;
    /** MoA 会话上下文（已含 header/footer），拼到 userQuestion 前。 */
    historyText?: string;
    /** 单席 runner（kscc bare / Pi HTTP 直连）。不传 → 默认 kscc bare。 */
    seatRunner?: MoASeatRunner;
  } = {},
): Promise<AggregatorOutput> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const runner = opts.seatRunner ?? createKsccSeatRunner({ ksccPath: opts.ksccPath });
  const start = Date.now();
  const composedQuestion = opts.historyText
    ? `${opts.historyText}[本轮议题]\n${userQuestion}`
    : userQuestion;
  // 汇总席 system 段：参考席输出 + 综合指令（buildAggregatorPrompt 已含 historyText 段）
  const systemPrompt = buildAggregatorPrompt(userQuestion, refOutputs, opts.historyText);

  try {
    const text = await runner.runSeat({
      modelId: aggregatorModelId,
      prompt: composedQuestion,
      systemPrompt,
      signal: opts.signal,
      timeoutMs,
      onTextDelta: opts.onTextDelta,
    });
    const latencyMs = Date.now() - start;
    if (opts.signal?.aborted) return { text, ok: false, latencyMs, error: "已取消" };
    const trimmed = text.trim();
    if (!trimmed) return { text: "", ok: false, latencyMs, error: "汇总模型未返回正文" };
    return { text: trimmed, ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      text: "",
      ok: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============ 聚合器构造 ============

/** 构造聚合器的 system prompt，包含参考模型输出 */
export function buildAggregatorPrompt(
  userQuestion: string,
  refOutputs: ReferenceOutput[],
  historyText?: string,
): string {
  const refSections = refOutputs.map((r) => {
    const status = r.ok ? "" : " [该参考模型运行失败]";
    return `\n[参考模型 ${r.name}${status}]\n<参考输出>\n${r.text}\n</参考输出>`;
  }).join("\n");

  // historyText 是已经拼好的「[会话上下文]…\n\n」块；不为空则前置到 system 段，
  // 让汇总模型在 system 段也能看到上下文（用户段里同时也有，由 runAggregatorModel 注入）。
  const historySection = historyText ? `${historyText.trim()}\n\n` : "";

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
    historySection,
    "[原始问题]",
    userQuestion,
    "",
    "请综合以上参考意见，给出最佳回答。可直接回答，或在需要时调用工具验证。",
  ].filter((s) => s !== "").join("\n");
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
