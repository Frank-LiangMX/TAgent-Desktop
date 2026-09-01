/**
 * 会话服务：管理 SessionRuntime 集合 + 注册 IPC handler
 *
 * 2.0 长驻改造核心。见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md。
 * 职责：
 * - 创建/销毁 SessionRuntime（一个会话一个）
 * - 注册 IPC handler（SEND_MESSAGE/STOP_AGENT/STEER_AGENT/DELETE_SESSION）
 * - 流式消息推给渲染进程（STREAM_EVENT / turn_end / session_error）
 * - 按 channelId 选核（kscc-internal→kscc 核，其余→Pi 核）+ 会话绑核（互斥）
 *
 * 会话绑定：首条消息锁定运行内核（KSCC / 外部）；同内核内渠道和模型可继续切换。
 *
 * stop / steer 双核差异（收口）：
 * - **STOP**：interrupt + 显式 turn_end + meta idle（渲染层 userStopRun 硬停 running）
 * - **STEER**：kscc 长驻 live enqueue；Pi（或无 live loop）→ pending_next_turn，
 *   本轮 onTurnEnd 后 auto handleSend，避免静默无操作
 */
import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
  AgentProviderAdapter,
  SDKMessage,
  SDKUserMessageInput,
  TAgentDesktopStreamPayload,
  TAgentMessage,
  Channel,
  AgentSessionMeta,
  AskUserResponse,
  ExitPlanModeResponse,
  KbProposeSaveResponse,
} from "@tagent/shared";
import {
  AGENT_IPC_CHANNELS,
  MEMORY_IPC_CHANNELS,
  msysPathToWindowsDrivePath,
} from "@tagent/shared";
import { SessionRuntime } from "../agent/runtime/session-runtime";
import {
  appendAttachmentPathsToPrompt,
  attachImageBlocksToText,
} from "../agent/build-user-content-with-attachments";
import { askUserService } from "../agent/agent-ask-user-service";
import { exitPlanService } from "../agent/agent-exit-plan-service";
import { kbProposeSaveService } from "../kb/kb-propose-save-service";
import {
  getAdapter,
  PiAgentAdapter,
  type ChannelKind,
  type CodexQueryOptions,
  type CodexAppServerIncomingRequest,
} from "../adapters";
import {
  buildCodexAskUserInput,
  buildCodexRequestUserInputResponse,
  parseCodexRequestUserInputParams,
} from "../adapters/codex/codex-request-user-input";
import {
  buildCodexPermissionsRequestApprovalResponse,
  parseCodexPermissionsRequestApprovalParams,
  summarizeCodexPermissionRequest,
} from "../adapters/codex/codex-permission-request";
import { buildCodexMcpThreadConfig } from "../adapters/codex/codex-mcp-config";
import {
  CodexDynamicToolRegistry,
  dispatchCodexDynamicToolCall,
  resolveCodexDynamicToolPermission,
} from "../adapters/codex/codex-dynamic-tools";
import { resolveCodexRuntime } from "../adapters/codex/codex-runtime-resolver";
import { resolveKsccPath } from "../adapters/claude/kscc-path";
import {
  buildOutputStylePrompt,
  buildRichContentSystemPrompt,
  buildChatModeBlockUserError,
  classifyUserFacingError,
  sdkMessageToIR,
  DeltaTracker,
  stripPartialAssistantBody,
  shouldDeltaTrackAssistant,
} from "@tagent/shared";
import type {
  KsccQueryOptions,
  PostToolBatchHookInputLike,
} from "../adapters/claude/claude-agent-adapter";
import {
  getSessionMeta,
  updateSessionMeta,
  appendSdkMessages,
  appendPanelMessages,
  createSession,
  listSessions,
  readPanelMessages,
  readMoADiscussionPanels,
  deleteSession as deleteSessionMeta,
  deleteSessionsByWorkspace,
  recallLastUnsentUserTurn,
} from "../agent/session-store";
import {
  createStreamPersistGateState,
  feedStreamPersistGate,
  flushStreamPersistGate,
  type StreamPersistGateState,
} from "../agent/stream-persist-gate";
import {
  getChannel,
  getDecryptedApiKey,
  getKsccChannelId,
} from "../channel/channel-store";
import {
  KSCC_DEFAULT_MODEL_ID,
  isClaudeAvailableForChannel,
} from "../channel/default-models";
import { buildBotSessionPromptAppend } from "../bot/bot-session-prompt";
import { getRegisteredCollaborationRoomService } from "../collaboration/collaboration-runtime";
import { resolveModelContextWindow } from "../channel/model-window";
import {
  buildMemoryPromptSections,
  memoryLayerService,
  memoryEvidenceSink,
  buildMemoryRecallContext,
  nudgeService,
  normalizeToTextMessages,
  type MemoryMode,
} from "../memory";
import { ksccSoftReset } from "../agent/kscc-soft-reset";
import { resolveWorkspaceForSession } from "../workspace/workspace-manager";
import {
  killSessionProcess,
  listSessionProcesses,
  subscribeSessionProcesses,
} from "../agent/session-process-registry";
import { findFileByNameCached } from "./file-search";
import { getEnabledMcpServers } from "../mcp/mcp-store";
import {
  listMoaPresets,
  writeMoaPresets,
  validateMoAPresetList,
} from "../agent/moa-preset-service";
import {
  listCliWorkersConfig,
  writeCliWorkersConfig,
  discoverAndReconcileCliWorkers,
} from "../agent/cli-workers-service";
import { probeCliWorkers } from "../agent/cli-workers/probe-cli-workers";
import { runMoaTurn } from "../agent/run-moa-turn";
import {
  runMoADiscussion,
  nextMoADiscussionId,
} from "../agent/run-moa-discussion";
import { resolveMoADispatch, decideMoaMetaPatch } from "../agent/moa-dispatch";
import {
  isMoaModelId,
  moaModelId,
  resolveConsultPresetsForChannel,
  buildResumeHistoryFromPanel,
  composeMoaPrompt,
  extractMoAConclusionFromMessages,
  panelMessageToHistoryIR,
  validateCliWorkersConfig,
  type MoAPreset,
  type CliWorkersConfig,
} from "@tagent/shared";
import {
  createKsccSeatRunner,
  createPiHttpSeatRunner,
  type MoASeatRunner,
} from "@tagent/pi-core";
import {
  PermissionService,
  dismissModeSuggestion,
  clearModeSuggestionDismissal,
  setOnChatModeBlock,
  setPermissionModeSwitcher,
} from "../permission/permission-service";
import {
  buildBuiltinSubagentDefinitions,
  buildSubagentDelegationPrompt,
} from "../agent/subagent-definitions";
import { buildExecutionModePrompt } from "../agent/execution-mode-prompt";
import {
  buildAutoKanbanPrompt,
  buildAutoPlanPrompt,
} from "../agent/auto-plan-router";
import { extractPlanStepSignals } from "../agent/plan-step-signal";
import { buildUserSystemPromptAppend } from "../system-prompt-manager";
import {
  buildPiKanbanTools,
  injectKanbanMcpServer,
} from "../kanban/kanban-agent-tools";
import {
  buildKbPromptAppend,
  buildPiKbTools,
  injectKbMcpServer,
  resolveAvailableKnowledgeBases,
} from "../kb/kb-agent-tools";
import { createKnowledgeBaseToolGate } from "../kb/kb-tool-policy";
import {
  addKnowledgeBaseSource,
  createKnowledgeBase,
  deleteKnowledgeBase,
  listKnowledgeBases,
  removeKnowledgeBaseSource,
  resolveKnowledgeBaseRootsForSession,
  updateKnowledgeBase,
} from "../kb/knowledge-base-store";
import {
  createKnowledgeBaseDocument,
  deleteKnowledgeBaseDocument,
  deleteKnowledgeBaseDocumentsForKnowledgeBase,
  listKnowledgeBaseDocuments,
  updateKnowledgeBaseDocument,
  importKnowledgeBaseDocument,
  importKnowledgeBaseDocuments,
  importKnowledgeBaseDocumentFromUrl,
} from "../kb/knowledge-base-document-store";
import { parseCloudDocumentReference } from "../kb/cloud-document-adapter";
import {
  buildKnowledgeBaseSharePackage,
  importKnowledgeBaseSharePackage,
} from "../kb/kb-share-package";
import {
  areKnowledgeBaseWritesEnabled,
  assertKnowledgeBaseWritesEnabled,
} from "../kb/kb-write-policy";
import {
  BROWSER_SYSTEM_PROMPT,
  buildPiBrowserTools,
  injectBrowserMcpServer,
} from "../browser/browser-agent-tools";
import { getBrowserController } from "./browser-service";
import {
  assessWebSearchFallback,
  buildBrowserFallbackContext,
} from "../browser/web-search-fallback";
import { listBoards, listTasksByBoard } from "../kanban/kanban-store";
import type {
  ExecutionMode,
  TAgentPermissionMode,
  NoProgressEvent,
} from "@tagent/shared";
import {
  TAGENT_DEFAULT_PERMISSION_MODE,
  migratePermissionMode,
  DEFAULT_SUBAGENT_EAGERNESS,
  migrateSubagentEagerness,
  resolveSdkPermissionModeForTAgent,
  migrateExecutionMode,
  LEGACY_EXECUTION_MODE,
  DEFAULT_EXECUTION_MODE,
  isExecutionModeChangeSource,
  type ExecutionModeChangeSource,
  parseMentions,
  parseFusionBotMentions,
  getFusionConversationMode,
  resolveSessionFusionRoute,
  migrateReasoningEffort,
  reasoningEffortToPiThinkingLevel,
  resolveNoProgressGuardMode,
} from "@tagent/shared";
import { loadRoles, resolveRole } from "../role/agent-role-service";
import { composeRoleSystemPrompt } from "../role/role-projection";
import {
  readNoProgressGuardModePref,
  writeNoProgressGuardModePref,
} from "../agent/no-progress-guard-prefs";
import {
  readAgentDiscussPrefs,
  writeAgentDiscussPrefs,
} from "../agent/agent-discuss-prefs";
import {
  readAgentCrewPrefs,
  writeAgentCrewPrefs,
} from "../agent/agent-crew-prefs";
import type {
  NoProgressGuardMode,
  AgentDiscussPrefs,
  AgentCrewPrefs,
  KnowledgeBaseRecord,
} from "@tagent/shared";
import {
  extractSdkUserText,
  isSteerPromptEcho,
  wrapSteerPromptForModel,
} from "../agent/steer-prompt";

interface SendMessageInput {
  sessionId: string;
  prompt: string;
  /** 仅供旁路 Bot 使用：本轮前情提要注入 system prompt，不落盘为 user 消息。 */
  contextPrompt?: string;
  /** 运行中引导的后续自动发送：在消息列表内并入前一执行回合。 */
  isSteer?: boolean;
  /** 引导已先落盘广播过，flush 时不要再写一条用户气泡。 */
  skipUserPersist?: boolean;
  /** 渠道 ID（决定选哪个 adapter + 绑核）。不传默认 kscc-internal */
  channelId?: string;
  /** 模型 ID */
  model?: string;
  /**
   * Internal Core 主会话后端。草稿会话首条时渲染层传入，
   * 已物化会话以后以 meta.internalBackend 为准。
   */
  internalBackend?: AgentSessionMeta["internalBackend"];
  /** 工作区 ID（= sanitizePath(projectPath)，用于 JSONL 按项目存储） */
  workspaceId?: string;
  /** 附件（已持久化到磁盘的 FileAttachment） */
  attachments?: Array<{
    id: string;
    filename: string;
    mediaType: string;
    localPath: string;
    size: number;
  }>;
  /**
   * Chat @ 提及的角色 id（按发言顺序）。
   * 可不传：主进程会从 prompt 文本再 parse 一次。
   */
  mentionRoleIds?: string[];
  /**
   * 渲染层本地的 executionMode（草稿会话首条时传入，主进程创建 meta 时带上）。
   * 非草稿会话已有 meta，此字段忽略。
   */
  executionMode?: ExecutionMode;
  /**
   * MoA 会诊本条（one-shot）：本轮走 runMoATurn，但**不**把 `meta.modelId` 改成
   * `moa:<presetId>`，会话 tab / ModelSelector 仍显示真实模型。
   * 见 docs/dev/moa-roundtable/02-SESSION-UX-SPEC.md §3。
   */
  moaOneShotPresetId?: string;
  /**
   * 圆桌讨论本条（one-shot）：本轮走 runMoADiscussion（多轮讨论+总结人收口），
   * 但**不**把 `meta.modelId` 改成 `moa:<presetId>`，会话 tab / ModelSelector 仍显示真实模型
   * （与会诊 one-shot 一致）。见 docs/dev/moa-roundtable/02-SESSION-UX-SPEC.md §3。
   */
  moaDiscussionPresetId?: string;
  /** 内部融合执行：顾问报告只进入模型 prompt，不进入用户消息落盘。 */
  fusionAdvisorContext?: string;
  /** 融合执行或独立旁路执行：跳过已升级协作室的父会话路由。 */
  skipFusionRouting?: boolean;
}

function resolveInternalAdapterKind(
  meta: AgentSessionMeta | undefined,
  requestedBackend?: AgentSessionMeta["internalBackend"],
): Extract<ChannelKind, "kscc" | "codex"> {
  if (meta?.internalBackend === "codex-app-server") return "codex";
  if (meta?.internalBackend === "kscc") return "kscc";
  if (meta?.codexThreadId) return "codex";
  if (meta?.sdkSessionId) return "kscc";
  if (requestedBackend === "codex-app-server") return "codex";
  if (requestedBackend === "kscc") return "kscc";
  return process.env.TAGENT_INTERNAL_BACKEND?.trim().toLowerCase() === "codex"
    ? "codex"
    : "kscc";
}

function persistedInternalBackend(
  kind: ChannelKind,
): AgentSessionMeta["internalBackend"] {
  return kind === "codex"
    ? "codex-app-server"
    : kind === "kscc"
      ? "kscc"
      : undefined;
}

/** 模型侧注入的 [用户附件] 附录，不应再当第二条用户气泡展示。 */
function extractAssistantTextFromPersistedMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as {
    type?: string;
    message?: { role?: string; content?: unknown };
    content?: unknown;
  };
  const message =
    record.message?.role === "assistant"
      ? record.message
      : record.type === "assistant"
        ? record
        : undefined;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (block): block is { type?: string; text?: string } =>
        Boolean(block) && typeof block === "object",
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

function readLastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantTextFromPersistedMessage(messages[index]);
    if (text.trim()) return text.trim();
  }
  return "";
}
function userContentHasAttachmentAppendix(content: unknown): boolean {
  if (typeof content === "string") return content.includes("[用户附件]");
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      b &&
      typeof b === "object" &&
      (b as { type?: string }).type === "text" &&
      typeof (b as { text?: string }).text === "string" &&
      (b as { text: string }).text.includes("[用户附件]"),
  );
}

export class SessionService {
  private runtimes = new Map<string, SessionRuntime>();
  /**
   * Pi 等非长驻 loop：steer 降级队列。
   * 本轮结束后（onTurnEnd）拼接为一条用户消息 auto handleSend。
   * STOP / 删会话时丢弃，避免停后仍自动开跑。
   */
  private pendingSteerBySession = new Map<string, string[]>();
  /** 刚落盘的引导原文，用来丢掉 kscc enqueue 回声（无 isSteer 的第二条用户气泡）。 */
  private lastSteerBySession = new Map<string, { text: string; at: number }>();
  /** 已从同一 assistant 消息发出的阶段信号，避免流式快照重复推送。 */
  private planStepSignalsSeenBySession = new Map<string, Set<string>>();
  /** 等待隐藏 Bot 顾问下一轮完成；只用于内部融合调度，不向 renderer 暴露。 */
  private nextTurnEndWaiters = new Map<string, Set<() => void>>();

  /**
   * kscc 流式落盘闸口状态（REGRESS-G）：按会话维护「同 uuid 去重 + 内容放行」的待提交 assistant。
   * 见 stream-persist-gate.ts。仅 kscc 路径（handleSdkStreamMessage）写入；Pi 路径自管 _partial，不经此。
   */
  private streamPersistGateBySession = new Map<
    string,
    StreamPersistGateState
  >();

  /**
   * E（IPC delta）：per-session DeltaTracker。把 kscc 累计 partial assistant 快照转成增量 suffix delta
   * （前缀不匹配 → replace resync），partial 的 sdk_message 剥掉 thinking/text 主体后发 renderer，
   * IPC 不再每帧重传全串（O(N²)→O(N)）。落盘仍走原始全量 msg（stream-persist-gate），不受影响。
   * 仅 kscc 路径（handleSdkStreamMessage）使用；Pi 路径自管 _partial，不经此。
   */
  private deltaTrackerBySession = new Map<string, DeltaTracker>();

  /**
   * MoA 会诊在途状态：runMoaTurn 期间存 AbortController（STOP 时 abort 杀未完成 bare 进程）
   * + 在途标记（getStatus 据此回 running；MoA 不经 SessionRuntime，无 isTurnInFlight）。
   */
  private moaAbortBySession = new Map<string, AbortController>();
  private moaInFlight = new Set<string>();

  /**
   * 无进展暂停 AskUserQuestion 的 AbortController（brief 2026-08-19 §3）。
   * 适配层进入 paused_no_progress 时经 onNoProgressPauseAskUser 回调注入 askUserService；
   * 用户回答 → handleSend 续跑；dismiss → 保持暂停。新 turn（handleSend）abort 旧请求，
   * 防止用户手动发消息后旧 AskUser 回调再触发一次续跑。
   */
  private noProgressAskUserAbortBySession = new Map<string, AbortController>();

  /**
   * 活跃圆桌讨论注册表（§5.3 用户插话/喊停）：按会话存当前讨论的 discussionId + 待注入插话队列 +
   * AbortController。runMoADiscussionTurn 启动时注册（ctx.interjections.drain 排空 pending），
   * discussion-interject IPC 据此 push 插话、discussion-stop IPC 据此 abort；讨论结束（finally）删除。
   * 同会话同时仅一场讨论（moaInFlight 单标记），故按 sessionId 单条即可，discussionId 仅作匹配校验。
   */
  private moaDiscussionsBySession = new Map<
    string,
    {
      discussionId: string;
      pending: string[];
      abortController: AbortController;
    }
  >();

