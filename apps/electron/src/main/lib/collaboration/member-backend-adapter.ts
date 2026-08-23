/**
 * 成员后端适配器（Stage 2）
 *
 * 实现 02-RUNTIME-A2A-SPEC §12 的 MemberBackendAdapter（简化版：一次 turn 返回正文，
 * 不做 AsyncIterable 事件流）。Stage 2 只接 channel 后端：用成员绑定的 channelId/modelId
 * 真实调用外部渠道模型（@tagent/pi-core 的 seat runner，与会诊 run-moa-turn 同路），
 * 或显式配置的本机 CLI worker；不做 fake 回复。CLI worker 只允许进入服务工作区并要求 workspace-write。
 *
 * 渠道凭据在主进程解密，不进 renderer / 不进 run 记录。
 *
 * 设计参考：
 * - apps/electron/src/main/lib/ipc/session-service.ts runMoATurn（seat runner 选路 + 凭据）
 * - apps/electron/src/main/lib/memory/memory-llm-client.ts（resolveMemoryLlmChannel：取第一个 enabled 外部渠道）
 */
import {
  createKsccBareStreamFn,
  createKsccSeatRunner,
  createPiHttpSeatRunner,
  createHttpDirectStreamFn,
  type MoASeatRunner,
  type MoASeatUsage,
} from "@tagent/pi-core";
import {
  Agent,
  type AgentTool,
  type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  isAgentCompatibleProvider,
  resolveChannelDefaultModelId,
  sanitizeAssistantTextForDisplay,
  type Channel,
  type ProviderType,
  type CollaborationHostToolCall,
  type CollaborationPermissionProfile,
  type CollaborationHostToolHandler,
  type CollaborationMemberCapabilities,
  type MemberBackendAdapter,
  type MemberSessionLifecycleAdapter,
  type MemberTurnInput,
  type MemberTurnResult,
} from "@tagent/shared";
import {
  getChannel,
  getDecryptedApiKey,
  listChannels,
} from "../channel/channel-store";
import { resolveKsccPath } from "../adapters/claude/kscc-path";
import { resolveTaskSubagentBackend } from "../agent/cli-workers/resolve-backend";
import { runCliWorker } from "../agent/cli-workers/run-cli-worker";

/** 单 turn 超时（ms）；外部渠道长回复兜底，取消由 AbortSignal 即时生效 */
const MEMBER_TURN_TIMEOUT_MS = 120_000;

type RoomAssistantSnapshot = {
  role?: string;
  content?: unknown;
};

/**
 * Pi 的 message_update.partial 是一条 assistant turn 的累计快照；不能把每一轮
 * text_delta 直接拼成最终正文，否则工具循环中的中间说明会和最终说明重复落盘。
 */
function extractAssistantSnapshotText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const message = value as RoomAssistantSnapshot;
  if (message.role && message.role !== "assistant") return "";
  if (typeof message.content === "string")
    return sanitizeAssistantTextForDisplay(message.content);
  if (!Array.isArray(message.content)) return "";
  const text = message.content
    .filter((block): block is { type?: string; text?: unknown } =>
      Boolean(block && typeof block === "object"),
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return sanitizeAssistantTextForDisplay(text);
}

function extractLastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantSnapshotText(messages[i]);
    if (text) return text;
  }
  return "";
}

