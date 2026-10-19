/**
 * HTTP 直连 streamFn
 *
 * 让外部渠道（DeepSeek/OpenAI/Anthropic 等）不走 kscc bare，直接 HTTP 请求。
 * 用 pi-ai 的原生 Provider stream，把 apiKey + baseUrl 注入 StreamOptions。
 *
 * 流程：
 *   1. 根据 provider 类型选择 pi-ai 的 Provider（anthropic/deepseek/openai/google）
 *   2. 构造 Model 对象（provider + api + baseUrl + id 等）
 *   3. 调用 provider.streamSimple(model, context, { apiKey, signal, reasoning })
 *   4. 返回 AssistantMessageEventStream，与 kscc bare streamFn 同款契约
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelCost,
  Provider,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";

/**
 * 默认 HTTP 首包超时：30 分钟。
 * OpenAI/Anthropic SDK 默认仅 10 分钟；多轮工具后上下文变大、thinking 模型
 * 在开始流式输出前可能处理很久，易触发 APIConnectionTimeoutError（"Request timed out."）。
 */
export const DEFAULT_HTTP_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

/** 默认客户端重试次数（短暂网络抖动 / 连接超时） */
export const DEFAULT_HTTP_STREAM_MAX_RETRIES = 2;

/** HTTP 直连模型的上下文窗口 fallback，和 Desktop 侧渠道解析保持一致。 */
export const DEFAULT_HTTP_CONTEXT_WINDOW = 200_000;

/** 归一化 HTTP 直连层使用的上下文窗口，拒绝 0/负数配置。 */
export function resolveHttpContextWindow(contextWindow?: number): number {
  return contextWindow && contextWindow > 0
    ? contextWindow
    : DEFAULT_HTTP_CONTEXT_WINDOW
}

/** HTTP 直连 streamFn 工厂选项 */
export interface CreateHttpDirectStreamFnOptions {
  apiProtocol?: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
  /** API provider 类型（决定用哪个 pi-ai Provider） */
  provider: "anthropic" | "deepseek" | "openai" | "google" | string;
  /** API Key（明文） */
  apiKey: string;
  /** Base URL（可选，覆盖 provider 默认） */
  baseUrl?: string;
  /** 模型 ID（如 claude-opus-4-7, deepseek-chat） */
  modelId: string;
  /**
   * 模型标称上下文窗口（token）。
   *
   * 必须和 Agent 初始 model 使用同一个窗口：pi-ai 会据此计算剩余输出预算。
   * 不传时沿用 200k fallback；不要再在这里写死一个比上层更小的窗口，
   * 否则长历史会把 maxTokens 错误夹到 1，模型看起来像是“只回复一个字”。
   */
  contextWindow?: number;
  /** 是否启用 thinking（默认 false） */
  thinkingEnabled?: boolean;
  /** thinking level（默认 'medium'） */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  /**
   * HTTP 请求超时（毫秒）。对 OpenAI 兼容 SDK 主要约束「到首包」的等待时间。
   * 默认 30 分钟（{@link DEFAULT_HTTP_STREAM_TIMEOUT_MS}）。
   */
  timeoutMs?: number;
  /** 客户端重试次数，默认 2 */
  maxRetries?: number;
  /**
   * 附加到上游请求的自定义头（如内网网关的客户端标识）。
   * 同时写入 `Model.headers` 与 `StreamOptions.headers`——pi-ai 会把两者一起
   * merge 进 `defaultHeaders`，两处都设可避免只认其一的版本差异。
   */
  headers?: Record<string, string>;
}

/**
 * 创建一个 HTTP 直连的 streamFn。
 * 传给 `new Agent({ streamFn, ... })`，与 createKsccBareStreamFn 互换。
 */