  private constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly permissionService: PermissionService | null,
  ) {}

  /** Agent 每轮结束后释放受管浏览器，人工接管状态由 BrowserController 保留。 */
  private cleanupAgentBrowser(sessionId: string): void {
    try {
      getBrowserController().cleanupAfterAgent(sessionId);
    } catch {
      // 浏览器服务可能尚未初始化，或应用正在退出；不影响会话收尾。
    }
  }

  private disposeBrowserSession(sessionId: string): void {
    try {
      getBrowserController().disposeSession(sessionId);
    } catch {
      // 浏览器服务可能尚未初始化，或应用正在退出；不影响会话收尾。
    }
  }

  /** 会话当前绑定的运行内核；无 meta/渠道时 null */
  private resolveAdapterKindForSession(sessionId: string): ChannelKind | null {
    const meta = getSessionMeta(sessionId);
    if (!meta?.channelId) return null;
    const channel = getChannel(meta.channelId);
    if (!channel) return null;
    return channel.provider === "kscc-internal" ? "kscc" : "external";
  }

  /** 入队 steer 文本（Pi pending_next_turn） */
  private enqueuePendingSteer(sessionId: string, text: string): void {
    const list = this.pendingSteerBySession.get(sessionId) ?? [];
    list.push(text);
    this.pendingSteerBySession.set(sessionId, list);
  }

  /** 丢弃 pending steer（STOP / 删会话） */
  private clearPendingSteer(sessionId: string): void {
    this.pendingSteerBySession.delete(sessionId);
  }

  /**
   * 引导立刻落盘 + 推 renderer（isSteer），夹进当前执行回合，不另起用户气泡。
   * kscc 再写 resume JSONL；Pi 只写面板。
   */
  private persistSteerUserMessage(sessionId: string, text: string): void {
    const meta = getSessionMeta(sessionId);
    const workspaceId = meta?.workspaceId;
    const now = Date.now();
    const userMsg: SDKMessage = {
      type: "user",
      uuid: randomUUID(),
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      createdAt: now,
      isSteer: true,
    } as unknown as SDKMessage;
    this.lastSteerBySession.set(sessionId, { text, at: now });
    try {
      appendPanelMessages(workspaceId, sessionId, [userMsg]);
      if (this.resolveAdapterKindForSession(sessionId) === "kscc") {
        appendSdkMessages(workspaceId, sessionId, [userMsg]);
      }
      const { message: userIR } = sdkMessageToIR(userMsg);
      if (userIR) {
        this.sendPayload(sessionId, { kind: "sdk_message", message: userIR });
      }
    } catch (err) {
      console.warn(`[会话 ${sessionId}] 引导落盘失败:`, err);
    }
  }

  /** 取/建会话的落盘闸口状态。 */
  private getStreamPersistGate(sessionId: string): StreamPersistGateState {
    let s = this.streamPersistGateBySession.get(sessionId);
    if (!s) {
      s = createStreamPersistGateState();
      this.streamPersistGateBySession.set(sessionId, s);
    }
    return s;
  }

  /** 取/建会话的 delta 追踪器（E）。 */
  private getDeltaTracker(sessionId: string): DeltaTracker {
    let t = this.deltaTrackerBySession.get(sessionId);
    if (!t) {
      t = new DeltaTracker();
      this.deltaTrackerBySession.set(sessionId, t);
    }
    return t;
  }

  private waitForNextTurnEnd(
    sessionId: string,
    timeoutMs = 180000,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const waiters =
        this.nextTurnEndWaiters.get(sessionId) ?? new Set<() => void>();
      const finish = (): void => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.nextTurnEndWaiters.delete(sessionId);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(finish);
        if (waiters.size === 0) this.nextTurnEndWaiters.delete(sessionId);
        resolve(false);
      }, timeoutMs);
      waiters.add(finish);
      this.nextTurnEndWaiters.set(sessionId, waiters);
    });
  }

  private resolveNextTurnEndWaiters(sessionId: string): void {
    const waiters = this.nextTurnEndWaiters.get(sessionId);
    if (!waiters) return;
    for (const finish of [...waiters]) finish();
  }
  /** Phase 1.2 双写：先面板（保可见）再 SDK（resume）。 */
  private persistStreamMessages(
    workspaceId: string | undefined,
    sessionId: string,
    msgs: unknown[],
  ): void {
    if (msgs.length === 0) return;
    try {
      appendPanelMessages(workspaceId, sessionId, msgs);
    } catch (err) {
      console.warn("[session-service] appendPanelMessages failed:", err);
    }
    try {
      appendSdkMessages(workspaceId, sessionId, msgs);
    } catch (err) {
      console.error("[session-service] appendSdkMessages failed:", err);
    }
  }

  /** 将闸口最终落盘的 assistant 摘要回传给 renderer，按 uuid 原地校准 live 项。 */
  private reconcilePersistedStreamMessages(sessionId: string, msgs: unknown[]): void {
    for (const raw of msgs) {
      if ((raw as { type?: string }).type !== "assistant") continue
      const converted = sdkMessageToIR(raw as SDKMessage).message
      if (converted?.type === "assistant") {
        this.sendPayload(sessionId, { kind: "sdk_message", message: { ...converted, __streamReconcile: true } as TAgentMessage })
      }
    }
  }

  /**
   * 轮结束/中断兜底：flush 待提交 assistant 落盘。
   * result 路径已自行 flush，此处幂等；STOP/Chat 拦截/turn_end 调用以清理 stale pending。
   */
  private flushStreamPersistGateFor(sessionId: string): void {
    const s = this.streamPersistGateBySession.get(sessionId);
    if (!s) return;
    const toPersist = flushStreamPersistGate(s);
    if (toPersist.length === 0) return;
    const workspaceId = getSessionMeta(sessionId)?.workspaceId;
    this.persistStreamMessages(workspaceId, sessionId, toPersist);
    this.reconcilePersistedStreamMessages(sessionId, toPersist);
  }

  /**
   * 本轮正常结束后：若有 pending steer，自动作为下一轮用户消息发送。
   * 仅 Pi 降级路径写入 pending；kscc live enqueue 不经此 Map。
   * Pi 必须在 onLoopIdle（loop 停稳）调用；不可在 onTurnEnd（仍在 for-await）调用。
   */
  private flushPendingSteer(sessionId: string): void {
    const pending = this.pendingSteerBySession.get(sessionId);
    if (!pending?.length) return;
    this.pendingSteerBySession.delete(sessionId);
    const meta = getSessionMeta(sessionId);
    if (!meta?.channelId) {
      console.warn(
        `[session-service] pending steer 丢弃（无 meta）: ${sessionId}`,
      );
      return;
    }
    const prompt = wrapSteerPromptForModel(pending.join("nn"));
    console.log(
      `[会话 ${sessionId}] pending steer → 自动下一轮（${pending.length} 条合并）`,
    );
    void this.handleSend({
      sessionId,
      prompt,
      channelId: meta.channelId,
      model: meta.modelId,
      workspaceId: meta.workspaceId,
      isSteer: true,
      skipUserPersist: true,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[session-service] pending steer flush 失败: ${msg}`);
      // 回填，避免静默丢；用户可再发或再点引导
      const cur = this.pendingSteerBySession.get(sessionId) ?? [];
      this.pendingSteerBySession.set(sessionId, [...pending, ...cur]);
      this.sendPayload(sessionId, {
        kind: "tagent_event",
        event: {
          type: "session_error",
          message: `引导消息自动发送失败：${msg}`,
          error: classifyUserFacingError(msg),
        },
      });
    });
  }

  /**
   * Chat 模式拦截写操作：终止当前 run + 通知渲染层清运行态。
   * 用户视角：「都在运行了还问我干啥」——被拦即停，等用户确认切 Work 后再继续。
   */
  private handleChatModeBlock(sessionId: string, toolName: string): void {
    // 先清 pending，再 interrupt（与 STOP_AGENT 同序，防 onTurnEnd 误 flush）
    this.clearPendingSteer(sessionId);
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      void rt.interrupt().catch(() => {});
    }
    // REGRESS-G：Chat 拦截中断也 flush 待提交 assistant（清 stale pending + 保已生成段落盘）
    this.flushStreamPersistGateFor(sessionId);
    // 清流式占位 + running 停止（turn_end 语义；interrupt 后 adapter 可能不再发事件，兜底）
    this.sendPayload(sessionId, {
      kind: "tagent_event",
      event: { type: "turn_end" },
    });
    // 用户可见引导：SessionErrorBanner（非 assistant 气泡里的工具失败原文）
    const userError = buildChatModeBlockUserError(toolName);
    this.sendPayload(sessionId, {
      kind: "tagent_event",
      event: {
        type: "session_error",
        message: userError.message,
        error: userError,
      },
    });
  }

  static create(
    getWindow: () => BrowserWindow | null,
    permissionService: PermissionService | null = null,
  ): SessionService {
    const svc = new SessionService(getWindow, permissionService);
    if (permissionService) {
      setOnChatModeBlock((sessionId, toolName) =>
        svc.handleChatModeBlock(sessionId, toolName),
      );
      // EnterPlanMode / ExitPlanMode 审批后由 permission-service 回调切模式：
      // persist meta + 通知 runtime + 推 PLAN_MODE_CHANGED 更新输入框 pill（与 pill 手动切换同路径）
      setPermissionModeSwitcher((sessionId, mode) =>
        svc.applyPermissionModeChange(sessionId, mode),
      );
    }
    // Phase 4：软重置钩子
    ksccSoftReset.setHooks({
      abortSession: (sessionId) => {
        const rt = svc.runtimes.get(sessionId);
        rt?.destroy();
        svc.runtimes.delete(sessionId);
        try {
          getAdapter("kscc").abort?.(sessionId);
        } catch {
          /* ignore */
        }
      },
      onStatus: (sessionId, status) => {
        const win = getWindow();
        win?.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: {
            kind: "tagent_event",
            event: {
              type:
                status === "switching" || status === "compacting"
                  ? "memory_organizing"
                  : "memory_status",
              status,
            },
          },
        });
      },
    });
    svc.registerIpc();
    return svc;
  }

  /** 注册 IPC handler */
  private registerIpc(): void {
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SEND_MESSAGE,
      async (_e, input: SendMessageInput) => {
        try {
          await this.handleSend(input);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.sendPayload(input.sessionId, {
            kind: "tagent_event",
            event: {
              type: "session_error",
              message: msg,
              error: classifyUserFacingError(msg),
            },
          });
          return { ok: false, error: msg };
        }
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_CODEX_RUNTIME_STATUS,
      async () => {
        const result = resolveCodexRuntime();
        return {
          available: result.available,
          source: result.source,
          version: result.version,
          reason: result.available
            ? undefined
            : result.diagnostics
                .map((item) => item.reason)
                .filter(Boolean)
                .slice(0, 3)
                .join("；"),
        };
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.STOP_AGENT,
      async (_e, sessionId: string) => {
        // 先丢 pending steer，再 interrupt：abort 可能同步触发 result→onTurnEnd，
        // 若先 interrupt 再 clear，会误 auto-send 用户刚想放弃的引导。
        this.clearPendingSteer(sessionId);
        // 清待处理 AskUser 请求（resolve deny「会话已结束」；abort signal 兜底已 deny，此处幂等）
        askUserService.clearSessionPending(sessionId);
        // 清无进展暂停 AskUser 的 abort controller（clearSessionPending 已 resolve deny，此处只清 Map）
        this.noProgressAskUserAbortBySession.delete(sessionId);
        // 清待处理 ExitPlanMode 审批请求（resolve deny「会话已结束」+ 推 RESOLVED 让渲染层出队，避免停后残留横幅）
        for (const rid of exitPlanService.clearSessionPending(sessionId)) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESOLVED,
            {
              requestId: rid,
            },
          );
        }
        // 清待处理 kb_propose_save 确认请求（resolve aborted 零写入 + 推 RESOLVED 让渲染层出队）
        for (const rid of kbProposeSaveService.clearSessionPending(sessionId)) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.KB_PROPOSE_SAVE_RESOLVED,
            {
              requestId: rid,
            },
          );
        }
        // MoA 会诊在途：abort 杀未完成 bare 进程（runMoaTurn 检测 signal 后推 cancelled 卡）。
        // MoA 不经 SessionRuntime，下方 rt 为 null，靠此 controller 中止。
        const moaCtrl = this.moaAbortBySession.get(sessionId);
        if (moaCtrl) moaCtrl.abort();
        const rt = this.runtimes.get(sessionId);
        if (rt) await rt.interrupt();
        // REGRESS-G：中断也 flush 待提交 assistant（保已生成的段落盘 + 清 stale pending 不漏进下一轮）
        this.flushStreamPersistGateFor(sessionId);
        // 软停兜底：interrupt 不调 onTurnEnd，且 Pi abort 不保证再推 result。
        // 显式推 turn_end + meta idle → 侧栏 idle / 流式占位收（与 handleChatModeBlock 一致）。
        // 渲染层另有 userStopRun 硬停 running+startedAt；后续 result→onTurnEnd 再发 turn_end 幂等可接受。
        // 注意：此处 sendPayload(turn_end) **不**走 onTurnEnd 回调，故不会 flushPendingSteer。
        try {
          updateSessionMeta(sessionId, { status: "idle" });
        } catch {
          /* meta 缺失时忽略 */
        }
        this.sendPayload(sessionId, {
          kind: "tagent_event",
          event: { type: "turn_end" },
        });
        this.cleanupAgentBrowser(sessionId);
        return { ok: true };
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.RECALL_UNSENT_TURN,
      async (_e, sessionId: string) => {
        try {
          const meta = getSessionMeta(sessionId);
          const workspaceId = meta?.workspaceId;
          const recalled = recallLastUnsentUserTurn(workspaceId, sessionId);
          if (!recalled.ok) return recalled;
          if (meta && (meta.turnCount ?? 0) > 0) {
            updateSessionMeta(sessionId, {
              turnCount: Math.max(0, (meta.turnCount ?? 1) - 1),
            });
          }
          return recalled;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[session-service] recall unsent turn failed:", msg);
          return { ok: false, reason: "empty" as const };
        }
      },
    );

    /**
     * 圆桌讨论用户插话（§5.3）：渲染层讨论室输入框发送 → push 到活跃讨论的 pending 队列，
     * 由 runMoADiscussion 每轮开始前 drain 注入本轮参与者 prompt（先落 user entry 再追加 [用户插话]）。
     * discussionId 不匹配 / 无活跃讨论 / 空文本 → { ok:false }（讨论已结束或过期请求）。
     */
    ipcMain.handle(
      AGENT_IPC_CHANNELS.DISCUSSION_INTERJECT,
      async (
        _e,
        {
          sessionId,
          discussionId,
          text,
        }: { sessionId: string; discussionId: string; text: string },
      ): Promise<{ ok: boolean; error?: string }> => {
        const rec = this.moaDiscussionsBySession.get(sessionId);
        if (!rec || rec.discussionId !== discussionId || !text) {
          return { ok: false, error: "没有进行中的圆桌研讨" };
        }
        rec.pending.push(text);
        return { ok: true };
      },
    );

    /**
     * 圆桌讨论用户喊停（§5.3）：渲染层讨论室「结束讨论」→ abort 活跃讨论的 controller，
     * 触发 runMoADiscussion 现有 cancelled 路径（推 cancelled 卡、保留已发言记录）。
     * cancelled 路径不推 turn_end（与会诊取消一致），故此处补 turn_end 清渲染层 running 状态
     * （对齐 STOP_AGENT）；meta idle 由 runMoADiscussionTurn 的 finally 兜底。无活跃讨论 → { ok:false }。
     */
    ipcMain.handle(
      AGENT_IPC_CHANNELS.DISCUSSION_STOP,
      async (
        _e,
        {
          sessionId,
          discussionId,
        }: { sessionId: string; discussionId: string },
      ): Promise<{ ok: boolean; error?: string }> => {
        const rec = this.moaDiscussionsBySession.get(sessionId);
        if (!rec || rec.discussionId !== discussionId) {
          return { ok: false, error: "没有进行中的圆桌研讨" };
        }
        rec.abortController.abort();
        this.sendPayload(sessionId, {
          kind: "tagent_event",
          event: { type: "turn_end" },
        });
        this.cleanupAgentBrowser(sessionId);
        return { ok: true };
      },
    );

    /**
     * 圆桌讨论重放（T8）：会话打开/切回时，渲染层在历史消息加载完成后调用。主进程读该会话
     * moa-discussion.jsonl，把每场已落盘讨论按原 `moa_discussion` 事件推回渲染层——渲染层
     * 按 discussionId upsert 成入口卡（终态静态卡：done 显示共识摘要+可进讨论室回看完整 entries；
     * cancelled/error 同样可进讨论室看已发言）。
     *
     * 复用既有 STREAM_EVENT + `moa_discussion` 通道：渲染层 upsert 分支已按 discussionId 去重，
     * 与运行中实时事件共用同一逻辑，避免双卡。读失败/无记录 → count:0（不报错，不阻断）。
     */
    ipcMain.handle(
      AGENT_IPC_CHANNELS.REPLAY_MOA_DISCUSSIONS,
      async (
        _e,
        sessionId: string,
      ): Promise<{ ok: boolean; count: number }> => {
        try {
          const meta = getSessionMeta(sessionId);
          const panels = readMoADiscussionPanels(meta?.workspaceId, sessionId);
          for (const panel of panels) {
            this.sendPayload(sessionId, {
              kind: "tagent_event",
              event: { type: "moa_discussion", panel },
            });
          }
          return { ok: true, count: panels.length };
        } catch (err) {
          console.warn("[session-service] replayMoADiscussions failed:", err);
          return { ok: false, count: 0 };
        }
      },
    );

    // 响应 AskUserQuestion：渲染层回灌 answers → 注入 updatedInput.answers → resolve allow
    // （SDK 拿到带 answers 的 input 执行，不再发 request_user_dialog 控制帧）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.ASK_USER_RESPOND,
      async (_e, response: AskUserResponse): Promise<void> => {
        const requestId = response?.requestId;
        if (!requestId) return;
        const sessionId = askUserService.respondToAskUser(
          requestId,
          response?.answers ?? {},
        );
        if (sessionId) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.ASK_USER_RESOLVED,
            { requestId },
          );
        }
      },
    );

    // 用户关闭 AskUser 选项卡：只回灌「用户未选择」的软 deny，不停止当前轮。
    // Agent 收到工具拒绝原因后自行决定继续、采用默认方案、重新说明或结束。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.ASK_USER_DISMISS,
      async (_e, requestId: string): Promise<void> => {
        if (!requestId || typeof requestId !== "string") return;
        const sessionId = askUserService.dismissToAskUser(requestId);
        if (sessionId) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.ASK_USER_RESOLVED,
            { requestId },
          );
        }
      },
    );

    // 响应 ExitPlanMode：渲染层回用户选择 → exitPlanService resolve allow/deny + targetMode。
    // 权限模式切换由 permission-service 在 canUseTool 返回前经 permissionModeSwitcher 完成
    // （在 resolve 后的微task 里 await switcher，避免下一工具跑在旧模式）；此处只 resolve
    // + 推 EXIT_PLAN_MODE_RESOLVED 让渲染层按 requestId 出队（Banner 乐观出队的兜底）。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND,
      async (_e, response: ExitPlanModeResponse): Promise<void> => {
        const requestId = response?.requestId;
        if (!requestId) return;
        const sessionId = exitPlanService.respondToExitPlanMode(response);
        if (sessionId) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESOLVED,
            { requestId },
          );
        }
      },
    );

    // 响应 kb_propose_save：渲染层回用户选择 → kbProposeSaveService resolve ok:true/false。
    // confirm 路径在 service 内调 createKnowledgeBaseDocument 写入；reject 零写入。
    // + 推 KB_PROPOSE_SAVE_RESOLVED 让渲染层按 requestId 出队（Banner 乐观出队的兜底）。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.KB_PROPOSE_SAVE_RESPOND,
      async (_e, response: KbProposeSaveResponse): Promise<void> => {
        assertKnowledgeBaseWritesEnabled();
        const requestId = response?.requestId;
        if (!requestId) return;
        const handled = kbProposeSaveService.respond(response);
        if (handled) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.KB_PROPOSE_SAVE_RESOLVED,
            { requestId },
          );
        }
      },
    );

    /**
     * 引导 Agent（不中断当前轮）。
     * - kscc + live loop → enqueue，mode:'live'
     * - Pi / 无 live loop → pending_next_turn，本轮 onTurnEnd 后 auto 发送
     * 绝不静默 {ok:true} 却无任何效果。
     */
    ipcMain.handle(
      AGENT_IPC_CHANNELS.STEER_AGENT,
      async (
        _e,
        sessionId: string,
        message: string,
      ): Promise<{
        ok: boolean;
        mode?: "live" | "pending_next_turn";
        error?: string;
      }> => {
        const text = typeof message === "string" ? message.trim() : "";
        if (!text) return { ok: false, error: "消息为空" };
        try {
          const kind = this.resolveAdapterKindForSession(sessionId);
          const rt = this.runtimes.get(sessionId);

          // 先落盘原文，会话里立刻出现「引导」气泡。
          this.persistSteerUserMessage(sessionId, text);
          const modelText = wrapSteerPromptForModel(text);

          // kscc 长驻：注入同一场运行，当前工具结束后的下一次思考就会带上引导。
          // 这才和「排队」（整场运行结束再新开一轮）不是一回事。
          if (kind === "kscc" && rt?.hasLiveProcess()) {
            const mode = await rt.steerMessage(modelText);
            if (mode === "live") {
              return { ok: true, mode: "live" };
            }
          }

          // Pi / 无 live loop：只能等本场运行停稳再发，语义接近排队。
          this.enqueuePendingSteer(sessionId, text);
          if (!rt || (!rt.isTurnInFlight() && !rt.isRunning())) {
            this.flushPendingSteer(sessionId);
          }
          return { ok: true, mode: "pending_next_turn" };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.warn(`[会话 ${sessionId}] 引导失败: ${error}`);
          return { ok: false, error };
        }
      },
    );

    // 附件管理
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SAVE_ATTACHMENT,
      async (
        _e,
        input: {
          sessionId: string;
          filename: string;
          mediaType: string;
          data: string;
        },
      ) => {
        const { saveAttachment } = await import("../attachment-service");
        return saveAttachment(input);
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.READ_ATTACHMENT,
      async (_e, localPath: string) => {
        const { readAttachmentAsBase64 } =
          await import("../attachment-service");
        return readAttachmentAsBase64(localPath);
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.RESOLVE_ATTACHMENT_PATH,
      async (_e, localPath: string) => {
        const { getAttachmentAbsolutePath } =
          await import("../attachment-service");
        return getAttachmentAbsolutePath(localPath);
      },
    );

    ipcMain.handle(AGENT_IPC_CHANNELS.OPEN_FILE_DIALOG, async () => {
      const { dialog } = await import("electron");
      const win = this.getWindow();
      const result = await dialog.showOpenDialog(win!, {
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "图片",
            extensions: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"],
          },
          {
            name: "文档",
            extensions: ["pdf", "doc", "docx", "txt", "md", "csv", "json"],
          },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return {
          files: [] as Array<{
            path: string;
            filename: string;
            mediaType: string;
            data: string;
            size: number;
          }>,
        };
      }
      const { readFileSync, statSync } = await import("node:fs");
      const { basename } = await import("node:path");
      const MIME_MAP: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".bmp": "image/bmp",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".json": "application/json",
        ".doc": "application/msword",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
      const MAX_INLINE = 10 * 1024 * 1024; // 10MB 以内读 base64
      const files: Array<{
        path: string;
        filename: string;
        mediaType: string;
        data: string;
        size: number;
      }> = [];
      for (const fp of result.filePaths) {
        const stat = statSync(fp);
        const ext = "." + fp.split(".").pop()?.toLowerCase();
        const mime = MIME_MAP[ext] ?? "application/octet-stream";
        if (stat.size <= MAX_INLINE) {
          const buf = readFileSync(fp);
          files.push({
            path: fp,
            filename: basename(fp),
            mediaType: mime,
            data: buf.toString("base64"),
            size: stat.size,
          });
        } else {
          // 大文件只返回路径，由主进程后续按需读取
          files.push({
            path: fp,
            filename: basename(fp),
            mediaType: mime,
            data: "",
            size: stat.size,
          });
        }
      }
      return { files };
    });

    // 用系统默认程序打开文件（消息内文件 chip 点击）。相对路径基于会话工作区解析。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.OPEN_PATH,
      async (
        _e,
        input: { sessionId: string; path: string },
      ): Promise<{ ok: boolean; error?: string }> => {
        const { shell } = await import("electron");
        const { isAbsolute, resolve, basename } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const target = input.path.trim();
        if (!target) return { ok: false, error: "路径为空" };
        const workspace = resolveWorkspaceForSession(input.sessionId);
        let abs = target;
        if (!isAbsolute(abs)) {
          const base = workspace?.projectDirectory;
          if (!base)
            return { ok: false, error: "会话未绑定工作区，无法解析相对路径" };
          abs = resolve(base, abs);
        } else if (process.platform === "win32") {
          // MSYS/Git Bash 挂载形态（/f/...）：win32 会解析到盘根 f 目录，先试盘符路径
          const drive = msysPathToWindowsDrivePath(abs);
          if (drive && existsSync(drive)) abs = drive;
        }
        if (!existsSync(abs)) {
          // 裸文件名（如 `Chat.tsx`）常规解析失败 → 项目内按文件名查找（与 resolveFile 同一兜底）
          if (workspace?.projectDirectory) {
            const found = findFileByNameCached(
              workspace.projectDirectory,
              basename(target),
            );
            if (found) abs = found;
          }
          if (!existsSync(abs))
            return { ok: false, error: `文件不存在：${abs}` };
        }
        const err = await shell.openPath(abs);
        return err ? { ok: false, error: err } : { ok: true };
      },
    );

    // 解析文件路径是否存在（文件 chip / Files Changed 存在性检查）。候选 base 优先，无则回退会话工作区。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.RESOLVE_FILE,
      async (
        _e,
        input: { sessionId: string; path: string; bases?: string[] },
      ): Promise<string | null> => {
        const { isAbsolute, resolve, basename, dirname } =
          await import("node:path");
        const { existsSync } = await import("node:fs");
        const { cleanFilePathInput } = await import("@tagent/shared");
        // 清洗引号 / file:// / :line 后缀，避免「解析到了但路径脏」→ 预览读失败
        const target = cleanFilePathInput(input.path ?? "");
        if (!target) return null;
        const candidates: string[] = [];
        const workspace = resolveWorkspaceForSession(input.sessionId);
        const bases = (input.bases ?? []).filter(Boolean);
        if (isAbsolute(target)) {
          candidates.push(target);
          // MSYS/Git Bash 挂载形态（/f/...）：win32 会解析到盘根 f 目录，按盘符路径再试
          if (process.platform === "win32") {
            const drive = msysPathToWindowsDrivePath(target);
            if (drive) candidates.push(drive);
          }
        } else {
          // 带项目名前缀的相对路径（如 `j3_statics/preview.js`）：首段匹配 base 名时
          // 用 base 的父目录拼接（与渲染层 displayPath、1.0 resolveTargetPath 同款）
          const firstSegment = target.split(/[/]/)[0];
          if (firstSegment) {
            for (const base of bases) {
              if (basename(base) === firstSegment) {
                candidates.push(resolve(dirname(base), target));
              }
            }
          }
          for (const base of bases) candidates.push(resolve(base, target));
          if (workspace?.projectDirectory) {
            candidates.push(resolve(workspace.projectDirectory, target));
          }
        }
        for (const abs of candidates) {
          if (existsSync(abs)) return abs;
        }
        // 外部绝对路径兜底：Agent 有时只给出项目根 + 文件名，
        // 例如 D:/JX3_Unreal_Artwork/XSJTagApiRouter.cpp，真实文件位于
        // 项目下更深的 Plugins/Source 目录。精确路径不存在时，优先在
        // 该路径自己的现存父目录中按文件名查找；不把整个磁盘作为搜索根，
        // 也不改变相对路径仍以工作区为基准的规则。
        if (isAbsolute(target)) {
          const absoluteTarget =
            process.platform === "win32"
              ? (msysPathToWindowsDrivePath(target) ?? target)
              : target;
          let externalRoot = dirname(absoluteTarget);
          let hops = 0;
          while (!existsSync(externalRoot) && hops < 3) {
            const parent = dirname(externalRoot);
            if (parent === externalRoot) break;
            externalRoot = parent;
            hops += 1;
          }
          if (existsSync(externalRoot)) {
            const found = findFileByNameCached(
              externalRoot,
              basename(absoluteTarget),
            );
            if (found) return found;
          }
        }
        // 兜底：裸文件名/短路径（如 `Chat.tsx`）常规解析失败 → 项目内按文件名递归查找。
        // 排除依赖/产物目录、限深度与扫描量，命中结果带模块级缓存（见 file-search）。
        // 绝对路径也走这里：MSYS 形态解析不到时按名找回（对齐 TAgent_General 1.0 行为）。
        // 草稿会话还没落 meta，反查不到 workspace，此时用渲染层注入的 base 当扫描根。
        const searchRoot = workspace?.projectDirectory ?? bases[0];
        if (searchRoot) {
          const found = findFileByNameCached(searchRoot, basename(target));
          if (found) return found;
        }
        return null;
      },
    );

    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_KNOWLEDGE_BASES, async () =>
      listKnowledgeBases(),
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.CREATE_KNOWLEDGE_BASE,
      async (
        _e,
        input: { name: string; description?: string; sourcePaths?: string[] },
      ) => createKnowledgeBase(input),
    );
    // 刀 3：更新知识库元数据（名称 / 描述 / 关联工作区弱关联）。
    // 关联仅用于「未挂库时荐库」（kb_list_available / buildKbPromptAppend 读 relatedWorkspaceIds），
    // 不自动挂载、不授权读正文，故无需触发会话 re-spawn。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_KNOWLEDGE_BASE,
      async (
        _e,
        input: {
          id: string;
          name?: string;
          description?: string;
          relatedWorkspaceIds?: string[];
        },
      ) => updateKnowledgeBase(input),
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.DELETE_KNOWLEDGE_BASE,
      async (_e, id: string) => {
        if (!deleteKnowledgeBase(id)) throw new Error("知识库不存在");
        deleteKnowledgeBaseDocumentsForKnowledgeBase(id);
        for (const session of listSessions({ includeHidden: true })) {
          if (session.knowledgeBaseIds?.includes(id)) {
            updateSessionMeta(session.id, {
              knowledgeBaseIds: session.knowledgeBaseIds.filter(
                (value) => value !== id,
              ),
            });
          }
        }
        return { ok: true };
      },
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.ADD_KNOWLEDGE_BASE_SOURCE,
      async (_e, input: { id: string; path: string }) =>
        addKnowledgeBaseSource(input.id, input.path),
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.REMOVE_KNOWLEDGE_BASE_SOURCE,
      async (_e, input: { id: string; sourceId: string }) =>
        removeKnowledgeBaseSource(input.id, input.sourceId),
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.LIST_KNOWLEDGE_BASE_DOCUMENTS,
      async (_e, input: { knowledgeBaseId: string; query?: string }) =>
        listKnowledgeBaseDocuments(input.knowledgeBaseId, input.query),
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.CREATE_KNOWLEDGE_BASE_DOCUMENT,
      async (
        _e,
        input: {
          knowledgeBaseId: string;
          title: string;
          content?: string;
          kind?: "note" | "contract" | "norm" | "snapshot";
          snapshotAt?: number;
          originNote?: string;
          sourceUrl?: string;
          sourceProvider?: "wps" | "feishu" | "google-drive" | "unknown";
          sourceExternalId?: string;
          sourceAccessMode?: "public" | "oauth" | "browser";
          sourceSyncedAt?: number;
        },
      ) => {
        assertKnowledgeBaseWritesEnabled();
        return createKnowledgeBaseDocument(input);
      },
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_KNOWLEDGE_BASE_DOCUMENT,
      async (_e, input: { id: string; title: string; content: string }) => {
        assertKnowledgeBaseWritesEnabled();
        return updateKnowledgeBaseDocument(input);
      },
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.DELETE_KNOWLEDGE_BASE_DOCUMENT,
      async (_e, id: string) => {
        if (!deleteKnowledgeBaseDocument(id)) throw new Error("文档不存在");
        return { ok: true };
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.IMPORT_KNOWLEDGE_BASE_DOCUMENT,
      async (_e, input: { knowledgeBaseId: string }) => {
        assertKnowledgeBaseWritesEnabled();
        const { dialog } = await import("electron");
        const win = this.getWindow();
        const result = win
          ? await dialog.showOpenDialog(win, {
              properties: ["openFile"],
              title: "导入知识文档",
              filters: [
                {
                  name: "知识文档",
                  extensions: ["docx", "doc", "pdf", "xlsx", "xls", "md", "markdown", "txt"],
                },
              ],
            })
          : await dialog.showOpenDialog({
              properties: ["openFile"],
              title: "导入知识文档",
              filters: [
                {
                  name: "知识文档",
                  extensions: ["docx", "doc", "pdf", "xlsx", "xls", "md", "markdown", "txt"],
                },
              ],
            });
        if (result.canceled || !result.filePaths[0]) return null;
        return importKnowledgeBaseDocuments({
          knowledgeBaseId: input.knowledgeBaseId,
          filePath: result.filePaths[0],
        });
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.IMPORT_KNOWLEDGE_BASE_DOCUMENT_DOWNLOAD,
      async (
        _e,
        input: { knowledgeBaseId: string; sessionId: string; title?: string },
      ): Promise<import("@tagent/shared").KnowledgeBaseDocument[]> => {
        assertKnowledgeBaseWritesEnabled();
        const controller = getBrowserController();
        const captured = await controller.captureDownload(input.sessionId);
        const downloadDirectory = captured.tempDirectory;
        if (!basename(downloadDirectory).startsWith("tagent-kb-download-")) {
          throw new Error("下载目录校验失败");
        }
        try {
          const reference = captured.sourceUrl
            ? parseCloudDocumentReference(captured.sourceUrl)
            : undefined;
          return await importKnowledgeBaseDocuments({
            knowledgeBaseId: input.knowledgeBaseId,
            filePath: captured.filePath,
            title: input.title?.trim() || undefined,
            sourceUrl: reference?.sourceUrl ?? (captured.sourceUrl || undefined),
            sourceProvider: reference?.provider,
            sourceExternalId: reference?.externalId,
            sourceAccessMode: "browser",
            sourceSyncedAt: Date.now(),
          });
        } finally {
          rmSync(downloadDirectory, { recursive: true, force: true });
        }
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.IMPORT_KNOWLEDGE_BASE_DOCUMENT_URL,
      async (
        _e,
        input: { knowledgeBaseId: string; url: string; title?: string },
      ) => {
        assertKnowledgeBaseWritesEnabled();
        return importKnowledgeBaseDocumentFromUrl(input);
      },
    );

    // 刀 4：导出知识库分享包（dialog.showSaveDialog 写单库 JSON）。
    // 返回 { ok, path?, reason?, error? }；取消 → ok:false reason:canceled；构建失败 → build_failed。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.EXPORT_KNOWLEDGE_BASE,
      async (
        _e,
        input: { id: string },
      ): Promise<{
        ok: boolean;
        path?: string;
        reason?: "canceled" | "build_failed" | "write_failed";
        error?: string;
      }> => {
        let json: string;
        let libName: string;
        try {
          const built = buildKnowledgeBaseSharePackage(input.id);
          json = built.json;
          libName = built.package.library.name;
        } catch (err) {
          return {
            ok: false,
            reason: "build_failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
        const { dialog } = await import("electron");
        const win = this.getWindow();
        const safeName =
          libName.replace(/[\\/:*?"<>|]/g, "_").trim() || "knowledge-base";
        const saveOptions = {
          title: "导出知识库分享包",
          defaultPath: `${safeName}.tagent-kb.json`,
          filters: [
            { name: "TAgent 知识库分享包", extensions: ["json"] },
          ],
        };
        const save = win
          ? await dialog.showSaveDialog(win, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (save.canceled || !save.filePath) {
          return { ok: false, reason: "canceled" };
        }
        try {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(save.filePath, json, "utf8");
          return { ok: true, path: save.filePath };
        } catch (err) {
          return {
            ok: false,
            reason: "write_failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );

    // 刀 4：导入知识库分享包（dialog.showOpenDialog 读 JSON → 校验 → 建新库）。
    // 取消 → null；JSON 坏 / format/version 不支持 → throw（渲染层 try/catch 出 toast）。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.IMPORT_KNOWLEDGE_BASE_SHARE,
      async (_e): Promise<KnowledgeBaseRecord | null> => {
        assertKnowledgeBaseWritesEnabled();
        const { dialog } = await import("electron");
        const win = this.getWindow();
        const openOptions = {
          title: "导入知识库分享包",
          properties: ["openFile"] as Array<"openFile">,
          filters: [{ name: "TAgent 知识库分享包", extensions: ["json"] }],
        };
        const result = win
          ? await dialog.showOpenDialog(win, openOptions)
          : await dialog.showOpenDialog(openOptions);
        if (result.canceled || !result.filePaths[0]) return null;
        const { readFileSync } = await import("node:fs");
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(result.filePaths[0], "utf8"));
        } catch (err) {
          throw new Error(
            "分享包文件不是合法的 JSON：" +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        return importKnowledgeBaseSharePackage(parsed);
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.OPEN_FOLDER_DIALOG,
      async (): Promise<string[]> => {
        const { dialog } = await import("electron");
        const win = this.getWindow();
        const options = {
          properties: ["openDirectory", "multiSelections"] as Array<
            "openDirectory" | "multiSelections"
          >,
          title: "选择知识库目录",
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? [] : result.filePaths;
      },
    );

    // 热切换会话权限模式：持久化 meta → 通知 runtime（kscc 走 SDK setPermissionMode；Pi 靠闭包读 meta）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE,
      async (
        _e,
        args: { sessionId: string; mode: TAgentPermissionMode },
      ): Promise<{ ok: boolean; error?: string }> => {
        const normalized = migratePermissionMode(args.mode);
        updateSessionMeta(args.sessionId, { permissionMode: normalized });
        const rt = this.runtimes.get(args.sessionId);
        if (rt) {
          try {
            await rt.setPermissionMode(normalized);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[会话 ${args.sessionId}] setPermissionMode 失败:`,
              msg,
            );
            return { ok: false, error: msg };
          }
        }
        return { ok: true };
      },
    );

    // 热切换 executionMode（Chat|Work）：仅用户源；Agent 工具不得调用
    // @see docs/decisions/ADR-0005-user-owned-mode-switch.md
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_EXECUTION_MODE,
      async (
        _e,
        args: {
          sessionId: string;
          mode: string;
          source?: string;
        },
      ): Promise<{
        ok: boolean;
        error?: string;
        mode?: ExecutionMode;
        backgroundCrew?: {
          running: number;
          ready: number;
          pending: number;
          boardId?: string;
        };
      }> => {
        if (!args?.sessionId) return { ok: false, error: "missing sessionId" };
        if (!isExecutionModeChangeSource(args.source)) {
          return {
            ok: false,
            error:
              "executionMode 仅允许用户切换（source 须为 user 或 user-confirm-suggestion）",
          };
        }
        const source: ExecutionModeChangeSource = args.source;
        if (args.mode !== "chat" && args.mode !== "work") {
          return {
            ok: false,
            error: `非法 executionMode: ${String(args.mode)}`,
          };
        }
        const next = args.mode as ExecutionMode;
        const meta = getSessionMeta(args.sessionId);
        if (!meta) return { ok: false, error: "会话不存在" };
        const prev = migrateExecutionMode(meta.executionMode);

        // Work→Chat（或切到 chat）时：检测会话看板 / parentSession 看板是否仍有在途任务
        const backgroundCrew =
          next === "chat"
            ? (() => {
                try {
                  let boardId = meta.boardId;
                  if (!boardId) {
                    boardId = listBoards({ status: "active" }).find(
                      (b) => b.parentSessionId === args.sessionId,
                    )?.id;
                  }
                  if (!boardId) return undefined;
                  const tasks = listTasksByBoard(boardId);
                  const running = tasks.filter(
                    (t) => t.status === "running",
                  ).length;
                  const ready = tasks.filter(
                    (t) => t.status === "ready",
                  ).length;
                  const pending = tasks.filter(
                    (t) => t.status === "pending",
                  ).length;
                  if (running + ready + pending <= 0) return undefined;
                  return { running, ready, pending, boardId };
                } catch {
                  return undefined;
                }
              })()
            : undefined;

        if (prev === next) {
          return {
            ok: true,
            mode: next,
            ...(backgroundCrew ? { backgroundCrew } : {}),
          };
        }

        const history = [...(meta.executionModeHistory ?? [])];
        history.push({ at: Date.now(), from: prev, to: next, source });
        // 只保留最近 20 条
        const trimmed = history.length > 20 ? history.slice(-20) : history;
        updateSessionMeta(args.sessionId, {
          executionMode: next,
          executionModeHistory: trimmed,
          // 确认/切换后清掉建议条
          pendingExecutionModeSuggestion: null,
        });
        // 用户主动切换 = 新意图：解除 dismiss 抑制，之后被拦可再建议
        clearModeSuggestionDismissal(args.sessionId);
        // 运行中切换：先软中断当前 turn（用户决策优先，不留半截任务继续跑）
        try {
          await this.runtimes.get(args.sessionId)?.interrupt();
        } catch (err) {
          console.warn(
            `[会话 ${args.sessionId}] 切换 executionMode 前中断失败:`,
            err,
          );
        }
        // 长驻进程在首条消息时锁定 MCP/systemPrompt；Chat↔Work 后须丢弃 kscc 进程，
        // 下次发送 re-spawn 才会出现 kanban_*；Pi 核则在下次 query 热重建 Agent。
        try {
          this.runtimes
            .get(args.sessionId)
            ?.dropLiveProcessForConfigChange(`executionMode ${prev}→${next}`);
        } catch (err) {
          console.warn(`[会话 ${args.sessionId}] dropLiveProcess 失败:`, err);
        }
        console.log(
          `[会话 ${args.sessionId}] executionMode ${prev} → ${next} (${source})`,
        );
        return {
          ok: true,
          mode: next,
          ...(backgroundCrew ? { backgroundCrew } : {}),
        };
      },
    );

    // 关闭形态切换建议条（不改 mode）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.DISMISS_EXECUTION_MODE_SUGGESTION,
      async (_e, args: { sessionId: string }): Promise<{ ok: boolean }> => {
        if (!args?.sessionId) return { ok: false };
        const meta = getSessionMeta(args.sessionId);
        if (!meta) return { ok: false };
        if (meta.pendingExecutionModeSuggestion) {
          updateSessionMeta(args.sessionId, {
            pendingExecutionModeSuggestion: null,
          });
        }
        // 用户点「留在 Chat」→ 本会话不再自动推建议（防工具循环反复弹）
        dismissModeSuggestion(args.sessionId);
        return { ok: true };
      },
    );

    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_MOA_PRESETS, async () => {
      return listMoaPresets();
    });

    // 保存整份 MoA 预置（设置页会诊班底 CRUD）：整单校验失败 reject 中文错、不写盘；
    // 合法则 writeMoaPresets 后再 list 回传（SPEC 04 §2.2）。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SAVE_MOA_PRESETS,
      async (_e, presets: MoAPreset[]): Promise<MoAPreset[]> => {
        const err = validateMoAPresetList(presets);
        if (err) throw new Error(err);
        writeMoaPresets(presets);
        return listMoaPresets();
      },
    );

    // CLI 工人配置（本机 coding CLI 子代理后端）：无文件则 list 就地 seed 默认（enabled=false）。
    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_CLI_WORKERS, async () => {
      return listCliWorkersConfig();
    });

    // 保存整份 CLI 工人配置（设置页 CRUD）：整单校验失败 reject 中文错、不写盘；
    // 合法则 writeCliWorkersConfig 后再 list 回传（与 moa 预置保存同口径）。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SAVE_CLI_WORKERS,
      async (_e, cfg: CliWorkersConfig): Promise<CliWorkersConfig> => {
        const err = validateCliWorkersConfig(cfg);
        if (err) throw new Error(err);
        writeCliWorkersConfig(cfg);
        return listCliWorkersConfig();
      },
    );

    // 本机探测 CLI 是否在 PATH（每台机器环境不同）；可选传入当前编辑中的 cfg
    // 先对账落盘（新增已安装 / 移除未安装占位 / 保留自定义），再探测对账后的配置
    ipcMain.handle(
      AGENT_IPC_CHANNELS.PROBE_CLI_WORKERS,
      async (_e, _cfg?: CliWorkersConfig) => {
        try {
          discoverAndReconcileCliWorkers();
        } catch (err) {
          console.warn("[cli-workers] 检测前对账失败：", err);
        }
        return probeCliWorkers();
      },
    );

    // No-Progress Guard 模式：返回 { effective, stored, envOverride }；设置只写落盘，env 仍可覆盖。
    ipcMain.handle(AGENT_IPC_CHANNELS.GET_NO_PROGRESS_GUARD_MODE, async () => {
      const stored = readNoProgressGuardModePref();
      const envRaw = process.env.TAGENT_NO_PROGRESS_GUARD_MODE;
      const envOverride =
        envRaw === "off" || envRaw === "shadow" || envRaw === "enforce"
          ? envRaw
          : null;
      const effective = resolveNoProgressGuardMode(process.env, stored);
      return { effective, stored, envOverride } as {
        effective: NoProgressGuardMode;
        stored: NoProgressGuardMode | null;
        envOverride: NoProgressGuardMode | null;
      };
    });
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SET_NO_PROGRESS_GUARD_MODE,
      async (_e, mode: NoProgressGuardMode) => {
        writeNoProgressGuardModePref(mode);
        const stored = readNoProgressGuardModePref();
        const envRaw = process.env.TAGENT_NO_PROGRESS_GUARD_MODE;
        const envOverride =
          envRaw === "off" || envRaw === "shadow" || envRaw === "enforce"
            ? envRaw
            : null;
        return {
          effective: resolveNoProgressGuardMode(process.env, stored),
          stored,
          envOverride,
        };
      },
    );

    // 圆桌（agent-discuss）偏好：读缺失/损坏 → 默认；写整单校验非法即 reject 中文错。
    // 本期部分字段运行时闸未接（maxAgentMentionDepth），仅落盘 + UI（见 FINDINGS）。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_DISCUSS_PREFS,
      async (): Promise<AgentDiscussPrefs> => {
        return readAgentDiscussPrefs();
      },
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SET_DISCUSS_PREFS,
      async (_e, prefs: unknown): Promise<AgentDiscussPrefs> => {
        // writeAgentDiscussPrefs 内部 validate + 抛中文错 → ipc reject → renderer catch 回显
        writeAgentDiscussPrefs(prefs);
        return readAgentDiscussPrefs();
      },
    );

    // 班组（agent-crew）偏好：读缺失/损坏 → 默认；写整单校验非法即 reject 中文错。
    // 本期部分字段运行时闸未接（maxParallelWorkers 调度 / showFlowAsGraph 阶段3），仅落盘 + UI（见 FINDINGS）。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_CREW_PREFS,
      async (): Promise<AgentCrewPrefs> => {
        return readAgentCrewPrefs();
      },
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.SET_CREW_PREFS,
      async (_e, prefs: unknown): Promise<AgentCrewPrefs> => {
        writeAgentCrewPrefs(prefs);
        return readAgentCrewPrefs();
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.LIST_SESSION_PROCESSES,
      async (_e, sessionId: string) => {
        return listSessionProcesses(
          typeof sessionId === "string" ? sessionId : "",
        );
      },
    );
    ipcMain.handle(
      AGENT_IPC_CHANNELS.KILL_SESSION_PROCESS,
      async (_e, input: { sessionId?: string; id?: string }) => {
        const sessionId =
          typeof input?.sessionId === "string" ? input.sessionId : "";
        const id = typeof input?.id === "string" ? input.id : "";
        if (!sessionId || !id)
          return { ok: false, error: "缺少 sessionId 或进程 id" };
        return killSessionProcess(sessionId, id);
      },
    );
    subscribeSessionProcesses((sessionId, processes) => {
      try {
        this.getWindow()?.webContents.send(
          AGENT_IPC_CHANNELS.SESSION_PROCESSES_CHANGED,
          {
            sessionId,
            processes,
          },
        );
      } catch {
        /* window gone */
      }
    });

    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_SESSIONS, async () => {
      const sessions = listSessions();
      console.log(
        `[会话] listSessions 返回 ${sessions.length} 个会话，isArray=${Array.isArray(sessions)}`,
      );
      return sessions;
    });

    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_SDK_MESSAGES,
      async (_e, sessionId: string) => {
        // 从 session meta 查 workspaceId，兼容旧数据（无 workspaceId 传 undefined）
        // Phase 1.2：面板历史读只追加那份，不受 SDK JSONL 压缩影响
        const meta = getSessionMeta(sessionId);
        return readPanelMessages(meta?.workspaceId, sessionId);
      },
    );

    ipcMain.handle(
      AGENT_IPC_CHANNELS.DELETE_SESSION,
      async (_e, sessionId: string) => {
        const rt = this.runtimes.get(sessionId);
        if (rt) {
          rt.destroy();
          this.runtimes.delete(sessionId);
        }
        this.clearPendingSteer(sessionId);
        // 清会话权限白名单（「始终允许」状态）
        PermissionService.clearWhitelist(sessionId);
        // 清待处理 AskUser 请求（resolve deny「会话已结束」）
        askUserService.clearSessionPending(sessionId);
        // 清无进展暂停 AskUser 的 abort controller
        this.noProgressAskUserAbortBySession.delete(sessionId);
        // 清待处理 ExitPlanMode 审批请求（resolve deny「会话已结束」+ 推 RESOLVED 让渲染层出队）
        for (const rid of exitPlanService.clearSessionPending(sessionId)) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESOLVED,
            {
              requestId: rid,
            },
          );
        }
        // 清待处理 kb_propose_save 确认请求（resolve aborted 零写入 + 推 RESOLVED 让渲染层出队）
        for (const rid of kbProposeSaveService.clearSessionPending(sessionId)) {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.KB_PROPOSE_SAVE_RESOLVED,
            {
              requestId: rid,
            },
          );
        }
        // E/落盘闸口：清会话级 delta 追踪器 + 落盘闸口，防 Map 无界增长
        this.deltaTrackerBySession.delete(sessionId);
        this.streamPersistGateBySession.delete(sessionId);
        deleteSessionMeta(sessionId);
        // Phase 2.5：记忆层标记会话已删（L0/L2/L3/L5 行加 deleted:1）
        void nudgeService.markSessionDeleted(sessionId).catch((err) => {
          console.warn("[session-service] markSessionDeleted failed:", err);
        });
        return { ok: true };
      },
    );

    // 更新会话元数据（重命名 title / 置顶 pinned / 归档 archived / 子代理委派积极性 subagentEagerness /
    // 会话偏好 CLI 工人 cliWorkerId 等；status 仅主进程内部写 error/idle，渲染层不直接写）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_META,
      async (
        _e,
        args: {
          id: string;
          patch: Pick<
            Partial<AgentSessionMeta>,
            | "title"
            | "modelId"
            | "pinned"
            | "archived"
            | "subagentEagerness"
            | "reasoningEffort"
            | "cliWorkerId"
            | "internalBackend"
            | "botProfileIds"
            | "turnDurations"
            | "kbRoots"
            | "knowledgeBaseIds"
            | "knowledgeBaseMode"
          >;
        },
      ) => {
        // 规范化 subagentEagerness（非法值回退默认）；cliWorkerId 非字符串或 trim 后为空 → undefined，否则 trim；
        // 其余字段透传 updateSessionMeta 合并写。cliWorkerId 不校验是否在启用池（resolve 层已有回落）。
        const patch: Partial<AgentSessionMeta> = { ...args.patch };
        if (patch.subagentEagerness !== undefined) {
          patch.subagentEagerness = migrateSubagentEagerness(
            patch.subagentEagerness,
          );
        }
        if (patch.cliWorkerId !== undefined) {
          const v = patch.cliWorkerId;
          patch.cliWorkerId =
            typeof v === "string" && v.trim() ? v.trim() : undefined;
        }
        if (
          patch.internalBackend !== undefined &&
          patch.internalBackend !== "codex-app-server" &&
          patch.internalBackend !== "kscc"
        ) {
          patch.internalBackend = undefined;
        }
        if (patch.knowledgeBaseIds !== undefined) {
          patch.knowledgeBaseIds = Array.isArray(patch.knowledgeBaseIds)
            ? [
                ...new Set(
                  patch.knowledgeBaseIds
                    .filter(
                      (id): id is string =>
                        typeof id === "string" && Boolean(id.trim()),
                    )
                    .map((id) => id.trim()),
                ),
              ]
            : [];
        }
        if (patch.knowledgeBaseMode !== undefined) {
          const mode = patch.knowledgeBaseMode;
          const hasKnowledgeBase =
            (
              patch.knowledgeBaseIds ??
              getSessionMeta(args.id)?.knowledgeBaseIds ??
              []
            ).length > 0;
          patch.knowledgeBaseMode =
            hasKnowledgeBase && (mode === "preferred" || mode === "strict")
              ? mode
              : "off";
        }
        if (patch.kbRoots !== undefined) {
          // 规范化知识库绑定根目录：仅保留 trim 后非空字符串、去重；空数组 = 解除绑定。
          // 不在此强制绝对路径（跨平台判定繁琐），kb-fs-index 在访问时按 root 解析并做容器校验防穿越。
          patch.kbRoots = Array.isArray(patch.kbRoots)
            ? [
                ...new Set(
                  patch.kbRoots
                    .map((r) => (typeof r === "string" ? r.trim() : ""))
                    .filter((r): r is string => Boolean(r)),
                ),
              ]
            : [];
        }
        if (patch.botProfileIds !== undefined) {
          patch.botProfileIds = Array.isArray(patch.botProfileIds)
            ? [
                ...new Set(
                  patch.botProfileIds
                    .filter(
                      (id): id is string =>
                        typeof id === "string" && Boolean(id.trim()),
                    )
                    .map((id) => id.trim()),
                ),
              ]
            : [];
          const previous = getSessionMeta(args.id);
          const nextBotIds = patch.botProfileIds;
          patch.fusionMode = getFusionConversationMode(1, nextBotIds.length);
          const previousCoordinator = previous?.fusionCoordinatorBotProfileId;
          patch.fusionCoordinatorBotProfileId =
            previousCoordinator && nextBotIds.includes(previousCoordinator)
              ? previousCoordinator
              : nextBotIds[0];
          if (nextBotIds.length < 2) {
            patch.fusionCoordinatorBotProfileId = undefined;
          }
        }
        const previous = getSessionMeta(args.id);
        const updated = updateSessionMeta(args.id, patch);
        if (
          patch.internalBackend !== undefined &&
          previous?.internalBackend !== updated?.internalBackend
        ) {
          this.runtimes.get(args.id)?.destroy();
          this.runtimes.delete(args.id);
        }
        if (
          (patch.kbRoots !== undefined &&
            JSON.stringify(previous?.kbRoots ?? []) !==
              JSON.stringify(updated?.kbRoots ?? [])) ||
          (patch.knowledgeBaseIds !== undefined &&
            JSON.stringify(previous?.knowledgeBaseIds ?? []) !==
              JSON.stringify(updated?.knowledgeBaseIds ?? [])) ||
          (patch.knowledgeBaseMode !== undefined &&
            (previous?.knowledgeBaseMode ?? "off") !==
              (updated?.knowledgeBaseMode ?? "off"))
        ) {
          // KB 工具/提示词是在 spawn 时装配的。kscc 是长驻进程，必须丢弃旧进程；
          // Pi 会在下一轮依据 toolingKey 自动重建 Agent。
          try {
            this.runtimes
              .get(args.id)
              ?.dropLiveProcessForConfigChange(
                "knowledge-base configuration changed",
              );
          } catch (err) {
            console.warn(`[会话 ${args.id}] KB 配置变化重建进程失败:`, err);
          }
        }
        return updated;
      },
    );

    // 置顶切换
    ipcMain.handle(AGENT_IPC_CHANNELS.TOGGLE_PIN, async (_e, id: string) => {
      const meta = getSessionMeta(id);
      return updateSessionMeta(id, { pinned: !meta?.pinned });
    });

    // 归档切换
    ipcMain.handle(
      AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE,
      async (_e, id: string) => {
        const meta = getSessionMeta(id);
        return updateSessionMeta(id, { archived: !meta?.archived });
      },
    );

    // 查会话生命状态（runtimes 内存 turnInFlight 优先 → meta.error → idle；archived 一并返回）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_SESSION_STATUS,
      async (_e, id: string) => {
        return this.getStatus(id);
      },
    );

    // 清除 Chat @ 对话跟随（activeSpeaker；回默认总助）。pendingMentionRoleIds 置 undefined。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.CLEAR_MENTION_FOLLOW,
      async (_e, id: string) => {
        return updateSessionMeta(id, { pendingMentionRoleIds: undefined });
      },
    );

    // 手动压缩会话上下文（Pi 核；kscc 暂不支持返回 reason）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.COMPACT_SESSION,
      async (
        _e,
        args: { sessionId: string },
      ): Promise<{
        ok: boolean;
        compacted: boolean;
        reason?: string;
        tokensBefore?: number;
      }> => {
        const sessionId = args?.sessionId;
        if (!sessionId)
          return { ok: false, compacted: false, reason: "missing sessionId" };
        const meta = getSessionMeta(sessionId);
        const channelId = meta?.channelId;
        const channel = channelId ? getChannel(channelId) : undefined;
        const kind: ChannelKind =
          channel?.provider === "kscc-internal" ? "kscc" : "external";
        const adapter = getAdapter(kind);
        if (typeof adapter.compactSession !== "function") {
          return {
            ok: false,
            compacted: false,
            reason: "当前运行核不支持手动压缩",
          };
        }
        // 确保 Agent 已创建：无 runtime 时用户仅打开历史也可能未 spawn
        if (!adapter.hasActiveChannel?.(sessionId)) {
          return {
            ok: false,
            compacted: false,
            reason: "会话尚未在本机启动，请先发送一条消息",
          };
        }
        const result = await adapter.compactSession(sessionId, {
          force: true,
          trigger: "manual",
        });
        // 立即把 pending system 事件推给 UI（不等下一轮 query）
        this.flushPiPendingSystemMessages(
          sessionId,
          adapter,
          meta?.workspaceId,
        );
        return {
          ok: result.ok,
          compacted: result.compacted,
          reason: result.reason,
          tokensBefore: result.tokensBefore,
        };
      },
    );
  }

  /** 排出 Pi compactSession 暂存的 system 事件到渲染层（已是 TAgentDesktopStreamPayload） */
  private flushPiPendingSystemMessages(
    sessionId: string,
    adapter: AgentProviderAdapter,
    workspaceId?: string,
  ): void {
    const pi = adapter as PiAgentAdapter;
    if (typeof pi.drainPendingSystemMessages !== "function") return;
    const payloads = pi.drainPendingSystemMessages(sessionId);
    for (const p of payloads) {
      this.handlePiStreamPayload(sessionId, workspaceId, p);
    }
  }

  /**
   * 组合会话生命状态（侧栏状态色点用）。
   * - runtimes 内存 turnInFlight → 'running'（不落盘，重启即失）
   * - meta.status === 'error' → 'error'（落盘，重启保留）
   * - 其余 → 'idle'
   * 用 isTurnInFlight() 而非 isRunning()：长驻进程 isRunning 恒 true，不表达"当前轮在跑"。
   */
  private getStatus(id: string): {
    status: "idle" | "running" | "error";
    archived: boolean;
  } {
    const meta = getSessionMeta(id);
    const rt = this.runtimes.get(id);
    if ((rt && rt.isTurnInFlight()) || this.moaInFlight.has(id)) {
      return { status: "running", archived: !!meta?.archived };
    }
    if (meta?.status === "error")
      return { status: "error", archived: !!meta?.archived };
    return { status: "idle", archived: !!meta?.archived };
  }

  /**
   * 已升级为协作室的会话走既有 RoomService 调度器。
   * 这里不再启动普通会话 runtime；RoomService 负责 mention 路由、协调者默认承接、
   * A2A 信箱、工具桥和工作区安全边界。主会话仅保留用户回显并收口本轮状态。
   */
  private handleLinkedCollaborationRoomSend(
    input: SendMessageInput,
    meta: AgentSessionMeta,
    options: { mainMessageAlreadyPersisted?: boolean } = {},
  ): boolean {
    if (input.skipFusionRouting || !meta.fusionRoomId) return false;

    const service = getRegisteredCollaborationRoomService();
    if (!service) {
      this.recoverStaleCollaborationLink(meta, "协作室服务未启用");
      return false;
    }
    const room = service.getRoomById(meta.fusionRoomId);
    if (!room) {
      this.recoverStaleCollaborationLink(meta, "关联房间不存在");
      return false;
    }

    const content = input.attachments?.length
      ? appendAttachmentPathsToPrompt(input.prompt, input.attachments)
      : input.prompt;
    service.appendUserMessage({ roomId: room.id, content });

    if (options.mainMessageAlreadyPersisted !== true) {
      const userMessage: TAgentMessage = {
        type: "user",
        createdAt: Date.now(),
        content: [{ type: "text", text: input.prompt }],
        ...(input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
      };
      try {
        appendPanelMessages(meta.workspaceId, input.sessionId, [userMessage]);
      } catch (error) {
        console.warn("[session-service] 协作室会话用户消息落盘失败:", error);
      }
      this.sendPayload(input.sessionId, {
        kind: "sdk_message",
        message: userMessage,
      });
    }
    updateSessionMeta(input.sessionId, {
      status: "idle",
      turnCount: (meta.turnCount ?? 0) + 1,
    });
    this.sendPayload(input.sessionId, {
      kind: "tagent_event",
      event: { type: "turn_end" },
    });
    return true;
  }

  /**
   * 旧会话可能在协作室服务关闭、房间被清理或跨版本迁移后仍残留 fusionRoomId。
   * 这种标记不能继续阻塞普通主会话；仅在确认「服务不可用 / 房间不存在」时清理，
   * 有效房间仍由 handleLinkedCollaborationRoomSend 正常接管。
   */
  private recoverStaleCollaborationLink(
    meta: AgentSessionMeta,
    reason: string,
  ): void {
    const botIds = [...new Set(meta.botProfileIds ?? [])].filter(
      (id): id is string => Boolean(id),
    );
    const fusionMode = getFusionConversationMode(1, botIds.length);
    const coordinator =
      fusionMode === "multi-bot" &&
      meta.fusionCoordinatorBotProfileId &&
      botIds.includes(meta.fusionCoordinatorBotProfileId)
        ? meta.fusionCoordinatorBotProfileId
        : fusionMode === "multi-bot"
          ? botIds[0]
          : undefined;

    updateSessionMeta(meta.id, {
      fusionRoomId: undefined,
      fusionMode,
      fusionCoordinatorBotProfileId: coordinator,
    });
    this.notifySessionMetaChanged(meta.id);
    console.warn(
      `[session-service] 已清理失效协作链接，恢复主会话：${meta.id}（${reason}）`,
    );
  }

  /** 处理发消息：解析渠道→锁定运行内核→首次 spawn / 后续同内核切换模型 */
  private async handleSend(input: SendMessageInput): Promise<void> {
    // 用户手动新开一轮 → abort 旧的无进展 AskUser（若仍 pending），防止回答旧问题时再触发一次续跑
    this.noProgressAskUserAbortBySession.get(input.sessionId)?.abort();
    this.noProgressAskUserAbortBySession.delete(input.sessionId);
    const requestedMeta = getSessionMeta(input.sessionId);
    if (
      requestedMeta &&
      this.handleLinkedCollaborationRoomSend(input, requestedMeta)
    )
      return;

    const requestedChannelId = input.channelId ?? getKsccChannelId();
    // 会话参与的 Bot 只用于独立旁路窗口；主会话沿用自身渠道/模型。
    const channelId = requestedChannelId;
    if (!channelId) {
      throw new Error(
        "未选择渠道，且未找到 kscc 内置渠道（请在渠道管理中添加）",
      );
    }
    const channel = getChannel(channelId);
    if (!channel) {
      throw new Error(`渠道不存在：${channelId}（请在渠道管理中添加）`);
    }
    if (!channel.enabled) {
      throw new Error(`渠道「${channel.name}」已禁用，请先启用`);
    }

    const meta = getSessionMeta(input.sessionId);
    const adapterKind: ChannelKind =
      channel.provider === "kscc-internal"
        ? resolveInternalAdapterKind(meta, input.internalBackend)
        : "external";

    // Phase 2.5：每轮 turn 开始统一跑 Nudge（双核共用，读面板消息）
    this.runNudgeOnTurnStart(input.sessionId, meta);

    // 会话只锁定运行内核：KSCC 内网与外部运行时不可互切；
    // 同一内核里的渠道和模型都允许在后续轮次继续选择。
    if (meta?.channelId) {
      const boundChannel = getChannel(meta.channelId);
      if (!boundChannel) {
        throw new Error("该会话原绑定渠道已不存在，无法确认运行内核");
      }
      const boundKind: ChannelKind =
        boundChannel.provider === "kscc-internal"
          ? resolveInternalAdapterKind(meta)
          : "external";
      if (boundKind !== adapterKind) {
        throw new Error(
          `该会话已锁定${boundKind === "kscc" ? "KSCC 内网" : "外部"}运行时，不能跨运行内核切换`,
        );
      }
    }
    // 解析 workspaceId：优先用 input 传入，否则从已有 meta 读（MoA 分支也要用）
    const workspaceId = input.workspaceId ?? meta?.workspaceId;

    // MoA 会诊：虚拟 modelId `moa:<presetId>` 在 resolveModel 之前分流——
    // resolveModel 会因 moa:* 不属于渠道模型而抛错；且严禁 setModel('moa:…') / 把 moa:* 传给 kscc。
    // 走 runMoaTurn 独立编排（参考席 + 汇总 + 圆桌卡），完成后 return，不走 adapter.query。
    const rawModel =
      input.model ?? (meta?.channelId === channelId ? meta.modelId : undefined);
    if (isMoaModelId(rawModel)) {
      await this.runMoATurn(
        input,
        channel,
        rawModel,
        meta,
        workspaceId,
        /* sticky */ true,
      );
      return;
    }

    // One-shot 会诊本条：渲染层点「会诊 ▾」选预置后单次走 runMoATurn；
    // **不**改 meta.modelId，会话 tab / ModelSelector 仍显示真实模型（SPEC §3）。
    if (input.moaOneShotPresetId) {
      const oneShotModelId = moaModelId(input.moaOneShotPresetId);
      // 与 sticky 走同一调度：resolveMoADispatch 校验预置 / 渠道 / 模型可用性，
      // 失败时会诊路径已各自 sendPayload 上报 session_error + turn_end。
      await this.runMoATurn(
        input,
        channel,
        oneShotModelId,
        meta,
        workspaceId,
        /* sticky */ false,
      );
      return;
    }

    // 圆桌讨论本条（one-shot）：渲染层点「圆桌讨论 ▾」选预置后单次走 runMoADiscussion
    // （多轮讨论+总结人收口）。**不**改 meta.modelId，会话 tab / ModelSelector 仍显示真实模型
    // （与会诊 one-shot 一致，SPEC §3）。预置/渠道/模型可用性校验在 runMoADiscussionTurn 内
    // 经 resolveMoADispatch 完成，失败时上报 session_error + turn_end。
    if (input.moaDiscussionPresetId) {
      await this.runMoADiscussionTurn(
        input,
        channel,
        input.moaDiscussionPresetId,
        meta,
        workspaceId,
      );
      return;
    }

    const modelId = this.resolveModel(channel, rawModel);
    const normalizedInput: SendMessageInput = {
      ...input,
      channelId,
      model: modelId,
    };
    if (input.fusionAdvisorContext) {
      normalizedInput.prompt =
        input.fusionAdvisorContext + "nn" + normalizedInput.prompt;
    }

    // Chat @：解析提及并写入 pendingMentionRoleIds（Work 默认不启用多角色乱 @）
    const execMode = migrateExecutionMode(
      meta?.executionMode ?? getSessionMeta(input.sessionId)?.executionMode,
    );
    if (execMode === "chat") {
      try {
        const roles = loadRoles();
        const fromText = parseMentions(
          input.prompt,
          roles.map((r: { id: string; displayName: string }) => ({
            id: r.id,
            displayName: r.displayName,
          })),
        ).map((h) => h.roleId);
        const fromInput = Array.isArray(input.mentionRoleIds)
          ? input.mentionRoleIds.map(String).filter(Boolean)
          : [];
        const ordered = [...fromInput];
        for (const id of fromText) {
          if (!ordered.includes(id)) ordered.push(id);
        }
        // followMode：有 @ → 切换/设置 activeSpeaker；无 @ → 保留上一轮的 pendingMentionRoleIds（连续追问同一角色）
        if (ordered.length > 0) {
          updateSessionMeta(input.sessionId, {
            pendingMentionRoleIds: ordered,
          });
        }
      } catch (err) {
        console.warn("[会话] 解析 @ 提及失败:", err);
      }
    }

    const adapter = getAdapter(adapterKind);
    let rt = this.runtimes.get(input.sessionId);
    let isFirst = !rt || !rt.hasLiveProcess();
    // KSCC 的长驻进程只在 spawn 时读取 system prompt；旁路 Bot 的主会话前情提要
    // 可能随父会话变化，因此带 contextPrompt 的后续回合需要按新前情提要重建。
    if (
      !isFirst &&
      adapterKind === "kscc" &&
      normalizedInput.contextPrompt?.trim()
    ) {
      rt!.dropLiveProcessForConfigChange("sidecar-context-refresh");
      isFirst = true;
    }

    console.log(
      `[会话 ${input.sessionId}] ${isFirst ? "首次：spawn + 起循环" : "后续：复用长驻进程 enqueue"}（渠道=${channel.name} 核=${adapterKind} workspaceId=${workspaceId ?? "(无)"}）`,
    );

    // KSCC 是真正的长驻 Query，同内核切模型时先调用 SDK 热切接口。
    if (!isFirst && adapterKind === "kscc" && meta?.modelId !== modelId) {
      await rt!.setModel(modelId);
      console.log(
        `[会话 ${input.sessionId}] KSCC 热切模型：${meta?.modelId ?? "(未记录)"} → ${modelId}`,
      );
    }

    // 持久化用户消息到 JSONL 并推渲染层。按核分流：
    // - kscc：落盘 SDKMessage（resume 读 JSONL 要此格式）+ sdkMessageToIR 推 IR
    // - pi：直接落盘 IR（pi 自管上下文，不靠 SDK resume）+ 直推 IR
    if (!input.skipUserPersist) {
      if (adapterKind === "kscc") {
        const now = Date.now();
        const userMsg: SDKMessage = {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: input.prompt }],
          },
          parent_tool_use_id: null,
          createdAt: now,
          ...(input.isSteer ? { isSteer: true } : {}),
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
        } as unknown as SDKMessage;
        // Phase 1.2 双写：先面板（保可见）再 SDK（resume）
        try {
          appendPanelMessages(workspaceId, input.sessionId, [userMsg]);
        } catch (err) {
          console.warn(
            "[session-service] appendPanelMessages failed (user):",
            err,
          );
        }
        try {
          appendSdkMessages(workspaceId, input.sessionId, [userMsg]);
        } catch (err) {
          console.error(
            "[session-service] appendSdkMessages failed (user):",
            err,
          );
        }
        const { message: userIR } = sdkMessageToIR(userMsg);
        if (userIR) {
          if (input.attachments?.length)
            (userIR as any).attachments = input.attachments;
          this.sendPayload(input.sessionId, {
            kind: "sdk_message",
            message: userIR,
          });
        }
      } else {
        const userIR: TAgentMessage = {
          type: "user",
          createdAt: Date.now(),
          ...(input.isSteer ? { isSteer: true } : {}),
          content: [{ type: "text", text: input.prompt }],
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
        };
        // pi 只写面板份（无 SDK resume；L-rag / 历史统一读面板）
        try {
          appendPanelMessages(workspaceId, input.sessionId, [userIR]);
        } catch (err) {
          console.warn(
            "[session-service] appendPanelMessages failed (pi user):",
            err,
          );
        }
        this.sendPayload(input.sessionId, {
          kind: "sdk_message",
          message: userIR,
        });
      }
    }

    // T7 续聊注入 + P0 #1（AUDIT-fresh-session-consult）：夹中场景「普通轮 → 圆桌（快速/研讨）→ 续聊」
    // 长驻进程（kscc live loop / Pi SessionEntry）的内存上下文**不含** MoA bare 轮共识——MoA 单发不经
    // 主会话 entry、不写 kscc resume 文件，共识只落 TAgent 面板 JSONL。续聊时按「进程/Agent 是否已有
    // 普通轮上下文」分两子况补 MoA 上下文，避免模型回「这个会话没有上文」：
    //   - LIVE（adapter.hasActiveChannel：kscc live 进程 / Pi 内存 Agent，内存已有普通轮）→ 仅前置 MoA
    //     结论片段，不重 spawn、不注入全量面板历史（避免与内存普通轮重复）。kscc live 续轮（isFirst=false
    //     enqueue）+ Pi 内存 Agent 续轮（isFirst=true 但 hasActiveChannel）均走此。
    //   - RESTART/无进程（!hasActiveChannel）→ 注入全量面板历史（含普通轮+圆桌轮，buildResumeHistoryFromPanel）
    //     并抑制 resume（不读 kscc resume 文件 → 无双上下文）。面板有 MoA 时即使有 sdkSessionId 也走注入；
    //     面板无 MoA → 保持现状（原 P0 #1：仅 isFirst && !sdkSessionId && !hasActiveChannel 才注入，有
    //     sdkSessionId 走 resume 读普通轮）。
    // 上方已把本轮 user 落盘为面板末条；buildResumeHistoryFromPanel 默认 excludeTrailingTurn 排除它，
    // extractMoAConclusionFromMessages 只匹配 assistant + moa-agg-*/moa-disc-agg-* uuid（本轮 user 不匹配），均无重复。
    const moaCtx = this.buildMoaContinuationContext(
      workspaceId,
      input.sessionId,
    );
    const hasActiveChannel = !!adapter.hasActiveChannel?.(input.sessionId);
    let suppressResume = false;
    if (moaCtx.hasMoAConclusion) {
      if (hasActiveChannel) {
        // LIVE：仅前置 MoA 结论片段（不注入全量历史，避免与内存普通轮重复）
        normalizedInput.prompt = `${moaCtx.conclusionText}nn${normalizedInput.prompt}`;
        console.log(
          `[会话 ${input.sessionId}] T7 LIVE 注入：活跃进程前置 ${moaCtx.conclusionText.length} 字 MoA 结论进本轮 prompt`,
        );
      } else if (moaCtx.historyText) {
        // RESTART/无进程：注入全量面板历史 + 抑制 resume（不读 kscc resume 文件，无双上下文）
        normalizedInput.prompt = composeMoaPrompt(
          normalizedInput.prompt,
          moaCtx.historyText,
        );
        suppressResume = true;
        console.log(
          `[会话 ${input.sessionId}] T7 RESTART 注入：面板含 MoA，忽略 resumeSessionId 走注入路径（${moaCtx.historyText.length} 字历史）`,
        );
      }
    } else if (
      isFirst &&
      !(adapterKind === "codex" ? meta?.codexThreadId : meta?.sdkSessionId) &&
      !hasActiveChannel
    ) {
      // 无 MoA → 保持现状（原 P0 #1）：首条 spawn 且无 sdkSessionId/无内存 Agent → 拼面板历史补上下文
      if (moaCtx.historyText) {
        normalizedInput.prompt = composeMoaPrompt(
          normalizedInput.prompt,
          moaCtx.historyText,
        );
        console.log(
          `[会话 ${input.sessionId}] 续聊注入：无 sdkSessionId/无内存 Agent，拼 ${moaCtx.historyText.length} 字历史进本轮 prompt`,
        );
      }
    }

    // 附件：面板 JSONL 已带 attachments 元数据；此处必须注入运行核可见内容，
    // 否则 Agent 只看到纯文本（UI「已发送」≠ 核侧收到）。
    if (normalizedInput.attachments?.length) {
      normalizedInput.prompt = appendAttachmentPathsToPrompt(
        normalizedInput.prompt,
        normalizedInput.attachments,
      );
    }

    if (isFirst) {
      // 首条或进程重建：记录本轮真实使用的渠道和模型。
      if (!meta) {
        createSession({
          id: input.sessionId,
          title: input.prompt.slice(0, 20) || "新会话",
          channelId,
          modelId,
          internalBackend: persistedInternalBackend(adapterKind),
          workspaceId,
          turnCount: 1,
          executionMode: input.executionMode,
        });
        console.log(
          `[会话 ${input.sessionId}] 已创建会话元数据，运行内核=${adapterKind}，workspaceId=${workspaceId ?? "(无)"}`,
        );
      } else {
        updateSessionMeta(input.sessionId, {
          channelId,
          modelId,
          internalBackend: persistedInternalBackend(adapterKind),
          workspaceId,
          turnCount: (meta.turnCount ?? 0) + 1,
        });
      }
      // 建 SessionRuntime + 起循环
      rt = new SessionRuntime(input.sessionId, adapter);
      this.runtimes.set(input.sessionId, rt);
      rt.setCallbacks({
        onMessage: (msg: SDKMessage) => {
          // 按核分流：kscc 产 SDKMessage → sdkMessageToIR；pi 实际产 TAgentDesktopStreamPayload（经 as 适配契约）
          if (adapterKind === "kscc") {
            this.handleSdkStreamMessage(input.sessionId, workspaceId, msg);
          } else {
            this.handlePiStreamPayload(
              input.sessionId,
              workspaceId,
              msg as unknown as TAgentDesktopStreamPayload,
            );
          }
        },
        onTurnEnd: () => {
          // 轮成功结束 → 清除可能的 error，落盘 idle。
          // 注意：不再清空 pendingMentionRoleIds —— 它现在是持久的 activeSpeaker（followMode），
          // 连续追问同一角色时下一轮无 @ 仍由该角色接；用户在输入框 ✕ 清除走 CLEAR_MENTION_FOLLOW。
          updateSessionMeta(input.sessionId, {
            status: "idle",
          });
          this.planStepSignalsSeenBySession.delete(input.sessionId);
          this.sendPayload(input.sessionId, {
            kind: "tagent_event",
            event: { type: "turn_end" },
          });
          // REGRESS-G：兜底 flush 待提交 assistant（result 路径已自行 flush，此处幂等）
          this.flushStreamPersistGateFor(input.sessionId);
          // Phase 2.5：L4 recordSession + evidence sink
          this.recordSessionToMemory(input.sessionId, input.prompt);
          // kscc 长驻：result 后 loop 不退，pending（live 失败降级）须在此 flush。
          // Pi：不可在此 flush——仍在 for-await 内，会把 turnInFlight 再置真 → 旧 loop 误判崩溃。
          if (adapterKind !== "external") {
            this.flushPendingSteer(input.sessionId);
          }
          this.resolveNextTurnEndWaiters(input.sessionId);
          this.cleanupAgentBrowser(input.sessionId);
        },
        onLoopIdle: () => {
          // Pi（及 kscc 进程退出）：loop 停稳后再开下一轮，避免假「自动恢复失败」
          this.flushPendingSteer(input.sessionId);
        },
        onError: (err: Error) => {
          // 出错 → 落盘 error（重启保留，下轮成功回 idle）
          updateSessionMeta(input.sessionId, { status: "error" });
          this.planStepSignalsSeenBySession.delete(input.sessionId);
          const msg = err.message;
          this.sendPayload(input.sessionId, {
            kind: "tagent_event",
            event: {
              type: "session_error",
              message: msg,
              error: classifyUserFacingError(msg),
            },
          });
          this.resolveNextTurnEndWaiters(input.sessionId);
          this.cleanupAgentBrowser(input.sessionId);
        },
      });

      await rt.sendMessage(
        await this.buildQueryOptions(
          normalizedInput,
          channel,
          workspaceId,
          suppressResume ? { suppressResume: true } : undefined,
        ),
      );
    } else {
      updateSessionMeta(input.sessionId, {
        channelId,
        modelId,
        internalBackend: persistedInternalBackend(adapterKind),
        turnCount: (meta?.turnCount ?? 0) + 1,
      });
      // 长驻会话的后续轮次只 enqueue userMessage，不会重新构建 system prompt。
      // 因此自动分阶段指令需要临时放进本轮模型消息；它不改 normalizedInput，
      // 不落盘、不出现在用户气泡里，也不影响首轮 spawn（首轮由 queryOptions 注入）。
      const liveAutoPlanPrompt =
        buildAutoKanbanPrompt(
          normalizedInput.prompt,
          this.getExecutionMode(input.sessionId),
          input.isSteer,
        ) ||
        buildAutoPlanPrompt(
          normalizedInput.prompt,
          this.getExecutionMode(input.sessionId),
          input.isSteer,
        );
      const liveModelPrompt = liveAutoPlanPrompt
        ? liveAutoPlanPrompt + "nn" + normalizedInput.prompt
        : normalizedInput.prompt;
      // 后续：enqueue。prompt 已含路径附录；图片再打成 image block。
      const userMessage: SDKUserMessageInput = {
        type: "user",
        message: {
          role: "user",
          content: attachImageBlocksToText(liveModelPrompt, input.attachments),
        },
        parent_tool_use_id: null,
      } as unknown as SDKUserMessageInput;
      await rt!.sendMessage(
        await this.buildQueryOptions(normalizedInput, channel, workspaceId),
        userMessage,
      );
    }
  }

  /**
   * MoA 会诊单轮：会话 modelId 为 `moa:<presetId>` 时由 handleSend 分流到此。
   * 解析预置 → 建核验 → 起 AbortController → 委托 run-moa-turn 模块编排。
   * 绝不 setModel('moa:…') / 把 moa:* 传给 kscc；不创建 SessionRuntime。
   * 生命周期（result/turn_end/session_error/取消卡）由 runMoaTurn 自管；
   * STOP_AGENT 经 moaAbortBySession 中止，turn_end 由 STOP 处理器统一推。
   *
   * `sticky=false`（one-shot）：**不**改写 `meta.modelId`，会话 tab / ModelSelector 仍显示
   * 真实模型（SPEC §3）。仍写 channelId / workspaceId / turnCount（会话级，与 MoA 无关）。
   */
  private async runMoATurn(
    input: SendMessageInput,
    channel: Channel,
    moaModelId: `moa:${string}`,
    meta: AgentSessionMeta | undefined,
    workspaceId: string | undefined,
    sticky: boolean,
  ): Promise<void> {
    // 1. 按 channel.provider 选 seat runner（kscc bare vs Pi HTTP 直连）+ 必要前置检查。
    //    同场不混核：一轮全程只用一种 runner；凭据在主进程解密，不进预置/圆桌卡。
    let seatRunner: MoASeatRunner;
    if (channel.provider === "kscc-internal") {
      const ksccPath = resolveKsccPath();
      if (!ksccPath) {
        const msg = "未检测到 kscc 命令，请先安装 kscc（内网渠道）";
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: {
            type: "session_error",
            message: msg,
            error: classifyUserFacingError(msg),
          },
        });
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: { type: "turn_end" },
        });
        return;
      }
      seatRunner = createKsccSeatRunner({ ksccPath });
    } else {
      // 外部渠：主进程解密 apiKey（与 pi-adapter 同路）；缺失即报错，不发起会诊。
      const apiKey = getDecryptedApiKey(channel.id);
      if (!apiKey) {
        const msg = `渠道「${channel.name}」未配置 API Key，无法发起外部会诊，请在渠道管理中填写`;
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: {
            type: "session_error",
            message: msg,
            error: classifyUserFacingError(msg),
          },
        });
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: { type: "turn_end" },
        });
        return;
      }
      seatRunner = createPiHttpSeatRunner({
        provider: channel.provider,
        apiKey,
        baseUrl: channel.baseUrl,
      });
    }

    // 2. 调度纯函数：预置解析 + 运行时可用性校验（早失败少占资源）。
    //    预置列表：kscc 用 stored 全量（sticky 路径遇不可用席位仍给精确报错）；
    //    外部渠用 resolveConsultPresetsForChannel（合成 channel-default / channel-same-model，
    //    或命中本渠的 stored）。one-shot 选中的合成预置 id 即在此列表中命中。
    const storedPresets = listMoaPresets();
    const dispatchPresets =
      channel.provider === "kscc-internal"
        ? storedPresets
        : resolveConsultPresetsForChannel(channel, storedPresets);
    const dispatch = resolveMoADispatch(moaModelId, channel, dispatchPresets);
    if (dispatch.kind !== "moa") {
      const msg = dispatch.kind === "error" ? dispatch.message : "会诊调度异常";
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: {
          type: "session_error",
          message: msg,
          error: classifyUserFacingError(msg),
        },
      });
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: { type: "turn_end" },
      });
      return;
    }
    const preset: MoAPreset = dispatch.preset;

    // 记录本轮 meta：
    // - sticky（modelId 已是 moa:…）：modelId 也写回 moaModelId（与历史口径一致）
    // - one-shot（sticky=false）：**不**改 modelId，会话 tab / ModelSelector 仍显示真实模型；
    //   仍写 channelId / workspaceId / turnCount（会话级，与 MoA 无关）。
    // meta patch 由纯函数 `decideMoaMetaPatch` 决定（便于单测「one-shot 不写 sticky moa」）。
    if (!meta) {
      // 草稿会话首条：createSession 时若 sticky 用 moaModelId，否则用真实 modelId（兜底）
      createSession({
        id: input.sessionId,
        title: input.prompt.slice(0, 20) || "新会话",
        channelId: channel.id,
        modelId: sticky
          ? moaModelId
          : input.model && !isMoaModelId(input.model)
            ? input.model
            : (channel.defaultModelId ?? ""),
        workspaceId,
        turnCount: 1,
        executionMode: input.executionMode,
        internalBackend:
          channel.provider === "kscc-internal"
            ? input.internalBackend
            : undefined,
      });
    } else {
      const patch = decideMoaMetaPatch({
        sticky,
        moaModelId,
        channelId: channel.id,
        workspaceId,
        previousTurnCount: meta.turnCount,
      });
      updateSessionMeta(input.sessionId, patch);
    }

    // 起 AbortController + 在途标记，编排
    const controller = new AbortController();
    this.moaAbortBySession.set(input.sessionId, controller);
    this.moaInFlight.add(input.sessionId);
    try {
      await runMoaTurn({
        sessionId: input.sessionId,
        prompt: appendAttachmentPathsToPrompt(input.prompt, input.attachments),
        channel,
        preset,
        workspaceId,
        seatRunner,
        signal: controller.signal,
        sendPayload: (payload) => this.sendPayload(input.sessionId, payload),
        attachments: input.attachments,
      });
    } catch (err) {
      // runMoaTurn 自身不应抛（失败经 sendPayload 上报）；兜底防裸异常吞掉
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[runMoATurn] 未预期异常:", err);
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: {
          type: "session_error",
          message: msg,
          error: classifyUserFacingError(msg),
        },
      });
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: { type: "turn_end" },
      });
    } finally {
      this.moaAbortBySession.delete(input.sessionId);
      this.moaInFlight.delete(input.sessionId);
      try {
        updateSessionMeta(input.sessionId, { status: "idle" });
      } catch {
        /* meta 缺失时忽略 */
      }
    }
  }

  /**
   * 圆桌讨论本条（one-shot）：渲染层点「圆桌讨论 ▾」选预置后单次走 runMoADiscussion
   * （多轮讨论+总结人收口）。**不**改 `meta.modelId`，会话 tab / ModelSelector 仍显示真实模型
   * （与会诊 one-shot 一致，SPEC §3）。
   *
   * 与 {@link #runMoATurn} 同构：seat runner 创建路径（kscc bare / Pi HTTP 直连）、预置解析 +
   * 运行时可用性校验（均经 `resolveMoADispatch(moa:<presetId>, …)`，与会诊 one-shot 同源）、
   * AbortController + 在途标记、try/catch/finally 收尾全部一致；区别仅在编排函数
   * （runMoADiscussion 多轮讨论+收口，runMoaTurn 并行交卷单轮）。
   *
   * STOP_AGENT 经 moaAbortBySession 中止（与 runMoATurn 共用同一 map），runMoADiscussion
   * 检测 signal.aborted 后推 cancelled 卡 + 返回 cancelled outcome（见 run-moa-discussion.ts）。
   * runMoADiscussion 自身经 sendPayload 上报 result / session_error / turn_end，故此处与
   * runMoATurn 调用处一致：await 后不读返回值，仅 catch 兜底裸异常 + finally 清在途/置 idle。
   */
  private async runMoADiscussionTurn(
    input: SendMessageInput,
    channel: Channel,
    discussionPresetId: string,
    meta: AgentSessionMeta | undefined,
    workspaceId: string | undefined,
  ): Promise<void> {
    // 1. 按 channel.provider 选 seat runner（与 runMoATurn 完全相同：同场不混核，凭据主进程解密）。
    let seatRunner: MoASeatRunner;
    if (channel.provider === "kscc-internal") {
      const ksccPath = resolveKsccPath();
      if (!ksccPath) {
        const msg = "未检测到 kscc 命令，请先安装 kscc（内网渠道）";
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: {
            type: "session_error",
            message: msg,
            error: classifyUserFacingError(msg),
          },
        });
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: { type: "turn_end" },
        });
        return;
      }
      seatRunner = createKsccSeatRunner({ ksccPath });
    } else {
      // 外部渠：主进程解密 apiKey（与 pi-adapter / runMoATurn 同路）；缺失即报错，不发起讨论。
      const apiKey = getDecryptedApiKey(channel.id);
      if (!apiKey) {
        const msg = `渠道「${channel.name}」未配置 API Key，无法发起外部圆桌讨论，请在渠道管理中填写`;
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: {
            type: "session_error",
            message: msg,
            error: classifyUserFacingError(msg),
          },
        });
        this.sendPayload(input.sessionId, {
          kind: "tagent_event",
          event: { type: "turn_end" },
        });
        return;
      }
      seatRunner = createPiHttpSeatRunner({
        provider: channel.provider,
        apiKey,
        baseUrl: channel.baseUrl,
      });
    }

    // 2. 预置解析 + 运行时校验（与会诊 one-shot 同源：moa:<presetId> 经 resolveMoADispatch，
    //    跨渠禁席/模型未启用/预置缺失均在此早失败并返回中文文案）。
    const storedPresets = listMoaPresets();
    const dispatchPresets =
      channel.provider === "kscc-internal"
        ? storedPresets
        : resolveConsultPresetsForChannel(channel, storedPresets);
    const dispatch = resolveMoADispatch(
      moaModelId(discussionPresetId),
      channel,
      dispatchPresets,
    );
    if (dispatch.kind !== "moa") {
      const msg =
        dispatch.kind === "error" ? dispatch.message : "圆桌讨论调度异常";
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: {
          type: "session_error",
          message: msg,
          error: classifyUserFacingError(msg),
        },
      });
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: { type: "turn_end" },
      });
      return;
    }
    const preset: MoAPreset = dispatch.preset;

    // 3. 记录本轮 meta（one-shot：不改 modelId，与会诊 one-shot 一致）。
    //    仍写 channelId / workspaceId / turnCount（会话级，与 MoA 无关）。
    if (!meta) {
      // 草稿会话首条：用真实 modelId 建会话（不以 moa: 开头，与 runMoATurn one-shot 兜底一致）
      createSession({
        id: input.sessionId,
        title: input.prompt.slice(0, 20) || "新会话",
        channelId: channel.id,
        modelId:
          input.model && !isMoaModelId(input.model)
            ? input.model
            : (channel.defaultModelId ?? ""),
        workspaceId,
        turnCount: 1,
        executionMode: input.executionMode,
        internalBackend:
          channel.provider === "kscc-internal"
            ? input.internalBackend
            : undefined,
      });
    } else {
      const patch = decideMoaMetaPatch({
        sticky: false,
        moaModelId: moaModelId(discussionPresetId),
        channelId: channel.id,
        workspaceId,
        previousTurnCount: meta.turnCount,
      });
      updateSessionMeta(input.sessionId, patch);
    }

    // 4. 起 AbortController + 在途标记，编排（照 runMoATurn 调用处收尾）。
    const controller = new AbortController();
    this.moaAbortBySession.set(input.sessionId, controller);
    this.moaInFlight.add(input.sessionId);
    // 4.5 预生成 discussionId 并注册活跃讨论：discussion-interject IPC push pending、discussion-stop
    //     IPC abort 复用此 controller；ctx.interjections.drain 供 runMoADiscussion 每轮排空插话注入。
    //    （同会话同时仅一场讨论，moaInFlight 单标记；discussionId 仅作匹配校验防串台/过期请求。）
    const discussionId = nextMoADiscussionId(input.sessionId);
    const discussionRec = {
      discussionId,
      pending: [] as string[],
      abortController: controller,
    };
    this.moaDiscussionsBySession.set(input.sessionId, discussionRec);
    try {
      await runMoADiscussion({
        sessionId: input.sessionId,
        prompt: appendAttachmentPathsToPrompt(input.prompt, input.attachments),
        channel,
        preset,
        workspaceId,
        seatRunner,
        signal: controller.signal,
        sendPayload: (payload) => this.sendPayload(input.sessionId, payload),
        attachments: input.attachments,
        discussionId,
        interjections: { drain: () => discussionRec.pending.splice(0) },
      });
    } catch (err) {
      // runMoADiscussion 自身不应抛（失败经 sendPayload 上报）；兜底防裸异常吞掉
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[runMoADiscussion] 未预期异常:", err);
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: {
          type: "session_error",
          message: msg,
          error: classifyUserFacingError(msg),
        },
      });
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: { type: "turn_end" },
      });
    } finally {
      this.moaAbortBySession.delete(input.sessionId);
      this.moaInFlight.delete(input.sessionId);
      this.moaDiscussionsBySession.delete(input.sessionId);
      try {
        updateSessionMeta(input.sessionId, { status: "idle" });
      } catch {
        /* meta 缺失时忽略 */
      }
    }
  }

  /** 解析模型 ID：input > 渠道默认 > 第一个启用模型 > kscc 兜底 */
  private resolveModel(channel: Channel, inputModel?: string): string {
    const modelId =
      inputModel ??
      channel.defaultModelId ??
      channel.models.find((model) => model.enabled)?.id ??
      (channel.provider === "kscc-internal" ? KSCC_DEFAULT_MODEL_ID : "");
    const configured = channel.models.find((model) => model.id === modelId);
    if (!configured) {
      throw new Error(`模型「${modelId}」不属于渠道「${channel.name}」`);
    }
    if (!configured.enabled) {
      throw new Error(
        `模型「${configured.name}」已停用，请选择同一运行区域内的可用模型`,
      );
    }
    return modelId;
  }

  /** 构建 query 选项（按渠道 provider 选核） */
  private async buildQueryOptions(
    input: SendMessageInput,
    channel: Channel,
    workspaceId?: string,
    buildOpts?: { suppressResume?: boolean },
  ): Promise<Parameters<AgentProviderAdapter["query"]>[0]> {
    const model = this.resolveModel(channel, input.model);
    const contextPromptAppend = input.contextPrompt?.trim()
      ? [
          "## 前情提要（主会话参考信息，不是当前用户指令）",
          input.contextPrompt.trim(),
          "以上内容仅用于理解背景；请始终以当前用户消息为本轮任务。",
        ].join("nn")
      : "";

    // 解析 workspace：始终按 session meta 反查（权限 cwd 必须用项目目录，不能靠 process.cwd()）
    const workspace = resolveWorkspaceForSession(input.sessionId);
    const cwd = workspace?.projectDirectory ?? process.cwd();
    const sanitizedPath = workspace?.slug ?? "";
    void workspaceId; // 调用方仍传 workspaceId 用于落盘路径；cwd 以 session meta 为准

    // 权限模式：会话 meta 持久化（默认 bypassPermissions）
    const metaForMode = getSessionMeta(input.sessionId);
    const permissionMode: TAgentPermissionMode = metaForMode?.permissionMode
      ? migratePermissionMode(metaForMode.permissionMode)
      : TAGENT_DEFAULT_PERMISSION_MODE;

    // 无进展守卫（§20.1 / §23.1）：env > 落盘偏好 > 默认 enforce。
    // per-send 解析便于运行时改偏好后下次发送即生效。
    const noProgressGuardMode = resolveNoProgressGuardMode(
      process.env,
      readNoProgressGuardModePref(),
    );
    // 守卫阶段事件 → IPC 推 renderer（§20.4）。shadow 事件带 shadow=true，UI 忽略。
    const onNoProgressEvent = (event: NoProgressEvent): void => {
      // NoProgressEvent 结构上满足 tagent_event 的松散信封（{ type: string; [key: string]: unknown }），
      // 仅缺索引签名声明；TS 不接受单层 as，经 unknown 中转对齐信封，不改运行时对象。
      this.sendPayload(input.sessionId, {
        kind: "tagent_event",
        event: event as unknown as { type: string; [key: string]: unknown },
      });
    };

    // 无进展暂停 → AskUserQuestion 结构化澄清（brief 2026-08-19 §3）。
    // 适配层在进入 paused_no_progress 时把 buildNoProgressAskUserInput 产出的工具输入推这里，
    // 注入 askUserService.handleAskUserQuestion 复用现有 AskUserQuestion 事件 / UI。
    // 用户回答 → handleSend 续跑（方向即用户选择）；dismiss → 保持暂停；新 turn abort 旧请求。
    const onNoProgressPauseAskUser = (
      askInput: Record<string, unknown>,
    ): void => {
      // 先 abort 上一条未答的 no-progress AskUser（防御性，同轮不应有两条）
      this.noProgressAskUserAbortBySession.get(input.sessionId)?.abort();
      const ac = new AbortController();
      this.noProgressAskUserAbortBySession.set(input.sessionId, ac);
      void askUserService
        .handleAskUserQuestion(
          input.sessionId,
          askInput,
          ac.signal,
          (request) => {
            this.getWindow()?.webContents.send(
              AGENT_IPC_CHANNELS.ASK_USER_REQUEST,
              request,
            );
          },
        )
        .then((result) => {
          this.noProgressAskUserAbortBySession.delete(input.sessionId);
          if (result.behavior !== "allow") return; // dismiss → 保持暂停，不自动继续
          // 用户已选择方向 → 续跑（复用 handleSend，不改暂停 / 恢复总体语义）
          const answers = (result.updatedInput.answers ?? {}) as Record<
            string,
            string
          >;
          const answerText = Object.values(answers).filter(Boolean).join("；");
          const meta = getSessionMeta(input.sessionId);
          if (!meta?.channelId) return;
          void this.handleSend({
            sessionId: input.sessionId,
            prompt: `[无进展澄清] 用户选择：${answerText || "继续当前方向"}`,
            channelId: meta.channelId,
            model: meta.modelId,
            workspaceId: meta.workspaceId,
            isSteer: true,
            skipUserPersist: true,
          }).catch((err) => {
            console.warn(`[session-service] 无进展 AskUser 续跑失败:`, err);
          });
        })
        .catch(() => {
          this.noProgressAskUserAbortBySession.delete(input.sessionId);
        });
    };

    // 工作区 MCP 配置（无 workspace → 空，pi-core buildMcpTools 自动跳过）
    const enabledMcpServers = sanitizedPath
      ? getEnabledMcpServers(sanitizedPath)
      : {};
    const mcpConfig = { servers: enabledMcpServers };

    if (
      channel.provider === "kscc-internal" &&
      resolveInternalAdapterKind(metaForMode) === "codex"
    ) {
      const executionMode = this.getExecutionMode(input.sessionId);
      const reasoningEffort = migrateReasoningEffort(
        metaForMode?.reasoningEffort,
      );
      const readOnly =
        executionMode === "chat" || permissionMode === "plan";
      const fullyAutomatic =
        executionMode === "work" &&
        permissionMode === "bypassPermissions";
      const sandbox = readOnly
        ? ("read-only" as const)
        : fullyAutomatic
          ? ("danger-full-access" as const)
          : ("workspace-write" as const);
      const approvalPolicy = fullyAutomatic
        ? ("never" as const)
        : readOnly
          ? ("never" as const)
          : ("on-request" as const);
      const permissionHandler = this.permissionService?.createCanUseTool(
        input.sessionId,
        () => this.getPermissionMode(input.sessionId),
        cwd,
        () => this.getExecutionMode(input.sessionId),
      );
      const codexMcpProjection =
        buildCodexMcpThreadConfig(enabledMcpServers);
      for (const skipped of codexMcpProjection.skipped) {
        console.warn(
          `[codex MCP] 已跳过 ${skipped.name}: ${skipped.reason}`,
        );
      }
      const codexBrowserTools = buildPiBrowserTools({
        sessionId: input.sessionId,
      });
      const codexKbTools = buildPiKbTools({
        sessionId: input.sessionId,
        knowledgeBaseWritesEnabled: areKnowledgeBaseWritesEnabled(),
        sendToRenderer: (request) => {
          this.getWindow()?.webContents.send(
            AGENT_IPC_CHANNELS.KB_PROPOSE_SAVE_REQUEST,
            request,
          );
        },
      });
      const codexKanbanTools = buildPiKanbanTools({
        sessionId: input.sessionId,
        channelId: channel.id,
        agentCwd: cwd,
        workspaceId: workspace?.slug,
        toolMode: "full",
      });
      const dynamicToolRegistry = new CodexDynamicToolRegistry(
        [...codexBrowserTools, ...codexKbTools, ...codexKanbanTools].map(
          (tool) => ({
            tool,
            permission: resolveCodexDynamicToolPermission(tool.name),
          }),
        ),
      );
      const onServerRequest = async (
        request: CodexAppServerIncomingRequest,
      ): Promise<unknown> => {
        const params =
          request.params &&
          typeof request.params === "object" &&
          !Array.isArray(request.params)
            ? (request.params as Record<string, unknown>)
            : {};
        if (request.method === "item/tool/requestUserInput") {
          const requestUserInput = parseCodexRequestUserInputParams(params);
          if (!requestUserInput) {
            throw new Error("Codex requestUserInput 参数无效");
          }
          if (!requestUserInput.isBlocking) {
            return { answers: {} };
          }
          const result = await askUserService.handleAskUserQuestion(
            input.sessionId,
            buildCodexAskUserInput(requestUserInput),
            new AbortController().signal,
            (askUserRequest) => {
              this.getWindow()?.webContents.send(
                AGENT_IPC_CHANNELS.ASK_USER_REQUEST,
                askUserRequest,
              );
            },
          );
          return buildCodexRequestUserInputResponse(
            requestUserInput,
            result.behavior === "allow"
              ? result.updatedInput.answers
              : undefined,
          );
        }
        if (request.method === "item/permissions/requestApproval") {
          const permissionRequest =
            parseCodexPermissionsRequestApprovalParams(params);
          if (!permissionRequest) {
            throw new Error("Codex permissions requestApproval 参数无效");
          }
          if (!this.permissionService) {
            throw new Error("TAgent 权限服务尚未初始化");
          }
          const summary =
            summarizeCodexPermissionRequest(permissionRequest);
          const decision =
            await this.permissionService.requestAdditionalPermissions({
              sessionId: input.sessionId,
              getMode: () => this.getPermissionMode(input.sessionId),
              getExecutionMode: () =>
                this.getExecutionMode(input.sessionId),
              input: summary.input,
              hasNetwork: summary.hasNetwork,
              hasFileRead: summary.hasFileRead,
              hasFileWrite: summary.hasFileWrite,
            });
          return buildCodexPermissionsRequestApprovalResponse(
            permissionRequest,
            decision.allow,
          );
        }
        if (request.method === "item/tool/call") {
          return dispatchCodexDynamicToolCall({
            registry: dynamicToolRegistry,
            params,
            executionMode: this.getExecutionMode(input.sessionId),
            permissionMode: this.getPermissionMode(input.sessionId),
            requestPermission: permissionHandler,
          });
        }
        if (!permissionHandler) {
          throw new Error("TAgent 权限服务尚未初始化");
        }
        if (request.method === "item/commandExecution/requestApproval") {
          const command =
            typeof params.command === "string" ? params.command : "";
          const decision = await permissionHandler("Bash", {
            command,
            ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
          });
          return {
            decision:
              decision.behavior === "allow" ? "accept" : "decline",
          };
        }
        if (request.method === "item/fileChange/requestApproval") {
          const decision = await permissionHandler("ApplyPatch", {
            ...(typeof params.reason === "string"
              ? { reason: params.reason }
              : {}),
            ...(typeof params.grantRoot === "string"
              ? { grantRoot: params.grantRoot }
              : {}),
          });
          return {
            decision:
              decision.behavior === "allow" ? "accept" : "decline",
          };
        }
        throw new Error(`Codex 服务端请求尚未接入：${request.method}`);
      };
      const developerInstructions = [
        buildExecutionModePrompt(executionMode),
        contextPromptAppend,
        executionMode === "chat" ? buildUserSystemPromptAppend() : "",
        BROWSER_SYSTEM_PROMPT,
        "## 身份与自我介绍\n你是 TAgent 的 Codex 主会话执行后端。不要提及 CLI、App Server 或出品方品牌；直接完成用户任务。",
        buildOutputStylePrompt(),
        executionMode === "work"
          ? "## 看板派工工具\nWork 模式可用：kanban_create_board、kanban_add_task、kanban_list_boards、kanban_list_tasks、kanban_complete、kanban_block。长任务应拆成可验收的看板任务并指定 roleId；调度器会派发执行。"
          : "",
        this.buildMentionPromptAppend(input.sessionId, executionMode),
        buildBotSessionPromptAppend(
          metaForMode?.botProfileIds,
          input.prompt,
          metaForMode?.fusionCoordinatorBotProfileId,
        ),
        buildRichContentSystemPrompt(),
        buildKbPromptAppend({
          kbRoots: resolveKnowledgeBaseRootsForSession(metaForMode ?? {}),
          knowledgeBaseIds: metaForMode?.knowledgeBaseIds,
          mode: metaForMode?.knowledgeBaseMode,
          knowledgeBaseWritesEnabled: areKnowledgeBaseWritesEnabled(),
          available: resolveAvailableKnowledgeBases(input.sessionId)
            .available,
        }),
        readOnly
          ? "当前会话为只读边界：可以分析、检索和运行只读检查，不得修改文件。"
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const codexModel = process.env.TAGENT_CODEX_MODEL?.trim() || undefined;
      const opts: CodexQueryOptions = {
        sessionId: input.sessionId,
        prompt: input.prompt,
        attachments: input.attachments,
        cwd,
        executionMode,
        ...(codexModel ? { model: codexModel } : {}),
        effort: reasoningEffort,
        approvalPolicy,
        sandbox,
        config: codexMcpProjection.config,
        developerInstructions,
        dynamicTools: dynamicToolRegistry.specs,
        resumeThreadId: buildOpts?.suppressResume
          ? undefined
          : metaForMode?.codexThreadId,
        onThreadId: (threadId: string) => {
          opts.resumeThreadId = threadId;
          if (
            threadId &&
            threadId !== getSessionMeta(input.sessionId)?.codexThreadId
          ) {
            updateSessionMeta(input.sessionId, {
              codexThreadId: threadId,
              internalBackend: "codex-app-server",
            });
            console.log(
              `[会话 ${input.sessionId}] 已保存 codexThreadId: ${threadId}`,
            );
          }
        },
        onServerRequest,
        onStderr: (data: string) => {
          console.error(`[codex stderr] ${data}`);
          this.runtimes.get(input.sessionId)?.reportStderr(data);
        },
      };
      return opts as unknown as Parameters<AgentProviderAdapter["query"]>[0];
    }

    if (channel.provider === "kscc-internal") {
      const ksccPath = resolveKsccPath();
      if (!ksccPath) {
        throw new Error("未检测到 kscc 命令，请先安装 kscc（内网渠道）");
      }
      const meta = getSessionMeta(input.sessionId);
      const knowledgeBaseIds = Array.isArray(meta?.knowledgeBaseIds)
        ? meta.knowledgeBaseIds.filter(
            (id): id is string => typeof id === "string" && Boolean(id.trim()),
          )
        : [];
      const knowledgeBaseRoots = resolveKnowledgeBaseRootsForSession(meta ?? {});
      const knowledgeBaseMode =
        meta?.knowledgeBaseMode === "preferred" ||
        meta?.knowledgeBaseMode === "strict"
          ? meta.knowledgeBaseMode
          : "off";
      // 子代理委派积极性：读会话 meta（持久化，默认 conservative），注入 kscc systemPrompt append。
      // 每次发送都重新读取，UI 改完下次发送即生效（kscc 长驻进程 system prompt 在 spawn 时定稿，
      // 切换积极性需重建进程才完全生效；非首次发送走 resume，沿用上一次注入的策略）。
      const eagerness = migrateSubagentEagerness(meta?.subagentEagerness);
      const botSessionPrompt = buildBotSessionPromptAppend(
        meta?.botProfileIds,
        input.prompt,
        meta?.fusionCoordinatorBotProfileId,
      );
      // 思考强度：读会话 meta（持久化，默认 medium），映射到 Claude Agent SDK effort。
      // 每次发送都重新读取；kscc 长驻进程 effort 在 spawn 时定稿，切换需重建进程才完全生效
      // （非首次发送走 resume，沿用上一次注入的 effort）。
      const reasoningEffort = migrateReasoningEffort(meta?.reasoningEffort);
      // Phase 2.2：记忆管理规则 + Frozen 记忆快照（createSession/spawn 时注入，会话内不刷新）
      const sessionMode: MemoryMode = meta?.mode === "ta" ? "ta" : "general";
      const snap = memoryLayerService.readMemorySnapshot(sessionMode, meta?.workspaceId ?? undefined);
      const mem = buildMemoryPromptSections({
        mode: sessionMode,
        memorySnapshot: {
          l0: snap.l0User,
          l1: snap.l1Project,
          l2: snap.l2Facts,
        },
      });
      // KSCC 是长驻 SDK 会话，无法复用 Pi 的 transformContext；因此按每轮 prompt
      // 直接附加受控 L4 检索上下文。当前会话自身被排除，避免摘要回灌。
      let recallContext = "";
      try {
        recallContext = buildMemoryRecallContext(
          input.prompt,
          memoryLayerService.searchSessions(sessionMode, input.prompt, 5, meta?.workspaceId ?? undefined),
          input.sessionId,
          { mode: sessionMode, workspaceSlug: meta?.workspaceId ?? undefined },
        );
      } catch (err) {
        console.warn("[memory] kscc recall failed:", err);
      }
      // KsccQueryOptions：canUseTool/mcpServers/permissionMode/allowDangerouslySkipPermissions
      // canUseTool 透传 PermissionService.createCanUseTool（permissionMode + executionMode 闭包读 meta）
      const canUseTool = this.permissionService
        ? this.permissionService.createCanUseTool(
            input.sessionId,
            () => this.getPermissionMode(input.sessionId),
            cwd,
            () => this.getExecutionMode(input.sessionId),
          )
        : undefined;
      const executionMode = this.getExecutionMode(input.sessionId);
      const autoPlanPrompt =
        buildAutoKanbanPrompt(input.prompt, executionMode, input.isSteer) ||
        buildAutoPlanPrompt(input.prompt, executionMode, input.isSteer);
      // Work：注入看板 MCP（create/add/list）；Chat 不注入
      const mcpServers: Record<string, unknown> = {
        ...(Object.keys(enabledMcpServers).length > 0
          ? (enabledMcpServers as Record<string, unknown>)
          : {}),
      };
      try {
        await injectBrowserMcpServer(mcpServers, {
          sessionId: input.sessionId,
        });
      } catch (err) {
        console.warn("[会话] 注入浏览器 MCP 失败:", err);
      }
      try {
        await injectKbMcpServer(mcpServers, {
          sessionId: input.sessionId,
          knowledgeBaseWritesEnabled: areKnowledgeBaseWritesEnabled(),
          sendToRenderer: (request) => {
            this.getWindow()?.webContents.send(
              AGENT_IPC_CHANNELS.KB_PROPOSE_SAVE_REQUEST,
              request,
            );
          },
        });
      } catch (err) {
        console.warn("[会话] 注入知识库 MCP 失败:", err);
      }
      if (executionMode === "work") {
        try {
          await injectKanbanMcpServer(mcpServers, {
            sessionId: input.sessionId,
            channelId: channel.id,
            agentCwd: cwd,
            workspaceId: workspace?.slug,
            toolMode: "full",
          });
        } catch (err) {
          console.warn("[会话] 注入看板 MCP 失败:", err);
        }
      }
      const opts: KsccQueryOptions = {
        sessionId: input.sessionId,
        prompt: recallContext
          ? `${recallContext}nn---nn${input.prompt}`
          : input.prompt,
        attachments: input.attachments,
        model,
        cwd,
        executionMode,
        sdkCliPath: ksccPath,
        env: { ...process.env } as Record<string, string | undefined>,
        maxTurns: 50,
        // 思考强度 → SDK effort（low/medium/high/max），ClaudeAgentAdapter.buildSdkOptions 注入
        reasoningEffort,
        // 接上 resolveSdkPermissionModeForTAgent：auto/bypassPermissions → 'default'，
        // 让 SDK 把每次工具调用都交给 TAgent canUseTool 审批，而非叠 SDK 自己的权限闸
        // （之前硬编码 'bypassPermissions' + allowDangerouslySkipPermissions:false 的组合，
        //   SDK 会拒绝「危险跳过」并启用内置审批，导致 cwd 内读操作也弹权限确认）。
        sdkPermissionMode: resolveSdkPermissionModeForTAgent(permissionMode),
        // 有 canUseTool 时交给我们的服务全权审批；无 canUseTool（无 PermissionService）时才让 SDK 自行跳过
        allowDangerouslySkipPermissions: !canUseTool,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          // 执行形态 +（Work 才）子代理委派 + 看板工具说明 + 富内容 + 记忆
          // Chat 下 Task/SubAgent/看板写 硬拦，不注入委派/看板工具
          append: [
            // Chat/Work 策略须尽早出现，压过 claude_code preset 的动手/Plan 默认习惯
            buildExecutionModePrompt(executionMode),
            autoPlanPrompt,
            contextPromptAppend,
            // Chat：注入设置页默认系统提示词（内置或用户自定义）
            executionMode === "chat" ? buildUserSystemPromptAppend() : "",
            BROWSER_SYSTEM_PROMPT,
            "## 身份与自我介绍n你是一个专业的编程助手，帮助用户完成软件开发任务。回复时不要自我介绍，也不要提及你所属的 CLI 工具名或出品方品牌；直接以助手姿态回答用户的问题。",
            // W8：输出风格沟通红线（与 Pi 核 buildOutputStylePrompt 同文）
            buildOutputStylePrompt(),
            executionMode === "work"
              ? buildSubagentDelegationPrompt(eagerness)
              : "",
            executionMode === "work"
              ? "## 看板派工工具nWork 模式可用：kanban_create_board、kanban_add_task、kanban_list_boards、kanban_list_tasks。长任务拆成看板任务并指定 roleId；调度器会派 headless 工人。"
              : "",
            this.buildMentionPromptAppend(input.sessionId, executionMode),
            botSessionPrompt,
            buildRichContentSystemPrompt(),
            buildKbPromptAppend({
              kbRoots: resolveKnowledgeBaseRootsForSession(meta ?? {}),
              knowledgeBaseIds: meta?.knowledgeBaseIds,
              mode: meta?.knowledgeBaseMode,
              knowledgeBaseWritesEnabled: areKnowledgeBaseWritesEnabled(),
              // 刀 3：未挂库时注入「可发现」库名（仅元数据），供口头轻问；已挂库时 helper 返回空。
              available: resolveAvailableKnowledgeBases(input.sessionId)
                .available,
            }),
            mem.managementRules,
            mem.memorySnapshotSection,
          ]
            .filter(Boolean)
            .join("nn"),
        },
        persistSession: true,
        // 无进展守卫（KSCC：PostToolBatch 注入 / PreToolUse 拦截 / interrupt 暂停）
        noProgressGuardMode,
        onNoProgressEvent,
        onNoProgressPauseAskUser,
        onPostToolBatch: (hookInput: PostToolBatchHookInputLike) => {
          const decision = assessWebSearchFallback(hookInput.tool_calls);
          return decision ? buildBrowserFallbackContext(decision) : undefined;
        },
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        knowledgeBaseToolGate: createKnowledgeBaseToolGate({
          bound: knowledgeBaseIds.length > 0 || knowledgeBaseRoots.length > 0,
          mode: knowledgeBaseMode,
        }),
        // 子代理定义：仅 Work 注册（Chat 硬拦 Task，注册无意义）。
        // claudeAvailable 按渠道判定（isClaudeAvailableForChannel）：非 Anthropic 系（kscc-internal 等）
        // → false → 操作型角色不带 model → SDK 继承父会话模型（glm 等），避免钉 haiku 打到无 Claude
        // 的网关而子代理首轮 LLM 调用即失败。仅 Anthropic 系渠道才钉 haiku。见 SUBAGENT-FAIL-FINDINGS 根因 1。
        agents:
          executionMode === "work"
            ? buildBuiltinSubagentDefinitions(
                isClaudeAvailableForChannel(channel),
              )
            : undefined,
        // 权限钩子（bypass 模式不挂）
        ...(canUseTool ? { canUseTool } : {}),
        // 长驻首次 spawn 带 resume 续历史（SDK 读 JSONL 一次），之后靠内存。
        // T7 RESTART 注入：面板含 MoA 时 suppressResume=true → 不 resume（避免 resume 普通轮 +
        // 注入全量面板历史的双上下文），改由注入的 panel 历史单真源补全（含圆桌轮）。
        resumeSessionId: buildOpts?.suppressResume
          ? undefined
          : meta?.sdkSessionId,
        onSessionId: (sdkSessionId: string) => {
          if (sdkSessionId && sdkSessionId !== meta?.sdkSessionId) {
            updateSessionMeta(input.sessionId, { sdkSessionId });
            console.log(
              `[会话 ${input.sessionId}] 已保存 sdkSessionId: ${sdkSessionId}`,
            );
          }
        },
        onStderr: (data: string) => {
          console.error(`[kscc stderr] ${data}`);
          // 喂给 runtime：累积 stderr 供过长上下文识别（见 session-runtime.runLoop）
          this.runtimes.get(input.sessionId)?.reportStderr(data);
        },
      };
      return opts as unknown as Parameters<AgentProviderAdapter["query"]>[0];
    }

    // 外部渠道：Pi 核，构造 PiQueryOptions
    // PiAgentAdapter.query() 解构 channelConfig（嵌套对象），不是扁平字段。
    // 对应 PiExternalChannelConfig：type/provider/apiKey/baseUrl/modelId/thinking*
    // 注：subagentEagerness 当前仅注入 kscc 核。Pi 核的 systemPrompt 是「整体替换」
    // （systemPrompt ?? DEFAULT_SYSTEM_PROMPT）而非 append，且 DEFAULT_SYSTEM_PROMPT 未导出，
    // 直接注入委派策略会覆盖默认 system prompt，故暂不接；如需支持需先给 Pi 核加 append 点。
    const apiKey = getDecryptedApiKey(channel.id);
    if (!apiKey) {
      // apiKey 解密失败（Windows DPAPI 跨实例不可互通）或未设置 → 早点报错，别让空 key 打到 HTTP
      throw new Error(
        `渠道「${channel.name}」的 apiKey 未设置或解密失败，请在「渠道管理」中重新输入 apiKey`,
      );
    }
    // beforeToolCall：pi-agent-core 签名，包 PermissionService.createBeforeToolCall
    const beforeToolCall = this.permissionService
      ? this.permissionService.createBeforeToolCall(
          input.sessionId,
          () => this.getPermissionMode(input.sessionId),
          cwd,
          () => this.getExecutionMode(input.sessionId),
        )
      : undefined;
    const piMeta = getSessionMeta(input.sessionId);
    // Pi 核思考强度：reasoningEffort → thinkingLevel（thinkingEnabled=false 时为 no-op，不回归既有行为）。
    // 仅当渠道后续开启 thinking 时该档位才生效；当前默认关闭，思考强度实际生效在 kscc/ClaudeAgentAdapter。
    const piReasoningEffort = migrateReasoningEffort(piMeta?.reasoningEffort);
    // Pi 核 systemPrompt 为整体替换：注入执行形态段落（避免仅靠工具层无文案）
    const piExecutionMode = this.getExecutionMode(input.sessionId);
    const autoPlanPrompt = buildAutoPlanPrompt(
      input.prompt,
      piExecutionMode,
      input.isSteer,
    );
    const piExecutionPrompt = [
      buildExecutionModePrompt(piExecutionMode),
      autoPlanPrompt,
      contextPromptAppend,
      piExecutionMode === "chat" ? buildUserSystemPromptAppend() : "",
      BROWSER_SYSTEM_PROMPT,
      piExecutionMode === "work"
        ? "## 看板派工工具n可用 kanban_create_board / kanban_add_task / kanban_list_*。长任务拆任务并指定 roleId。"
        : "",
      this.buildMentionPromptAppend(input.sessionId, piExecutionMode),
      buildKbPromptAppend({
        kbRoots: resolveKnowledgeBaseRootsForSession(piMeta ?? {}),
        knowledgeBaseIds: piMeta?.knowledgeBaseIds,
        mode: piMeta?.knowledgeBaseMode,
        knowledgeBaseWritesEnabled: areKnowledgeBaseWritesEnabled(),
        // 刀 3：未挂库时注入「可发现」库名（仅元数据），供口头轻问；已挂库时 helper 返回空。
        available: resolveAvailableKnowledgeBases(input.sessionId).available,
      }),
      buildBotSessionPromptAppend(
        piMeta?.botProfileIds,
        input.prompt,
        piMeta?.fusionCoordinatorBotProfileId,
      ),
    ]
      .filter(Boolean)
      .join("nn");
    const kanbanExtra =
      piExecutionMode === "work"
        ? buildPiKanbanTools({
            sessionId: input.sessionId,
            channelId: channel.id,
            agentCwd: cwd,
            workspaceId: workspace?.slug,
            toolMode: "full",
          })
        : [];
    const browserExtra = buildPiBrowserTools({ sessionId: input.sessionId });
    const kbExtra = buildPiKbTools({
      sessionId: input.sessionId,
      knowledgeBaseWritesEnabled: areKnowledgeBaseWritesEnabled(),
      sendToRenderer: (request) => {
        this.getWindow()?.webContents.send(
          AGENT_IPC_CHANNELS.KB_PROPOSE_SAVE_REQUEST,
          request,
        );
      },
    });
    const extraTools = [...browserExtra, ...kanbanExtra, ...kbExtra];
    const opts = {
      sessionId: input.sessionId,
      prompt: input.prompt,
      attachments: input.attachments,
      model,
      cwd,
      executionMode: piExecutionMode,
      // MCP 配置（无 server 时 pi-core 跳过）
      mcpConfig,
      // 权限钩子（含 Chat 硬拦；始终挂上以便 Chat 下 bypass 也无法写）
      ...(beforeToolCall ? { beforeToolCall } : {}),
      // 执行形态 + Work 看板说明
      systemPromptAppend: piExecutionPrompt,
      // 无进展守卫（Pi：afterToolCall observe / beforeToolCall 拦截 / abort 暂停）
      noProgressGuardMode,
      onNoProgressEvent,
      onNoProgressPauseAskUser,
      // Work：看板 AgentTool
      ...(extraTools.length > 0 ? { extraTools } : {}),
      // Phase 2.2：记忆模式透传（Frozen 快照 / L-rag）
      sessionMode: (piMeta?.mode === "ta" ? "ta" : "general") as MemoryMode,
      // Pi 核专属：渠道凭证 + provider，pi-ai streamFn 用
      channelConfig: {
        type: "external" as const,
        provider: channel.provider,
        apiKey,
        baseUrl: channel.baseUrl,
        modelId: model,
        // thinking 控制：默认关闭，后续可加 UI toggle
        thinkingEnabled: false,
        thinkingLevel: reasoningEffortToPiThinkingLevel(piReasoningEffort) as
          "minimal" | "low" | "medium" | "high",
        // Phase 1.1：注入真实 contextWindow（替代 buildPlaceholderModel 旧的 128k 硬编码）
        contextWindow: resolveModelContextWindow(channel, model),
      },
    };
    void permissionMode;
    return opts as unknown as Parameters<AgentProviderAdapter["query"]>[0];
  }

  /** 读会话当前权限模式（permissionMode getter，供 PermissionService 闭包调用，实现运行中切换） */
  private getPermissionMode(sessionId: string): TAgentPermissionMode {
    const meta = getSessionMeta(sessionId);
    return meta?.permissionMode
      ? migratePermissionMode(meta.permissionMode)
      : TAGENT_DEFAULT_PERMISSION_MODE;
  }

  /**
   * 主进程侧切换会话权限模式（EnterPlanMode 进入 / ExitPlanMode 审批后由 permission-service
   * 经 permissionModeSwitcher 回调）。与 pill 手动切换（UPDATE_SESSION_PERMISSION_MODE）同路径：
   * persist meta + 通知 runtime setPermissionMode；额外推 PLAN_MODE_CHANGED 让渲染层更新输入框 pill
   * （主进程发起的切换，渲染层 pill 不会自更；pill 手动切换不推，避免回环）。
   */
  private async applyPermissionModeChange(
    sessionId: string,
    mode: TAgentPermissionMode,
  ): Promise<void> {
    const normalized = migratePermissionMode(mode);
    try {
      updateSessionMeta(sessionId, { permissionMode: normalized });
    } catch (err) {
      console.warn(
        `[session-service] applyPermissionModeChange persist 失败:`,
        err,
      );
    }
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      try {
        await rt.setPermissionMode(normalized);
      } catch (err) {
        console.error(
          `[会话 ${sessionId}] applyPermissionModeChange setPermissionMode 失败:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.getWindow()?.webContents.send(AGENT_IPC_CHANNELS.PLAN_MODE_CHANGED, {
      sessionId,
      mode: normalized,
      source: "tool",
    });
  }

  /** 读会话 executionMode（Chat|Work）；缺省按新会话默认 work（与 DEFAULT_EXECUTION_MODE 一致） */
  private getExecutionMode(sessionId: string): ExecutionMode {
    const meta = getSessionMeta(sessionId);
    return migrateExecutionMode(
      meta?.executionMode,
      // 有 meta 但缺字段 → 旧会话回退 work；无 meta → 新会话默认 work
      meta ? LEGACY_EXECUTION_MODE : DEFAULT_EXECUTION_MODE,
    );
  }

  /**
   * Chat @ 提及：把点名角色投影进 system prompt（顺序发言）。
   * Work 下默认不注入（避免乱 @ 与派工打架）。
   */
  private buildMentionPromptAppend(
    sessionId: string,
    executionMode: ExecutionMode,
  ): string {
    if (executionMode !== "chat") return "";
    const meta = getSessionMeta(sessionId);
    const ids = meta?.pendingMentionRoleIds;
    if (!ids || ids.length === 0) return "";
    try {
      const blocks: string[] = [
        "## Chat @ 点名发言",
        "用户本轮用 @ 点名了下列岗位。请**按列表顺序**以各岗位视角依次回复（可分段标明角色名）。",
        "规则：不创建看板、不写本地文件、不委派 SubAgent；只做讨论与方案。",
        "",
      ];
      for (const roleId of ids) {
        const role = resolveRole(roleId);
        blocks.push(
          composeRoleSystemPrompt(role, {
            purpose: "mention-turn",
            maxRolePromptChars: 2400,
            runtimeConstraints:
              "本段仅讨论；禁止声称已改代码或已派工。用中文。",
          }),
        );
        blocks.push("");
      }
      return blocks.join("n");
    } catch (err) {
      console.warn("[会话] buildMentionPromptAppend 失败:", err);
      return "";
    }
  }

  /** kscc 路径：转译 SDKMessage → IR，发 TAgentDesktopStreamPayload 给 renderer，并双写 JSONL。
   *  单真源流式落盘（REGRESS-G）：走「同 uuid 去重 + 内容放行」闸口（stream-persist-gate.ts）——
   *  assistant 暂存为 pending，等下一条不同 uuid（或轮结束 flush）再提交；同 uuid 后到快照只留最新（= final），
   *  避免流式中间快照堆积（不回退 E/S1）；显式 `_partial:true` 与空 content 不落盘。
   *  替原「按 IR `_partial` 一刀切跳过」——glm 每 content 块为独立 uuid 且 `stop_reason` 始终 null，旧规则全标 `_partial` 全跳过 → 段间短文/工具/思考落盘全丢。
   *  落盘后的阶段摘要会按 uuid 回传给 renderer 做同源校准，避免 live / reload 两套内容。 */
  private handleSdkStreamMessage(
    sessionId: string,
    workspaceId: string | undefined,
    msg: SDKMessage,
  ): void {
    // 模型侧附件附录：面板已有带图的原用户气泡，SDK 回显再推会变成第二条无图消息。
    if ((msg as { type?: string }).type === "user") {
      const content = (msg as { message?: { content?: unknown } }).message
        ?.content;
      if (userContentHasAttachmentAppendix(content)) return;
      const last = this.lastSteerBySession.get(sessionId);
      if (last && Date.now() - last.at < 60_000) {
        const incoming = extractSdkUserText(
          msg as { message?: { content?: unknown } },
        );
        if (isSteerPromptEcho(incoming, last.text)) return;
      }
    }
    // 注入 createdAt（落盘带上，加载时 sdkMessageToIR 读回 → 渲染层显示时间）
    (msg as any).createdAt = (msg as any).createdAt ?? Date.now();
    // 在 SDK 转译/展示清洗前提取隐藏阶段信号，避免未来的文本清洗把协议标记一起移除。
    this.emitPlanStepSignals(sessionId, msg);
    const { message, event } = sdkMessageToIR(msg);
    const msgType = (msg as { type?: string }).type;
    // KSCC 单一流式来源：实时 text/thinking 只来自 SDK 原生 stream_event delta。
    // partial assistant 仅保留 block 结构，避免累计快照与原生 delta 双重追加；
    // final assistant 发送完整内容做最终校准。落盘仍走原始全量 msg。
    let irMessage = message;
    if (shouldDeltaTrackAssistant(message)) {
      const isFinal = message._partial !== true;
      // 原生 stream_event 尚未出现时，用累计快照做兜底，保证无原生 delta 的 KSCC 仍有运行中内容。
      // 一旦见到原生 delta，DeltaTracker 会停止派生，避免后续双追加。
      const deltas = this.getDeltaTracker(sessionId).feedAssistant(
        message.uuid,
        message.content,
        { isFinal, parentToolUseId: message.parentToolUseId ?? undefined },
      );
      for (const d of deltas) {
        this.sendPayload(sessionId, {
          kind: d.kind,
          text: d.text,
          ...(d.replace ? { replace: true } : {}),
          ...(d.uuid ? { uuid: d.uuid } : {}),
          ...(d.parentToolUseId ? { parentToolUseId: d.parentToolUseId } : {}),
        } as TAgentDesktopStreamPayload);
      }
      // partial：剥掉 body 主体（保块结构与 blockIndex 稳定）；final：发全量校准。
      if (!isFinal) {
        irMessage = {
          ...message,
          content: stripPartialAssistantBody(message.content),
        };
      }
    }
    if (irMessage) {
      // REGRESS-G 落盘闸口：落盘走原始全量 msg（不受 delta/剥离影响）；同 uuid 去重留最新=final。
      const toPersist = feedStreamPersistGate(
        this.getStreamPersistGate(sessionId),
        msg,
      );
      this.persistStreamMessages(workspaceId, sessionId, toPersist);
      this.reconcilePersistedStreamMessages(sessionId, toPersist);
      this.sendPayload(sessionId, { kind: "sdk_message", message: irMessage });
    } else if (msgType === "result") {
      // result 不带 message 但标志轮结束：先 flush 待提交 assistant，再走下方 result 事件
      const toPersist = flushStreamPersistGate(
        this.getStreamPersistGate(sessionId),
      );
      this.persistStreamMessages(workspaceId, sessionId, toPersist);
      this.reconcilePersistedStreamMessages(sessionId, toPersist);
    }
    if (event) {
      if (
        (event.kind === "stream_text_delta" ||
          event.kind === "stream_thinking_delta") &&
        !event.parentToolUseId
      ) {
        this.getDeltaTracker(sessionId).markNativeDeltaActive();
      }
      this.sendPayload(sessionId, event);
    }
    // Phase 4：result 后跑软重置阈值（廉价清理 / 影子 / 切换）
    if (msgType === "result") {
      const meta = getSessionMeta(sessionId);
      const usage = (
        msg as { usage?: { input_tokens?: number; inputTokens?: number } }
      ).usage;
      const inputTokens = usage?.input_tokens ?? usage?.inputTokens;
      void ksccSoftReset
        .onTurnResult({
          sessionId,
          inputTokens,
          modelId: meta?.modelId,
          channelId: meta?.channelId,
        })
        .catch((e) =>
          console.warn("[session-service] soft-reset onTurnResult failed:", e),
        );
    }
  }

  /** pi 路径：已是 IR（TAgentDesktopStreamPayload），落盘面板 IR + 推 IPC，不经 sdkMessageToIR。
   *  完整消息（sdk_message）落盘 IR；控制事件（result/stream_*_delta/tagent_event）不落盘。
   *  单真源流式（S1）：partial assistant（`_partial`）只推渲染层原地 upsert，**不落盘**——
   *  落盘只留 final（同 uuid 替换 partial），避免 partial 堆积污染历史 / L-rag。 */
  private handlePiStreamPayload(
    sessionId: string,
    workspaceId: string | undefined,
    p: TAgentDesktopStreamPayload,
  ): void {
    if (p.kind === "sdk_message") {
      const msg = p.message;
      if (msg.type === "assistant") this.emitPlanStepSignals(sessionId, msg);
      if (
        msg.type === "user" &&
        userContentHasAttachmentAppendix(msg.content)
      ) {
        return;
      }
      (msg as any).createdAt = (msg as any).createdAt ?? Date.now();
      const isPartial =
        msg.type === "assistant" &&
        (msg as { _partial?: boolean })._partial === true;
      if (!isPartial) {
        try {
          appendPanelMessages(workspaceId, sessionId, [msg]);
        } catch (err) {
          console.warn(
            "[session-service] appendPanelMessages failed (pi):",
            err,
          );
        }
      }
      this.sendPayload(sessionId, p);
    } else {
      this.sendPayload(sessionId, p);
    }
  }

  /** 从 assistant 隐藏标记生成结构化阶段事件，不进入转录消息。 */
  private emitPlanStepSignals(sessionId: string, message: unknown): void {
    const signals = extractPlanStepSignals(message);
    if (signals.length === 0) return;
    const uuid = String((message as { uuid?: string }).uuid ?? "message");
    const seen =
      this.planStepSignalsSeenBySession.get(sessionId) ?? new Set<string>();
    this.planStepSignalsSeenBySession.set(sessionId, seen);
    for (const signal of signals) {
      const key = uuid + ":" + signal.step + ":" + signal.status;
      if (seen.has(key)) continue;
      seen.add(key);
      this.sendPayload(sessionId, {
        kind: "tagent_event",
        event: {
          type: "plan_step_update",
          step: signal.step,
          status: signal.status,
        },
      });
    }
  }

  /** 发流式事件给 renderer */
  private sendPayload(
    sessionId: string,
    payload: TAgentDesktopStreamPayload,
  ): void {
    const win = this.getWindow();
    win?.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
      sessionId,
      payload,
    });
  }

  /** 通知 renderer 重新读取会话 meta（协作室进退房等非聊天 IPC 使用）。 */
  notifySessionMetaChanged(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    this.sendPayload(normalizedSessionId, {
      kind: "tagent_event",
      event: { type: "session_meta_changed" },
    });
  }

  /**
   * T7 续聊注入：读面板一次，派生 MoA 续聊上下文三件物（避免多次读盘）。
   * - hasMoAConclusion：面板是否含 MoA 圆桌共识（会诊 `moa-agg-*` / 研讨 `moa-disc-agg-*`），
   *   决定 LIVE / RESTART 两子况是否改写 prompt；本轮 user（type:'user'）不匹配 assistant+uuid，天然排除。
   * - historyText：全量面板历史（`buildResumeHistoryFromPanel`，排除本轮 user）—— RESTART/无进程注入用。
   * - conclusionText：仅 MoA 结论片段（`extractMoAConclusionFromMessages`）—— LIVE 前置用。
   *
   * 读失败 → 全空（调用方按现状走：不改 prompt、不抑制 resume）。复用 `buildResumeHistoryFromPanel`
   * 内部的形态归一（SDKMessage / IR 混排）与字符预算；结论检测另走 `panelMessageToHistoryIR` 转 IR
   * 后喂 `extractMoAConclusionFromMessages`，故两次 IR 转换但仅一次读盘（数组迭代，廉价）。
   */
  private buildMoaContinuationContext(
    workspaceId: string | undefined,
    sessionId: string,
  ): {
    hasMoAConclusion: boolean;
    historyText: string;
    conclusionText: string;
  } {
    try {
      const rawPanel = readPanelMessages(workspaceId, sessionId);
      const irs: TAgentMessage[] = [];
      for (const raw of rawPanel) {
        const ir = panelMessageToHistoryIR(raw);
        if (ir) irs.push(ir);
      }
      const conclusionText = extractMoAConclusionFromMessages(irs);
      const historyText = buildResumeHistoryFromPanel(rawPanel);
      return {
        hasMoAConclusion: conclusionText !== "",
        historyText,
        conclusionText,
      };
    } catch (err) {
      console.warn(
        "[session-service] buildMoaContinuationContext failed:",
        err,
      );
      return { hasMoAConclusion: false, historyText: "", conclusionText: "" };
    }
  }

  /**
   * Phase 2.5：turn 开始 Nudge 检测（双核统一入口）。
   * 读面板消息 → onTurnStart → 有候选则推 NUdge_EVENT。
   */
  private runNudgeOnTurnStart(
    sessionId: string,
    meta: AgentSessionMeta | undefined,
  ): void {
    try {
      // switching 时提示 UI，不打断 Nudge（仍可记）
      if (meta?.shadowState === "switching") {
        this.sendPayload(sessionId, {
          kind: "tagent_event",
          event: { type: "memory_organizing", status: "switching" },
        });
      }
      const mode: MemoryMode = meta?.mode === "ta" ? "ta" : "general";
      // Phase 5.2：跨核归一化
      const recentMsgs = normalizeToTextMessages(
        readPanelMessages(meta?.workspaceId, sessionId).slice(-10),
      ).map((m) => ({ role: m.role, content: m.contentText }));
      const candidates = nudgeService.onTurnStart(sessionId, recentMsgs, mode, meta?.workspaceId ?? undefined);
      if (candidates.length > 0) {
        const win = this.getWindow();
        win?.webContents.send(MEMORY_IPC_CHANNELS.NUdge_EVENT, {
          type: "nudge_candidates",
          sessionId,
          mode,
          nudges: candidates,
        });
      }
    } catch (err) {
      console.warn("[session-service] runNudgeOnTurnStart failed:", err);
    }
  }

  /**
   * Phase 2.5：turn 结束后写 L4 + evidence sink。
   * 失败仅 warn，不阻塞主流程。
   */
  private recordSessionToMemory(sessionId: string, userPrompt: string): void {
    try {
      const meta = getSessionMeta(sessionId);
      const mode: MemoryMode = meta?.mode === "ta" ? "ta" : "general";
      const workspaceSlug = meta?.workspaceId ?? "";
      const panel = readPanelMessages(meta?.workspaceId, sessionId);
      const { toolsUsed, lastAssistantText } = this.extractToolsAndAssistant(
        panel.slice(-20),
      );
      const userMessages = this.panelMessagesToRoleContent(panel.slice(-20))
        .filter((message) => message.role === "user")
        .map((message) => message.content.slice(0, 800))
        .filter(Boolean)
        .slice(-8);
      const title = (userPrompt || meta?.title || "会话").slice(0, 100);
      const summary = lastAssistantText.slice(0, 500);
      void memoryLayerService
        .recordSession({
          sessionId,
          title,
          summary,
          keyFacts: [],
          toolsUsed,
          mode,
          workspaceSlug,
        })
        .catch((e) =>
          console.warn("[session-service] recordSession failed:", e),
        );

      // 将会话证据写入 sink，供空闲 consolidation 批量处理
      try {
        memoryEvidenceSink.writeSessionEvidence(
          mode,
          sessionId,
          title,
          summary,
          toolsUsed,
          userMessages,
          workspaceSlug,
        );
      } catch (e) {
        console.warn("[session-service] writeSessionEvidence failed:", e);
      }
    } catch (err) {
      console.warn("[session-service] recordSessionToMemory failed:", err);
    }
  }

  /** 面板消息 → Nudge 用的 role/content 列表（兼容 SDKMessage 与 IR） */
  private panelMessagesToRoleContent(
    messages: unknown[],
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const out: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const raw of messages) {
      const m = raw as {
        type?: string;
        role?: string;
        message?: { role?: string; content?: unknown };
        content?: unknown;
      };
      const roleRaw =
        m.message?.role ??
        (m.type === "user" || m.type === "assistant" ? m.type : m.role);
      if (roleRaw !== "user" && roleRaw !== "assistant") continue;
      const content = m.message?.content ?? m.content;
      const text = this.contentToText(content);
      if (!text.trim()) continue;
      out.push({ role: roleRaw, content: text });
    }
    return out;
  }

  private contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((b) => {
        if (
          b &&
          typeof b === "object" &&
          "type" in b &&
          (b as { type: string }).type === "text"
        ) {
          return String((b as { text?: string }).text ?? "");
        }
        return "";
      })
      .join("");
  }

  private extractToolsAndAssistant(messages: unknown[]): {
    toolsUsed: string[];
    lastAssistantText: string;
  } {
    const tools = new Set<string>();
    let lastAssistantText = "";
    for (const raw of messages) {
      const m = raw as {
        type?: string;
        role?: string;
        message?: { role?: string; content?: unknown };
        content?: unknown;
      };
      const content = m.message?.content ?? m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            "type" in block &&
            (block as { type: string }).type === "tool_use" &&
            "name" in block &&
            typeof (block as { name: unknown }).name === "string"
          ) {
            tools.add((block as { name: string }).name);
          }
        }
      }
      const role =
        m.message?.role ??
        (m.type === "assistant" || m.type === "user" ? m.type : m.role);
      if (role === "assistant") {
        const text = this.contentToText(content);
        if (text) lastAssistantText = text;
      }
    }
    return { toolsUsed: Array.from(tools), lastAssistantText };
  }

  /** 停止并删除指定工作区的全部会话，供工作区删除流程复用。 */
  deleteWorkspaceSessions(workspaceId: string): number {
    const sessionIds = listSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.id);

    for (const sessionId of sessionIds) {
      const runtime = this.runtimes.get(sessionId);
      if (runtime) {
        runtime.destroy();
        this.runtimes.delete(sessionId);
      }
      this.disposeBrowserSession(sessionId);
    }

    return deleteSessionsByWorkspace(workspaceId).length;
  }

  /** 销毁所有会话（应用退出） */
  disposeAll(): void {
    for (const [sessionId, rt] of this.runtimes) {
      rt.destroy();
      this.disposeBrowserSession(sessionId);
    }
    this.runtimes.clear();
  }

  /**
   * 是否有运行中的 Agent（自动更新安装前检查用）。
   * 用 isTurnInFlight() 而非 isRunning()：长驻进程 isRunning 恒 true。
   */
  hasActiveAgents(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.isTurnInFlight()) return true;
    }
    return this.moaInFlight.size > 0;
  }
  /**
   * 后台 Automation 专用执行入口。
   * 不走 renderer IPC，也不参与协作室路由；仍复用当前 2.0 的 SessionRuntime、权限和持久化链路。
   */
  async runAutomatedTurn(input: {
    sessionId: string
    prompt: string
    channelId: string
    model?: string
    workspaceId?: string
    contextPrompt?: string
  }): Promise<void> {
    if (!getSessionMeta(input.sessionId)) {
      throw new Error(`自动任务会话不存在: ${input.sessionId}`)
    }
    await this.handleSend({
      sessionId: input.sessionId,
      prompt: input.prompt,
      contextPrompt: input.contextPrompt,
      channelId: input.channelId,
      model: input.model,
      workspaceId: input.workspaceId,
      skipFusionRouting: true,
      executionMode: 'work',
    })
  }
}