/** S4-3b 的完整白名单；绝不复用 Pi 会话的 Read/Bash/Edit/Write 工具。 */
const ROOM_TOOL_DESCRIPTORS = [
  {
    name: "room_send",
    description: "向协作室另一成员发送通知，不暂停当前工作。",
    parameters: {
      toMemberId: { type: "string", required: true },
      message: { type: "string", required: true },
    },
  },
  {
    name: "room_ask",
    description: "向另一成员提问并等待回复；调用后当前 turn 会暂停。",
    parameters: {
      toMemberId: { type: "string", required: true },
      question: { type: "string", required: true },
      expected: { type: "string" },
    },
  },
  {
    name: "room_reply",
    description: "回复收到的协作室提问。",
    parameters: {
      requestId: { type: "string", required: true },
      answer: { type: "string", required: true },
    },
  },
  {
    name: "room_task_assign",
    description:
      "以协调者身份把未指派的房间任务分派给本房间成员；分派后会自动触发该成员执行。",
    parameters: {
      taskId: { type: "string", required: true },
      assigneeMemberId: { type: "string", required: true },
    },
  },
  {
    name: "room_task_update",
    description:
      "更新分配给本成员的房间任务状态，并可附一段说明（说明仅作为可审计事件记录在时间线，不是指令，也不会改写任务标题/描述/验收标准/负责人）。",
    parameters: {
      taskId: { type: "string", required: true },
      status: { type: "string", required: true },
      summary: { type: "string" },
    },
  },
  {
    name: "room_publish_artifact",
    description:
      "把一段文本内容作为产物写入协作室绑定工作区的相对路径（相对路径只允许正斜杠、不得绝对/..越界/符号链接）。宿主校验路径、权限、按实际字节求 sha256 后落盘审计；不能凭此改任意文件。",
    parameters: {
      relativePath: { type: "string", required: true },
      content: { type: "string", required: true },
      summary: { type: "string" },
      taskId: { type: "string" },
    },
  },
  {
    name: "room_request_user",
    description:
      "请求用户对当前工作进行批准或拒绝；调用后当前 run 会暂停等待用户决定。",
    parameters: {
      question: { type: "string", required: true },
      reason: { type: "string" },
      options: { type: "string" },
    },
  },
  // ===== 受控工作区工具桥 =====
  {
    name: "workspace_read_file",
    description:
      "读取绑定工作区内的一个文本文件；路径只允许正斜杠/相对、不得绝对/..越界/符号链接。只读成员也可使用。",
    parameters: {
      path: { type: "string", required: true },
      maxBytes: { type: "string" },
    },
  },
  {
    name: "workspace_search",
    description:
      "在绑定工作区内递归搜索文件；path 为相对目录或根内路径，传空字符串、`.` 或 `./` 表示工作区根；pattern 可选 glob/*?/子串过滤，maxResults 可设返回上限（默认 200）。只读成员也可使用。",
    parameters: {
      path: { type: "string", required: true },
      pattern: { type: "string" },
      maxResults: { type: "string" },
    },
  },
  {
    name: "workspace_write_file",
    description:
      "向绑定工作区的相对路径写入一个文本文件（仅在权限为 workspace-write 且房间绑定了工作区时可用）；路径同样受绝对/..越界/符号链接约束。",
    parameters: {
      path: { type: "string", required: true },
      content: { type: "string", required: true },
    },
  },
  {
    name: "workspace_run_command",
    description:
      "在绑定工作区内执行一条白名单项目命令（git/bun/npm/pnpm/yarn/node/python等）；args 传 JSON 字符串数组、cwd 可为工作区内相对子目录。仅 workspace-write 成员可用。",
    parameters: {
      command: { type: "string", required: true },
      args: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "string" },
    },
  },
  {
    name: "workspace_apply_patch",
    description:
      "对绑定工作区内的一个文本文件做精确字符串替换：oldText 必须在文件里恰好出现一次（找不到或不唯一都拒绝），替换为新内容 newText。路径受绝对/..越界/符号链接约束。仅 workspace-write 成员可用。",
    parameters: {
      path: { type: "string", required: true },
      oldText: { type: "string", required: true },
      newText: { type: "string", required: true },
    },
  },
  {
    name: "workspace_delete_file",
    description:
      "删除绑定工作区内的一个普通文件（目录、符号链接或不存在一律拒绝）。路径受绝对/..越界/符号链接约束。仅 workspace-write 成员可用。",
    parameters: {
      path: { type: "string", required: true },
    },
  },
  {
    name: "workspace_move_file",
    description:
      "把绑定工作区内的一个文件移动/重命名到另一相对路径；目标已存在（文件或目录）一律拒绝。源与目标都受绝对/..越界/符号链接约束。仅 workspace-write 成员可用。",
    parameters: {
      fromPath: { type: "string", required: true },
      toPath: { type: "string", required: true },
    },
  },
] as const;