export function createHttpDirectStreamFn(
  opts: CreateHttpDirectStreamFnOptions,
): StreamFn {
  // 预选 provider 实例
  const provider = resolveProvider(opts.provider, opts.apiProtocol);
  // 预构造 Model 对象
  const model = buildHttpDirectModel(opts);

  return ((
    _model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    // 合并 streamOptions：工厂层的 apiKey + 调用层的 signal
    // timeoutMs / maxRetries 优先用调用层，其次工厂配置，最后放宽后的默认值
    // （SDK 默认 10 分钟对长上下文 + thinking 不够，易出现 Request timed out）
    const streamOptions: SimpleStreamOptions = {
      apiKey: opts.apiKey,
      signal: options?.signal,
      timeoutMs:
        options?.timeoutMs ?? opts.timeoutMs ?? DEFAULT_HTTP_STREAM_TIMEOUT_MS,
      maxRetries:
        options?.maxRetries ?? opts.maxRetries ?? DEFAULT_HTTP_STREAM_MAX_RETRIES,
      // 自定义头（网关客户端标识）；空对象不传，避免覆盖 SDK 默认
      ...(opts.headers && Object.keys(opts.headers).length > 0
        ? { headers: opts.headers }
        : {}),
      // thinking 配置
      ...(opts.thinkingEnabled
        ? { reasoning: opts.thinkingLevel ?? "medium" }
        : {}),
    };

    // 调用 provider 的 streamSimple（统一 API，自动处理 streaming 协议差异）
    return provider.streamSimple(model, context, streamOptions);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as StreamFn;
}

// ============ 内部：provider 解析 ============

/**
 * 判断 provider 是否走 Anthropic /v1/messages 协议。
 *
 * 对齐 1.x anthropic-adapter：这些 provider 的端点都是 Anthropic 协议兼容
 * （base URL 多带 /anthropic 后缀，如 minimax/kimi-api/xiaomi）。
 * 其余走 OpenAI 兼容协议。
 */
const ANTHROPIC_PROTOCOL_PROVIDERS = new Set([
  "anthropic",
  "anthropic-compatible",
  "deepseek",
  "kimi-api",
  "kimi-coding",
  "zhipu-coding",
  "minimax",
  "xiaomi",
  "xiaomi-token-plan",
  "qwen-anthropic",
  "kscc-gateway",
]);

/**
 * 按 provider 规范化 baseUrl。
 *
 * pi-ai 把 model.baseUrl 直接作为 Anthropic SDK 的 baseURL。SDK 行为：
 * - 纯域名 baseURL（如 https://v2.aicodee.com）→ SDK 自动拼 /v1/messages
 * - 已含 /v1 路径的 baseURL → SDK 拼 /messages
 * 所以这里**不主动补 /v1**（补了会导致 /v1/v1/messages 双重路径）。
 * 只做清理：去尾斜杠 + 去用户误填的 /messages 后缀。
 *
 * OpenAI / Google 协议端点：仅去尾斜杠。
 */
function normalizeBaseUrlForProvider(baseUrl: string, _provider: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  // 去用户误填的 /messages 后缀（Anthropic 协议端点常见误填）
  url = url.replace(/\/messages$/, "");
  return url;
}

/** 根据 provider 类型名选择 pi-ai Provider 实例（擦除 TApi，统一用 Provider<Api>） */
function resolveProvider(providerName: string, protocol?: CreateHttpDirectStreamFnOptions['apiProtocol']): Provider<Api> {
  if (protocol === 'anthropic-messages') return anthropicProvider() as Provider<Api>;
  if (protocol === 'openai-responses' || protocol === 'openai-chat') {
    return createProvider({
      id: providerName,
      name: providerName,
      auth: { apiKey: { name: providerName, resolve: async () => ({ auth: {} }) } },
      models: [],
      api: protocol === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi(),
    }) as Provider<Api>;
  }
  // Anthropic 协议类（含 anthropic-compatible / deepseek / kimi / minimax / xiaomi 等）
  if (ANTHROPIC_PROTOCOL_PROVIDERS.has(providerName)) {
    return anthropicProvider() as Provider<Api>;
  }
  switch (providerName) {
    case "google":
      return googleProvider() as Provider<Api>;
    case "openai":
    case "zhipu":
    case "doubao":
    case "qwen":
    case "custom":
    default:
      // OpenAI 兼容协议（含 zhipu/doubao/qwen/custom 及未知）
      return createProvider({
        id: providerName,
        name: providerName,
        auth: {
          apiKey: {
            name: providerName,
            resolve: async () => ({ auth: {} }),
          },
        },
        models: [],
        api: openAICompletionsApi(),
      }) as Provider<Api>;
  }
}

// ============ 内部：Model 构造 ============

/** 零成本占位（HTTP 直连不需要真实 cost 数据，provider 按 HTTP 计费） */
const ZERO_COST: ModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * 根据选项构造 pi-ai 的 Model 对象。
 *
 * 关键字段：
 * - api: 决定走哪个 HTTP 协议（anthropic-messages / openai-completions / openai-responses / google-generative-ai）
 * - provider: 与 provider.id 一致
 * - baseUrl: 覆盖默认端点
 * - reasoning: 是否支持 thinking
 */
export function buildHttpDirectModel(opts: CreateHttpDirectStreamFnOptions): Model<Api> {
  const { provider: providerName, modelId, baseUrl, thinkingEnabled } = opts;

  // 根据 provider 类型确定 api 和 provider id（对齐 resolveProvider 的协议分类）
  let api: Api;
  let providerId: string;

  if (opts.apiProtocol) {
    api = opts.apiProtocol === 'openai-chat' ? 'openai-completions' : opts.apiProtocol;
    providerId = opts.apiProtocol === 'anthropic-messages' ? 'anthropic' : providerName;
  } else if (ANTHROPIC_PROTOCOL_PROVIDERS.has(providerName)) {
    // Anthropic /v1/messages 协议（anthropic / anthropic-compatible / deepseek / kimi / minimax / xiaomi 等）
    api = "anthropic-messages";
    providerId = "anthropic";
  } else if (providerName === "google") {
    api = "google-generative-ai";
    providerId = "google";
  } else {
    // OpenAI 兼容协议（openai / zhipu / doubao / qwen / custom / 未知）
    // 注意：用 openai-completions（/v1/chat/completions）而非 openai-responses，
    // 国内中转端点普遍只支持 completions 协议，responses 协议会 "stream ended before terminal event"。
    api = "openai-completions";
    providerId = providerName;
  }

  // baseUrl 规范化：Anthropic 协议端点需要规范成可拼 /messages 的路径
  const normalizedBaseUrl = baseUrl ? normalizeBaseUrlForProvider(baseUrl, providerName) : "";

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api,
    provider: providerId,
    baseUrl: normalizedBaseUrl,
    reasoning: thinkingEnabled ?? false,
    // Custom channel models have no capability registry. Preserve supplied images
    // so pi-ai serializes them instead of silently stripping multimodal content.
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: resolveHttpContextWindow(opts.contextWindow),
    maxTokens: 8_192,
    // 自定义头同样挂在 Model 上；pi-ai 的 mergeHeaders 会与 options.headers 合并
    ...(opts.headers && Object.keys(opts.headers).length > 0
      ? { headers: opts.headers }
      : {}),
  };

  return model;
}
