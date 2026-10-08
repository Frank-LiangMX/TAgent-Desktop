/**
 * MoA (Mixture-of-Agents) 编排器
 *
 * 参考 Hermes Agent 的 MoA 实现，适配 Pi + 外部 API 渠道。
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
import { createHttpDirectStreamFn } from "./http-direct-stream-fn.ts";

/** 参考模型配置 */
export interface ReferenceModelConfig {
  /** 标识名（如 "glm-5.2-lite"） */
  name: string;
  /** 模型 id（--model 参数语义） */
  modelId: string;
  /** 已配置渠道 id；缺省由宿主按当前渠道解析。 */
  channelId?: string;
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

// ============ 单席 runner：Pi HTTP 直连（外部 API 渠道） ============

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
 * 唯一实现：外部渠用 `createPiHttpSeatRunner`（历史 kscc bare 席 runner 已随 CLI 通路移除）。
 * 同场不混核：一个 runMoaTurn 全程只用一种 runner（由主进程按 channel 选定注入）。
 */
export interface MoASeatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface MoASeatRunResult {
  text: string;
  usage?: MoASeatUsage;
}

export interface MoASeatRunner {
  /** 兼容旧调用方：只返回正文。 */
  runSeat(args: MoASeatRunArgs): Promise<string>;
  /** 可选 usage 路径；宿主按结构探测，不能失败后再调用 runSeat。 */
  runSeatWithUsage?(args: MoASeatRunArgs): Promise<MoASeatRunResult>;
}

/** 按席位解析 runner，允许同一场 MoA 跨多个已配置渠道。 */
export type MoASeatRunnerFactory = (args: {
  modelId: string
  channelId?: string
}) => MoASeatRunner
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
  apiProtocol?: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
  provider: string;
  apiKey: string;
  baseUrl?: string;
  contextWindow?: number;
  headers?: Record<string, string>;
}): MoASeatRunner {
  const runSeatWithUsage = async (args: MoASeatRunArgs): Promise<MoASeatRunResult> => {
    const streamFn = createHttpDirectStreamFn({
      apiProtocol: opts.apiProtocol,
      provider: opts.provider,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      modelId: args.modelId,
      contextWindow: opts.contextWindow,
      headers: opts.headers,
    });
    const context: Context = {
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
      messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
      tools: [],
    };
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
    const usageValue = finalMessage?.usage;
    const usage: MoASeatUsage | undefined = usageValue
      ? {
          ...(usageValue.input !== undefined ? { inputTokens: usageValue.input } : {}),
          ...(usageValue.output !== undefined ? { outputTokens: usageValue.output } : {}),
          ...(usageValue.totalTokens !== undefined ? { totalTokens: usageValue.totalTokens } : {}),
          ...(usageValue.cacheRead !== undefined ? { cacheReadTokens: usageValue.cacheRead } : {}),
          ...(usageValue.cacheWrite !== undefined ? { cacheWriteTokens: usageValue.cacheWrite } : {}),
          ...(usageValue.cost?.input !== undefined || usageValue.cost?.output !== undefined
            ? { costUsd: (usageValue.cost?.input ?? 0) + (usageValue.cost?.output ?? 0) }
            : {}),
        }
      : undefined;
    return { text: text.trim(), ...(usage ? { usage } : {}) };
  };
  return {
    runSeat: async (args) => (await runSeatWithUsage(args)).text,
    runSeatWithUsage,
  };
}
/** 并行跑多个参考模型，收集输出 */
export async function runReferenceModels(
  userQuestion: string,
  references: ReferenceModelConfig[],
  opts: {
    /** 单个参考模型超时（默认 30s） */
    timeoutMs?: number;
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
     * 单席 runner（Pi HTTP 直连）。主进程按渠道 provider 选定注入；同场不混核。
     * 必填：历史 kscc bare 默认通路已移除。
     */
    seatRunner?: MoASeatRunner;
    /** 按参考/汇总席位独立选择 runner；优先于 seatRunner。 */
    seatRunnerFor?: MoASeatRunnerFactory;
  } = {},
): Promise<ReferenceOutput[]> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  // runner：主进程按渠道 provider 注入（Pi HTTP 直连）；未注入即失败，不静默回落。
  const fallbackRunner = opts.seatRunner;
  // 拼装最终 user 消息：历史 + 本轮议题（来自 composeMoaPrompt，纯函数做）
  const composedQuestion = opts.historyText
    ? `${opts.historyText}[本轮议题]\n${userQuestion}`
    : userQuestion;

  // 并发启动所有参考模型
  const tasks = references.map(async (ref): Promise<ReferenceOutput> => {
    const start = Date.now();
    opts.onSeatUpdate?.({ seatId: ref.seatId, name: ref.name, modelId: ref.modelId, status: "running" });
    try {
      const runner = opts.seatRunnerFor?.({ modelId: ref.modelId, channelId: ref.channelId }) ?? fallbackRunner
      if (!runner) throw new Error('MoA 缺少席 runner（历史 kscc bare 默认通路已移除，请注入 seatRunner）')
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
    signal?: AbortSignal;
    /** 流式正文增量回调（每段 text_delta 一次） */
    onTextDelta?: (text: string) => void;
    /** MoA 会话上下文（已含 header/footer），拼到 userQuestion 前。 */
    historyText?: string;
    /** 单席 runner（Pi HTTP 直连）。必填：历史 kscc bare 默认通路已移除。 */
    seatRunner?: MoASeatRunner;
    /** 按汇总席独立选择 runner；优先于 seatRunner。 */
    seatRunnerFor?: MoASeatRunnerFactory;
    /** 汇总席绑定的已配置渠道 id。 */
    seatChannelId?: string;
  } = {},
): Promise<AggregatorOutput> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const fallbackRunner = opts.seatRunner;
  const start = Date.now();
  const composedQuestion = opts.historyText
    ? `${opts.historyText}[本轮议题]\n${userQuestion}`
    : userQuestion;
  // 汇总席 system 段：参考席输出 + 综合指令（buildAggregatorPrompt 已含 historyText 段）
  const systemPrompt = buildAggregatorPrompt(userQuestion, refOutputs, opts.historyText);

  try {
    const runner = opts.seatRunnerFor?.({ modelId: aggregatorModelId, channelId: opts.seatChannelId }) ?? fallbackRunner
    if (!runner) throw new Error('MoA 缺少席 runner（历史 kscc bare 默认通路已移除，请注入 seatRunner）')
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