const roomSendSchema = Type.Object(
  { toMemberId: Type.String(), message: Type.String() },
  { additionalProperties: false },
);
const roomAskSchema = Type.Object(
  {
    toMemberId: Type.String(),
    question: Type.String(),
    expected: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const roomReplySchema = Type.Object(
  { requestId: Type.String(), answer: Type.String() },
  { additionalProperties: false },
);
const roomTaskAssignSchema = Type.Object(
  { taskId: Type.String(), assigneeMemberId: Type.String() },
  { additionalProperties: false },
);
const roomTaskUpdateSchema = Type.Object(
  {
    taskId: Type.String(),
    status: Type.String(),
    summary: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const roomPublishArtifactSchema = Type.Object(
  {
    relativePath: Type.String(),
    content: Type.String(),
    summary: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const roomRequestUserSchema = Type.Object(
  {
    question: Type.String(),
    reason: Type.Optional(Type.String()),
    options: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// ===== workspace 工具桥 TypeBox schema =====

const workspaceReadFileSchema = Type.Object(
  {
    path: Type.String(),
    maxBytes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const workspaceSearchSchema = Type.Object(
  {
    path: Type.String(),
    pattern: Type.Optional(Type.String()),
    maxResults: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const workspaceWriteFileSchema = Type.Object(
  {
    path: Type.String(),
    content: Type.String(),
  },
  { additionalProperties: false },
);
const workspaceRunCommandSchema = Type.Object(
  {
    command: Type.String(),
    args: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const workspaceApplyPatchSchema = Type.Object(
  {
    path: Type.String(),
    oldText: Type.String(),
    newText: Type.String(),
  },
  { additionalProperties: false },
);
const workspaceDeleteFileSchema = Type.Object(
  {
    path: Type.String(),
  },
  { additionalProperties: false },
);
const workspaceMoveFileSchema = Type.Object(
  {
    fromPath: Type.String(),
    toPath: Type.String(),
  },
  { additionalProperties: false },
);

/** channel 后端能力（S2 诚实标记：无 resume/工具/实时输入） */
const CHANNEL_BACKEND_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
};

/** 解析出的后端配置（主进程内部，含解密 apiKey / ksccPath，不落盘不外传 renderer） */
interface ResolvedChannelBackend {
  /** 'external' 走 Pi HTTP 直连；'kscc' 走 kscc bare 子进程 */
  kind: "external" | "kscc";
  /** 渠道记录（用于错误提示带上渠道名） */
  channelName: string;
  /** 供应商类型（createPiHttpSeatRunner 需要；kscc 分支空串占位） */
  provider: ProviderType;
  /** 实际使用的模型 ID（member.modelId > 渠道默认 > 首个 enabled） */
  modelId: string;
  /** 外部渠道解密后的 apiKey（kind==='external' 时） */
  apiKey?: string;
  /** 外部渠道 baseUrl（kind==='external' 时） */
  baseUrl?: string;
  /** kscc 可执行路径（kind==='kscc' 时） */
  ksccPath?: string;
}

/** 后端解析失败（run 据此置 failed 并向用户展示原因） */
export class MemberBackendResolveError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MemberBackendResolveError";
  }
}

/**
 * 解析成员的后端配置：
 * - 成员显式绑定 channelId：用该渠道（必须 enabled）；kscc-internal 走 kscc runner，
 *   其余走 Pi HTTP 直连。
 * - 成员未绑定 channelId：优先 enabled 且本机可用的 kscc-internal，再回落 enabled 外部渠道；
 *   皆无则抛 MemberBackendResolveError('NO_CHANNEL_BACKEND', …)。
 *
 * modelId 解析：member.modelId > resolveChannelDefaultModelId(channel) > 首个 enabled 模型。
 * 显式 channelId 指向 kscc-internal 时不要求 apiKey（走 ksccPath）；外部渠道要求 apiKey 非空。
 */
export function resolveChannelBackendConfig(input: {
  channelId?: string;
  modelId?: string;
}): ResolvedChannelBackend {
  // 1) 显式绑定 channelId
  if (input.channelId) {
    return resolveBoundChannel(input.channelId, input.modelId);
  }

  // 2) 未绑定：kscc 优先（本机有 CLI 且渠道 enabled），再外部渠道
  const unbound = pickDefaultChannelBackend(input.modelId);
  if (unbound) return unbound;

  throw new MemberBackendResolveError(
    "NO_CHANNEL_BACKEND",
    "没有可用的渠道：请启用 kscc 内网（并安装 kscc 命令），或配置并启用一个外部渠道（含 API Key 与模型）",
  );
}

/**
 * 新建房间 / 默认协调者用：挑一个可跑的 channelId+modelId。
 * 顺序与未绑定解析一致：kscc（可用）→ 外部。
 */
export function pickDefaultMemberChannelBinding(): {
  channelId: string;
  modelId: string;
} | null {
  // kscc 优先
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider !== "kscc-internal") continue;
    if (!resolveKsccPath()) continue;
    const modelId = resolveModelId(channel, undefined);
    if (!modelId) continue;
    return { channelId: channel.id, modelId };
  }
  // 外部
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider === "kscc-internal") continue;
    if (!getDecryptedApiKey(channel.id)) continue;
    const modelId = resolveModelId(channel, undefined);
    if (!modelId) continue;
    return { channelId: channel.id, modelId };
  }
  return null;
}

function resolveBoundChannel(
  channelId: string,
  memberModelId?: string,
): ResolvedChannelBackend {
  const channel = getChannel(channelId);
  if (!channel) {
    throw new MemberBackendResolveError(
      "NO_CHANNEL",
      `成员绑定的渠道已删除（id=${channelId}），请重新配置成员后端`,
    );
  }
  if (!channel.enabled) {
    throw new MemberBackendResolveError(
      "CHANNEL_DISABLED",
      `渠道「${channel.name}」未启用，请在设置 → 渠道中启用后再发消息`,
    );
  }
  const modelId = resolveModelId(channel, memberModelId);
  if (!modelId) {
    throw new MemberBackendResolveError(
      "NO_MODEL",
      `渠道「${channel.name}」没有可用模型，请在渠道管理中添加并启用模型`,
    );
  }
  if (channel.provider === "kscc-internal") {
    const ksccPath = resolveKsccPath();
    if (!ksccPath) {
      throw new MemberBackendResolveError(
        "NO_KSCC",
        "未检测到 kscc 命令，请先安装 kscc（内网渠道）后再启用该渠道",
      );
    }
    return {
      kind: "kscc",
      channelName: channel.name,
      provider: channel.provider,
      modelId,
      ksccPath,
    };
  }
  const apiKey = getDecryptedApiKey(channel.id);
  if (!apiKey) {
    throw new MemberBackendResolveError(
      "NO_API_KEY",
      `渠道「${channel.name}」未配置 API Key，请在渠道管理中填写`,
    );
  }
  return {
    kind: "external",
    channelName: channel.name,
    provider: channel.provider,
    modelId,
    apiKey,
    baseUrl: channel.baseUrl,
  };
}

/** 未绑定时的默认解析（kscc → 外部） */
function pickDefaultChannelBackend(
  memberModelId?: string,
): ResolvedChannelBackend | null {
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider !== "kscc-internal") continue;
    const ksccPath = resolveKsccPath();
    if (!ksccPath) continue;
    const modelId = resolveModelId(channel, memberModelId);
    if (!modelId) continue;
    return {
      kind: "kscc",
      channelName: channel.name,
      provider: channel.provider,
      modelId,
      ksccPath,
    };
  }
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider === "kscc-internal") continue;
    const apiKey = getDecryptedApiKey(channel.id);
    if (!apiKey) continue;
    const modelId = resolveModelId(channel, memberModelId);
    if (!modelId) continue;
    return {
      kind: "external",
      channelName: channel.name,
      provider: channel.provider,
      modelId,
      apiKey,
      baseUrl: channel.baseUrl,
    };
  }
  return null;
}

/** 解析最终模型 ID：成员显式 > 渠道默认（且 enabled）> 首个 enabled 模型 */
function resolveModelId(
  channel: Channel,
  memberModelId?: string,
): string | undefined {
  if (memberModelId) return memberModelId;
  return (
    resolveChannelDefaultModelId(channel) ??
    channel.models.find((m) => m.enabled)?.id
  );
}

/**
 * Channel 后端适配器：一次 turn 真实调用外部渠道 / kscc 模型并返回正文。
 *
 * 取消：input.signal 透传给 seat runner；abort 即抛错，调用方据 signal.aborted 置 cancelled。
 */
/**
 * CLI worker 融合成员路径：CLI 工具自身拥有工作区副作用，因此必须满足：
 * - 房间有宿主注入的物理工作区；
 * - 成员显式为 workspace-write；
 * - worker 必须来自已启用且本机可用的受支持工人池。
 * 任何条件不满足都 fail-closed，不回退到普通渠道，避免用户配置的 cli 成员悄悄换后端。
 */
async function runCliRoomTurn(
  input: MemberTurnInput,
): Promise<MemberTurnResult> {
  if (input.permissionProfile !== "workspace-write") {
    throw new MemberBackendResolveError(
      "CLI 融合成员必须使用 workspace-write 权限，避免绕过只读工具边界",
      "CLI_PERMISSION_REQUIRED",
    );
  }
  const workspaceRoot = input.workspaceRoot?.trim();
  if (!workspaceRoot) {
    throw new MemberBackendResolveError(
      "CLI 融合成员没有可用的房间服务工作区",
      "CLI_WORKSPACE_REQUIRED",
    );
  }
  const resolved = resolveTaskSubagentBackend({
    preferredCliId: input.cliWorkerId,
  });
  if (resolved.kind !== "cli") {
    throw new MemberBackendResolveError(
      "指定的 CLI 工人未启用或本机不可用",
      "CLI_UNAVAILABLE",
    );
  }
  const prompt = [
    input.systemPrompt.trim(),
    "",
    "## 当前融合会话任务",
    input.prompt.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  const result = await runCliWorker({
    worker: resolved.worker,
    prompt,
    cwd: workspaceRoot,
    sessionId: input.logicalSessionId ?? input.runId,
    signal: input.signal,
    onTextChunk: input.onTextDelta,
  });
  if (!result.ok) {
    throw new Error(result.summary || "CLI 工人执行失败");
  }
  const text = result.summary.trim();
  if (!text) throw new Error("CLI 工人未返回正文");
  return {
    text,
    usage: { wallTimeMs: result.durationMs },
  };
}

/**
 * Channel 后端适配器：一次 turn 真实调用外部渠道 / kscc 模型并返回正文。
 *
 * 取消：input.signal 透传给 seat runner；abort 即抛错，调用方据 signal.aborted 置 cancelled。
 *
 * P1-2b：可选注入 {@link MemberSessionLifecycleAdapter}。注入后 runTurn 内把 input.signal 与
 * 该 session 的 interrupt controller 组合成一个 AbortSignal（lifecycle.bindTurnAbort）再透传，
 * 使 lifecycle.interruptSession 能取消进行中的 turn。未注入时行为不变（直接用 input.signal），
 * 既有调用方与测试零影响。
 */
export class ChannelBackendAdapter implements MemberBackendAdapter {
  /**
   * @param lifecycle 可选生命周期适配器；注入后 runTurn 透传组合 signal，
   * 使 interruptSession 可取消进行中的 turn。未注入时 runTurn 直接用 input.signal。
   */
  constructor(private readonly lifecycle?: MemberSessionLifecycleAdapter) {}

  capabilities(): CollaborationMemberCapabilities {
    return CHANNEL_BACKEND_CAPABILITIES;
  }

  async runTurn(input: MemberTurnInput): Promise<MemberTurnResult> {
    if (input.backend === "cli") return runCliRoomTurn(input);
    const cfg = resolveChannelBackendConfig({
      channelId: input.channelId,
      modelId: input.modelId,
    });

    // P1-2b：组合 input.signal 与 session interrupt controller（若注入 lifecycle 且有
    // logicalSessionId）。未注入 / 无 logicalSessionId 时 turnSignal === input.signal、
    // turnInput === input，行为与既有完全一致（interrupt 需 sessionId 寻址，无则不组合）。
    const turnSignal =
      this.lifecycle && input.logicalSessionId
        ? this.lifecycle.bindTurnAbort(input.logicalSessionId, input.signal)
        : input.signal;
    const turnInput =
      turnSignal === input.signal ? input : { ...input, signal: turnSignal };

    // 只有本机 kscc 模型泵具备「Pi Agent 执行受限 host tools，再把结果回灌模型」的
    // 实际闭环。外部 HTTP 渠道仍走纯文本 runner，保持 fail-closed。
    if (
      cfg.kind === "kscc" &&
      input.hostToolHandler &&
      input.capabilities?.supportsToolBridge !== false
    ) {
      return runKsccRoomToolTurn({
        input: turnInput,
        modelId: cfg.modelId,
        ksccPath: cfg.ksccPath,
      });
    }

    // 外部渠道：仅原生 function/tool calling 协议（Anthropic /v1/messages）且宿主注入
    // hostToolHandler 时，才用真实 AgentTool 经供应商原生 tool_use 接桥；execute 转发宿主
    // handler 真实校验/执行，结果由 Agent 自动回注下一轮 context。绝不通过 prompt 文本
    // 伪造工具。无原生工具能力 / 无 host handler → fail closed 走下方纯文本 runner。
    if (
      cfg.kind === "external" &&
      input.hostToolHandler &&
      input.capabilities?.supportsToolBridge !== false &&
      isAgentCompatibleProvider(cfg.provider)
    ) {
      return runExternalRoomToolTurn({ input: turnInput, cfg });
    }

    const runner: MoASeatRunner =
      cfg.kind === "kscc"
        ? createKsccSeatRunner({ ksccPath: cfg.ksccPath })
        : createPiHttpSeatRunner({
            provider: cfg.provider,
            apiKey: cfg.apiKey ?? "",
            baseUrl: cfg.baseUrl,
          });

    const runArgs = {
      modelId: cfg.modelId,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      signal: turnSignal,
      timeoutMs: MEMBER_TURN_TIMEOUT_MS,
      onTextDelta: input.onTextDelta,
    };
    // 按结构选择唯一一次执行路径；不能新接口失败后再调用旧接口，避免重复请求/重复扣费。
    const result = runner.runSeatWithUsage
      ? await runner.runSeatWithUsage(runArgs)
      : { text: await runner.runSeat(runArgs) };
    return {
      text: result.text,
      ...(result.usage ? { usage: mapMoASeatUsage(result.usage) } : {}),
    };
  }
}

/**
 * 能力声明用的保守 probe：
 * - kscc-internal：走 antml 文本协议工具桥（runKsccRoomToolTurn）。
 * - 外部渠道：仅当走原生 function/tool calling 协议（Anthropic /v1/messages，即
 *   isAgentCompatibleProvider）时才声明支持；此时 runExternalRoomToolTurn 用真实
 *   AgentTool 经供应商原生 tool_use 接桥。
 * - OpenAI-completions / google 等不在此列 → false，保持纯文本回复（fail closed），
 *   绝不通过 prompt 文本伪造工具，也绝不假装支持。
 */
export function channelSupportsRoomToolBridge(channelId?: string): boolean {
  if (!channelId) return false;
  const channel = getChannel(channelId);
  if (!channel) return false;
  if (channel.provider === "kscc-internal") return true;
  return isAgentCompatibleProvider(channel.provider);
}

/**
 * 构造协作室工具桥的 14 把受控 AgentTool：7 把 room_* + 7 把 workspace_*。
 *
 * 安全契约（02-RUNTIME-A2A-SPEC §9 / 03-IMPLEMENTATION-PHASES §12）：
 * - 工具 schema 由宿主白名单写死（TypeBox），绝不来自模型或 prompt 文本；这是模型在
 *   房间里能触发的全部副作用，绝不暴露任意 filesystem/shell/database（不复用 Pi 会话的
 *   Read/Bash/Edit/Write 等）。
 * - workspace_* 工具仅在本房间绑定了工作区、权限档位满足时有效；路由/守卫由 hostToolHandler
 *   系统执行，模型不可绕过。
 * - execute 把调用转发给宿主 hostToolHandler 真实校验/落盘/状态机迁移，绝不就地伪造结果；
 *   返回值的 content 由 Agent 自动作为 tool_result 回注下一轮 context（result 回注）。
 * - ask 成功且 result.awaitPeer=true 时调用 abortAgent 停掉 Agent loop，让 service 把
 *   run 迁移到 awaiting_peer，避免模型在等待期间再做副作用。room_task_update /
 *   room_publish_artifact 不设 awaitPeer（更新任务/发布产物不暂停当前 run）。
 */
export function buildRoomBridgeTools(args: {
  hostToolHandler: CollaborationHostToolHandler;
  abortAgent: () => void;
  /** 宿主组装的权限/工作区上下文；不接受模型传入。 */
  permissionProfile?: CollaborationPermissionProfile;
  workspaceId?: string;
}): AgentTool<any, { output: string }>[] {
  const { hostToolHandler, abortAgent, permissionProfile, workspaceId } = args;
  const make = (
    name: CollaborationHostToolCall["name"],
    description: string,
    // TypeBox schema 具体泛型在各工具间不同；AgentTool 在此处按运行时 schema 消费。
    parameters: any,
  ): AgentTool<any, { output: string }> => ({
    name,
    label: name,
    description,
    parameters: parameters as any,
    execute: async (_id, raw): Promise<AgentToolResult<{ output: string }>> => {
      const result = await hostToolHandler({
        name,
        arguments: Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value ?? ""),
          ]),
        ),
      });
      // ask 的宿主状态已以 CAS 迁移；停掉 Agent loop 以免模型在等待期间再做副作用。
      if (result.awaitPeer) abortAgent();
      return {
        content: [{ type: "text", text: result.output }],
        details: { output: result.output },
      };
    },
  });
  const roomTools = [
    make("room_send", ROOM_TOOL_DESCRIPTORS[0].description, roomSendSchema),
    make("room_ask", ROOM_TOOL_DESCRIPTORS[1].description, roomAskSchema),
    make("room_reply", ROOM_TOOL_DESCRIPTORS[2].description, roomReplySchema),
    make(
      "room_task_assign",
      ROOM_TOOL_DESCRIPTORS[3].description,
      roomTaskAssignSchema,
    ),
    make(
      "room_task_update",
      ROOM_TOOL_DESCRIPTORS[4].description,
      roomTaskUpdateSchema,
    ),
    make(
      "room_publish_artifact",
      ROOM_TOOL_DESCRIPTORS[5].description,
      roomPublishArtifactSchema,
    ),
    make(
      "room_request_user",
      ROOM_TOOL_DESCRIPTORS[6].description,
      roomRequestUserSchema,
    ),
  ];
  if (!workspaceId) return roomTools;
  // workspace 工具桥（按宿主绑定工作区/权限过滤）
  roomTools.push(
    make(
      "workspace_read_file",
      ROOM_TOOL_DESCRIPTORS[7].description,
      workspaceReadFileSchema,
    ),
    make(
      "workspace_search",
      ROOM_TOOL_DESCRIPTORS[8].description,
      workspaceSearchSchema,
    ),
  );
  if (permissionProfile === "workspace-write") {
    roomTools.push(
      make(
        "workspace_write_file",
        ROOM_TOOL_DESCRIPTORS[9].description,
        workspaceWriteFileSchema,
      ),
      make(
        "workspace_run_command",
        ROOM_TOOL_DESCRIPTORS[10].description,
        workspaceRunCommandSchema,
      ),
      make(
        "workspace_apply_patch",
        ROOM_TOOL_DESCRIPTORS[11].description,
        workspaceApplyPatchSchema,
      ),
      make(
        "workspace_delete_file",
        ROOM_TOOL_DESCRIPTORS[12].description,
        workspaceDeleteFileSchema,
      ),
      make(
        "workspace_move_file",
        ROOM_TOOL_DESCRIPTORS[13].description,
        workspaceMoveFileSchema,
      ),
    );
  }
  return roomTools;
}

function roomToolDescriptorsFor(input: MemberTurnInput) {
  if (input.capabilities?.supportsToolBridge === false) return [];
  const allowWorkspace = Boolean(input.workspaceId);
  const allowWrite =
    allowWorkspace && input.permissionProfile === "workspace-write";
  return ROOM_TOOL_DESCRIPTORS.filter((descriptor) => {
    if (!descriptor.name.startsWith("workspace_")) return true;
    if (!allowWorkspace) return false;
    return (
      descriptor.name === "workspace_read_file" ||
      descriptor.name === "workspace_search" ||
      allowWrite
    );
  });
}

/**
 * 外部渠道原生工具桥：把协作室 14 把受控工具
 *（room_send/room_ask/room_reply/room_task_assign/room_task_update/room_publish_artifact/
 * room_request_user/workspace_read_file/workspace_search/workspace_write_file/workspace_run_command/
 * workspace_apply_patch/workspace_delete_file/workspace_move_file）
 * 作为真实 AgentTool（TypeBox schema）接入 Pi Agent + createHttpDirectStreamFn。模型经供应商
 * 原生 function/tool calling 协议（Anthropic /v1/messages 的 tool_use）发起调用，Agent 调
 * execute → hostToolHandler 真实执行，结果由 Agent 自动回注下一轮 context。工具 schema 仅
 * 通过原生 API 暴露，绝不注入 prompt 文本伪造。仅 isAgentCompatibleProvider 的外部渠道进入
 * 此路径；其余 fail closed。
 *
 * 取消/超时/awaitPeer 与 runKsccRoomToolTurn 同款：signal/timer 调 agent.abort，
 * ask 成功后 abortAgent 停 loop，service 据此把 run 保留为 awaiting_peer。
 */
async function runExternalRoomToolTurn(args: {
  input: MemberTurnInput;
  cfg: ResolvedChannelBackend;
}): Promise<MemberTurnResult> {
  const { input, cfg } = args;
  let agent: Agent | undefined;
  const tools = buildRoomBridgeTools({
    hostToolHandler: input.hostToolHandler!,
    abortAgent: () => agent?.abort(),
    permissionProfile: input.permissionProfile,
    workspaceId: input.workspaceId,
  });
  // createHttpDirectStreamFn 内部按 provider 预建 Model（含正确 api/baseUrl），Agent 的
  // initialState.model 仅作占位（streamFn 忽略传入 model）。进入此路径的外部渠道均为
  // Anthropic 协议 → anthropic-messages。
  const model = {
    id: cfg.modelId,
    name: cfg.modelId,
    api: "anthropic-messages" as const,
    provider: "anthropic",
    baseUrl: cfg.baseUrl ?? "",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    streamFn: createHttpDirectStreamFn({
      provider: cfg.provider,
      apiKey: cfg.apiKey ?? "",
      baseUrl: cfg.baseUrl,
      modelId: cfg.modelId,
    }),
    toolExecution: "sequential",
  } as never);

  let fallbackTurnText = "";
  let visibleTurnText = "";
  let latestAssistantText = "";
  let latestUsage: MoASeatUsage | undefined;
  let timedOut = false;
  const emitSnapshot = (snapshot: string): void => {
    const nextVisible = sanitizeAssistantTextForDisplay(snapshot);
    if (nextVisible.startsWith(visibleTurnText)) {
      const delta = nextVisible.slice(visibleTurnText.length);
      if (delta) input.onTextDelta?.(delta);
    }
    visibleTurnText = nextVisible;
    if (nextVisible) latestAssistantText = nextVisible;
  };
  const resetTurn = (): void => {
    fallbackTurnText = "";
    visibleTurnText = "";
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      agent?.abort();
    }, MEMBER_TURN_TIMEOUT_MS);
  };
  const resetTimer = (): void => armTimer();
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "turn_start") {
      resetTurn();
      resetTimer();
      return;
    }
    if (event.type === "message_update") {
      resetTimer();
      const update = (
        event as {
          assistantMessageEvent?: {
            type?: string;
            delta?: string;
            partial?: unknown;
          };
        }
      ).assistantMessageEvent;
      const partialText = extractAssistantSnapshotText(update?.partial);
      if (partialText) {
        emitSnapshot(partialText);
        return;
      }
      if (update?.type === "text_delta" && update.delta) {
        fallbackTurnText += update.delta;
        emitSnapshot(fallbackTurnText);
      }
      return;
    }
    if (event.type === "message_end" || event.type === "turn_end") {
      resetTimer();
      const eventMessage = (
        event as {
          message?: {
            usage?: {
              input?: number;
              output?: number;
              totalTokens?: number;
              cost?: { total?: number };
            };
          };
        }
      ).message;
      const rawUsage = eventMessage?.usage;
      const messageText = extractAssistantSnapshotText(eventMessage);
      if (rawUsage) {
        latestUsage = {
          ...(rawUsage.input !== undefined
            ? { inputTokens: rawUsage.input }
            : {}),
          ...(rawUsage.output !== undefined
            ? { outputTokens: rawUsage.output }
            : {}),
          ...(rawUsage.totalTokens !== undefined
            ? { totalTokens: rawUsage.totalTokens }
            : {}),
          ...(rawUsage.cost?.total !== undefined
            ? { costUsd: rawUsage.cost.total }
            : {}),
        };
      }
      if (messageText) {
        latestAssistantText = messageText;
        visibleTurnText = messageText;
      }
      return;
    }
    if (event.type === "agent_end") {
      resetTimer();
      const finalText = extractLastAssistantText(
        (event as { messages?: unknown }).messages,
      );
      if (finalText) latestAssistantText = finalText;
      return;
    }
    resetTimer();
  });
  armTimer();
  const abort = () => agent?.abort();
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt(input.prompt);
    await agent.waitForIdle();
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    unsubscribe();
    agent.abort();
  }
  if (timedOut) {
    throw new Error(
      `协作室成员回合连续 ${MEMBER_TURN_TIMEOUT_MS / 1000} 秒无响应，已停止本次执行`,
    );
  }
  return {
    text:
      latestAssistantText || sanitizeAssistantTextForDisplay(fallbackTurnText),
    ...(latestUsage ? { usage: mapMoASeatUsage(latestUsage) } : {}),
  };
}

/**
 * 把 kscc bare 接入 Pi Agent 的真实工具循环。模型输出的 antml 调用由
 * createKsccBareStreamFn 解析为 AgentTool；只构造宿主按 workspace/permission 过滤后的
 * room + workspace 工具，结果由 Agent 自动写回下一轮 context。ask 成功后终止物理 loop，
 * service 会把 run 保留为 awaiting_peer。
 */
async function runKsccRoomToolTurn(args: {
  input: MemberTurnInput;
  modelId: string;
  ksccPath?: string;
}): Promise<MemberTurnResult> {
  const { input } = args;
  let agent: Agent | undefined;
  const tools = buildRoomBridgeTools({
    hostToolHandler: input.hostToolHandler!,
    abortAgent: () => agent?.abort(),
    permissionProfile: input.permissionProfile,
    workspaceId: input.workspaceId,
  });
  const model = {
    id: args.modelId,
    name: args.modelId,
    api: "openai-completions" as const,
    provider: "kscc",
    baseUrl: "",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    streamFn: createKsccBareStreamFn({
      ksccPath: args.ksccPath,
      defaultModelId: args.modelId,
      tools: roomToolDescriptorsFor(input) as any,
    }),
    toolExecution: "sequential",
  } as never);

  let fallbackTurnText = "";
  let visibleTurnText = "";
  let latestAssistantText = "";
  let latestUsage: MoASeatUsage | undefined;
  let timedOut = false;
  const emitSnapshot = (snapshot: string): void => {
    const nextVisible = sanitizeAssistantTextForDisplay(snapshot);
    if (nextVisible.startsWith(visibleTurnText)) {
      const delta = nextVisible.slice(visibleTurnText.length);
      if (delta) input.onTextDelta?.(delta);
    }
    visibleTurnText = nextVisible;
    if (nextVisible) latestAssistantText = nextVisible;
  };
  const resetTurn = (): void => {
    fallbackTurnText = "";
    visibleTurnText = "";
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      agent?.abort();
    }, MEMBER_TURN_TIMEOUT_MS);
  };
  const resetTimer = (): void => armTimer();
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "turn_start") {
      resetTurn();
      resetTimer();
      return;
    }
    if (event.type === "message_update") {
      resetTimer();
      const update = (
        event as {
          assistantMessageEvent?: {
            type?: string;
            delta?: string;
            partial?: unknown;
          };
        }
      ).assistantMessageEvent;
      const partialText = extractAssistantSnapshotText(update?.partial);
      if (partialText) {
        emitSnapshot(partialText);
        return;
      }
      if (update?.type === "text_delta" && update.delta) {
        fallbackTurnText += update.delta;
        emitSnapshot(fallbackTurnText);
      }
      return;
    }
    if (event.type === "message_end" || event.type === "turn_end") {
      resetTimer();
      const eventMessage = (
        event as {
          message?: {
            usage?: {
              input?: number;
              output?: number;
              totalTokens?: number;
              cost?: { total?: number };
            };
          };
        }
      ).message;
      const rawUsage = eventMessage?.usage;
      const messageText = extractAssistantSnapshotText(eventMessage);
      if (rawUsage) {
        latestUsage = {
          ...(rawUsage.input !== undefined
            ? { inputTokens: rawUsage.input }
            : {}),
          ...(rawUsage.output !== undefined
            ? { outputTokens: rawUsage.output }
            : {}),
          ...(rawUsage.totalTokens !== undefined
            ? { totalTokens: rawUsage.totalTokens }
            : {}),
          ...(rawUsage.cost?.total !== undefined
            ? { costUsd: rawUsage.cost.total }
            : {}),
        };
      }
      if (messageText) {
        latestAssistantText = messageText;
        visibleTurnText = messageText;
      }
      return;
    }
    if (event.type === "agent_end") {
      resetTimer();
      const finalText = extractLastAssistantText(
        (event as { messages?: unknown }).messages,
      );
      if (finalText) latestAssistantText = finalText;
      return;
    }
    resetTimer();
  });
  const abort = () => agent?.abort();
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt(input.prompt);
    await agent.waitForIdle();
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    unsubscribe();
    agent.abort();
  }
  if (timedOut) {
    throw new Error(
      `协作室成员回合连续 ${MEMBER_TURN_TIMEOUT_MS / 1000} 秒无响应，已停止本次执行`,
    );
  }
  return {
    text:
      latestAssistantText || sanitizeAssistantTextForDisplay(fallbackTurnText),
    ...(latestUsage ? { usage: mapMoASeatUsage(latestUsage) } : {}),
  };
}

function mapMoASeatUsage(
  usage: MoASeatUsage,
): NonNullable<MemberTurnResult["usage"]> {
  return {
    ...(usage.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens }
      : {}),
    ...(usage.totalTokens !== undefined
      ? { totalTokens: usage.totalTokens }
      : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  };
}
/** 默认工厂（service 在未注入 adapter 时用）。可选注入 lifecycle 使 interruptSession 可取消 inflight turn。 */
export function createChannelBackendAdapter(
  lifecycle?: MemberSessionLifecycleAdapter,
): MemberBackendAdapter {
  return new ChannelBackendAdapter(lifecycle);
}
