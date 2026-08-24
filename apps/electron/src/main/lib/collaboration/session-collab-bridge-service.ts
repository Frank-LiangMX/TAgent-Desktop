/**
 * 单会话 ↔ 协作室桥接服务层（14-SESSION-COLLAB-BRIDGE-SPEC §1–§5，P2-UX-BRIDGE-SERVICE-brief）
 *
 * 在**不改 UI、不静默改自动升级行为**的前提下落地服务层：
 * - 明示进房 enterCollaborationWithBridge（userConfirmed 闸）：复用 upgradeFusionSession 建房，
 *   把单会话面板历史精炼为 SessionToRoomBrief 写入房间 goal（短）+ 系统消息（完整前情提要）。
 * - 明示退出 exitCollaborationWithBridge（userConfirmed 闸）：精炼协作结论为 RoomToSessionHandoff
 *   写回原 session 面板（系统通知卡），清 fusionRoomId、按剩余 Bot 重算 fusionMode，房间转 paused（保留历史）。
 * - 按需读原史 readSourceSessionExcerpt：预算校验 + 读 panel + clamp；由 room service host tool 接线。
 *
 * 精炼用便宜/快速模型（modelCaller 注入，默认复用 completeMemoryLlm）；失败 **fail-closed 启发式**
 *（从最近消息抽字段），不抛崩、不阻塞建房/退出。测试必须注入假 caller，CI 不打真网。
 *
 * 红线：不动 SessionBotBar 自动升级 UI；不动 removeMember 静默回退；不把单会话运行时改成 room 投影；
 * 不整包原 JSONL 塞进每轮 prompt；旧 upgrade-from-session 路径保留不动（旧路径无精炼桥）。
 */
import {
  buildRoomToSessionHandoff,
  buildSessionToRoomBrief,
  clampBridgeText,
  formatRoomToSessionHandoffForPrompt,
  formatSessionToRoomBriefForPrompt,
  getFusionConversationMode,
  latestCollaborationRoomSummaryText,
  validateSourceExcerptBudget,
  ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS,
  SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS,
  extractPersistedUserText,
  isPersistedMainAssistantMessage,
  isPersistedRealUserMessage,
  type CollaborationMessage,
  type CollaborationRoomTask,
  type EnterCollaborationWithBridgeInput,
  type EnterCollaborationWithBridgeResult,
  type ExitCollaborationWithBridgeInput,
  type ExitCollaborationWithBridgeResult,
  type SourceSessionExcerptRequest,
  type SourceSessionExcerptResult,
} from "@tagent/shared";
import { completeMemoryLlm } from "../memory/memory-llm-client";
import { getCollaborationSummary } from "./collaboration-room-repository";
import type { CollaborationRoomService } from "./collaboration-room-service";
import {
  appendPanelMessages,
  getSessionMeta,
  readPanelMessages,
  updateSessionMeta,
} from "../agent/session-store";

// ===== 常量 =====

/** 进房精炼输入侧字符硬顶（14 §2：建议输入硬顶 12k 字符；超则头尾保留）。 */
const BRIEF_TRANSCRIPT_CHAR_BUDGET = 12_000;
/** 按需读原史：无 query 时取最近 N 条（14 §2，brief 默认 12）。 */
const DEFAULT_EXCERPT_RECENT_LIMIT = 12;
/** 启发式 goal 字符硬顶（短目标，避免把长 user 文本整段当 goal）。 */
const HEURISTIC_GOAL_CHAR_BUDGET = 600;
/** 启发式 narrative 字符硬顶（最近若干条拼接再 clamp）。 */
const HEURISTIC_NARRATIVE_CHAR_BUDGET = 2_000;

/** 进房精炼系统提示：要求模型只输出 JSON 前情提要。 */
const BRIDGE_BRIEF_SYSTEM_PROMPT = [
  "你是会话精炼器。把单会话历史精炼为进房前情提要，供协作室团队快速上手。",
  "只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。schema：",
  '{ "goal": string, "decisions": string[], "openQuestions": string[], "todos": string[], "artifacts": string[] }',
  "goal 是当前目标（一句话）；decisions 是已确认结论；openQuestions 是未决问题；todos 是待办；artifacts 是关键文件/路径/约束。",
  "没有对应内容时给空字符串或空数组。字段不要臆造。",
].join("\n");

/** 退出精炼系统提示：要求模型只输出 JSON 回写结论。 */
const BRIDGE_HANDOFF_SYSTEM_PROMPT = [
  "你是协作结论精炼器。把协作室消息/任务/摘要精炼为回写单会话的结论，宁短勿长。",
  "只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。schema：",
  '{ "outcomes": string[], "changes": string[], "risks": string[] }',
  "outcomes 是协作结论/交付物；changes 是改了什么（文件/任务状态）；risks 是未完成与风险。",
  "没有对应内容时给空数组。字段不要臆造。",
].join("\n");

// ===== 错误类型（稳定 code，IPC 可映射） =====

/** userConfirmed 非 true 时抛出（14 §1：禁止静默自动升/退）。 */
export class BridgeConfirmRequiredError extends Error {
  public readonly code = "USER_CONFIRM_REQUIRED";
  constructor(message = "需要用户确认才能执行该操作") {
    super(message);
    this.name = "BridgeConfirmRequiredError";
  }
}

/** 按需读原史预算校验失败时抛出（单轮耗尽 / 请求非正）。 */
export class BridgeExcerptBudgetError extends Error {
  public readonly code:
    | "per-turn-budget-exhausted"
    | "requested-non-positive";
  constructor(
    code: "per-turn-budget-exhausted" | "requested-non-positive",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BridgeExcerptBudgetError";
    this.code = code;
  }
}

// ===== 模型调用注入点 =====

/** 桥接精炼模型调用（注入点）。测试传假实现即可覆盖，不必真打模型。 */
export type BridgeModelCaller = (input: {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * 默认模型调用：复用记忆子系统便宜模型客户端（completeMemoryLlm）。
 * 无可用渠道时它会抛 MemoryLlmError(NO_CHANNEL)——服务层 catch 后回退启发式，fail-closed。
 */
export const defaultBridgeModelCaller: BridgeModelCaller = (input) =>
  completeMemoryLlm({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    signal: input.signal,
  });

/** 服务层输入 = IPC 输入（可序列化，无 signal）+ 可选 AbortSignal（不可跨 IPC）。 */
export type EnterCollaborationWithBridgeServiceInput =
  EnterCollaborationWithBridgeInput & { signal?: AbortSignal };
export type ExitCollaborationWithBridgeServiceInput =
  ExitCollaborationWithBridgeInput & { signal?: AbortSignal };

/** 服务构造选项（roomService 必填；modelCaller / meta 变更通知可注入）。 */
export interface SessionCollabBridgeServiceOptions {
  /** 协作室服务（复用 upgradeFusionSession / updateRoom / appendRoomSystemMessage）。 */
  roomService: CollaborationRoomService;
  /** 精炼模型调用（默认 completeMemoryLlm）。 */
  modelCaller?: BridgeModelCaller;
  /**
   * 进退协作后通知渲染层 session meta 已变。默认 noop，便于服务层单测和非 Electron 调用方复用。
   */
  notifySessionMetaChanged?: (sessionId: string) => void;
}

// ===== 服务 =====

export class SessionCollabBridgeService {
  private readonly roomService: CollaborationRoomService;
  private readonly modelCaller: BridgeModelCaller;
  private readonly notifySessionMetaChanged: (sessionId: string) => void;

  constructor(opts: SessionCollabBridgeServiceOptions) {
    if (!opts?.roomService) throw new Error("roomService 不能为空");
    this.roomService = opts.roomService;
    this.modelCaller = opts.modelCaller ?? defaultBridgeModelCaller;
    this.notifySessionMetaChanged = opts.notifySessionMetaChanged ?? (() => {});
  }

  /**
   * 明示进房（14 §1）。
   *
   * 1. userConfirmed 闸。2. 幂等复用（已有 fusionRoomId 且房间存在 → 不重复 summarize，返回最小 brief）。
   * 3. upgradeFusionSession 建房。4. 读 panel → transcript（12k 字符硬顶，头尾保留）。
   * 5. modelCaller 返回 JSON；解析失败/抛错 → 启发式。6. buildSessionToRoomBrief（默认预算）。
   * 7. 写房间 goal（短）+ 系统消息（完整 formatted brief）。8. 推送 session_meta_changed。
   */
  async enterCollaborationWithBridge(
    input: EnterCollaborationWithBridgeServiceInput,
  ): Promise<EnterCollaborationWithBridgeResult> {
    if (input.userConfirmed !== true) throw new BridgeConfirmRequiredError();
    const sessionId = input.sessionId?.trim();
    if (!sessionId) throw new Error("sessionId 不能为空");
    const meta = getSessionMeta(sessionId);
    if (!meta) throw new Error("会话不存在");

    // 幂等复用：已有 fusionRoomId 且房间存在 → 不重复 summarize（14 §1.3「幂等复用」）
    if (meta.fusionRoomId) {
      const existing = this.roomService.getRoomById(meta.fusionRoomId);
      if (existing) {
        const brief = buildSessionToRoomBrief({
          goal: existing.goal,
          decisions: [],
          openQuestions: [],
          todos: [],
          artifacts: [],
          sourceSessionId: sessionId,
          budgetTokens: SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS,
        });
        return {
          roomId: existing.id,
          sourceSessionId: sessionId,
          brief,
          briefSource: "heuristic",
          reusedExistingRoom: true,
        };
      }
    }

    // 建房（复用既有路径，不复制建房逻辑；< 2 Bot 时 upgradeFusionSession 自行抛错）
    const room = this.roomService.upgradeFusionSession({
      sessionId,
      title: input.title,
      goal: input.goalHint,
    });

    // 读 panel → transcript（最近有效发言，字符硬顶，头尾保留）
    const lines = extractTranscriptLines(
      readPanelMessages(meta.workspaceId, sessionId),
    );
    const transcript = joinTranscript(lines, BRIEF_TRANSCRIPT_CHAR_BUDGET);

    // modelCaller → JSON；失败 fail-closed 启发式
    let briefSource: "llm" | "heuristic" = "heuristic";
    let fields: {
      goal: string;
      decisions: string[];
      openQuestions: string[];
      todos: string[];
      artifacts: string[];
      narrative?: string;
    };
    const parsed = await this.callBriefModel(transcript, input.signal);
    if (parsed) {
      fields = {
        goal: parsed.goal,
        decisions: parsed.decisions,
        openQuestions: parsed.openQuestions,
        todos: parsed.todos,
        artifacts: parsed.artifacts,
      };
      briefSource = "llm";
    } else {
      fields = heuristicBriefFields(lines, input.goalHint);
    }

    const brief = buildSessionToRoomBrief({
      goal: fields.goal,
      decisions: fields.decisions,
      openQuestions: fields.openQuestions,
      todos: fields.todos,
      artifacts: fields.artifacts,
      narrative: fields.narrative,
      sourceSessionId: sessionId,
      budgetTokens: SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS,
    });

    // 写房间 goal（短）+ 系统消息（完整 formatted brief）
    const goalForRoom = brief.goal.trim() || room.goal;
    this.roomService.updateRoom({ roomId: room.id, goal: goalForRoom });
    this.roomService.appendRoomSystemMessage(
      room.id,
      "【单会话前情提要】\n" + formatSessionToRoomBriefForPrompt(brief),
    );
    this.notifySessionMetaChanged(sessionId);

    return {
      roomId: room.id,
      sourceSessionId: sessionId,
      brief,
      briefSource,
      reusedExistingRoom: false,
    };
  }

  /**
   * 调进房精炼模型并解析 JSON。模型抛错 / 解析失败 / 全空 → 返回 null（调用方走启发式）。
   * abort 信号触发时向上抛（不当成功）。
   */
  private async callBriefModel(
    userPrompt: string,
    signal: AbortSignal | undefined,
  ): Promise<{
    goal: string;
    decisions: string[];
    openQuestions: string[];
    todos: string[];
    artifacts: string[];
  } | null> {
    try {
      const raw = await this.modelCaller({
        systemPrompt: BRIDGE_BRIEF_SYSTEM_PROMPT,
        userPrompt,
        signal,
      });
      return parseBriefJson(raw);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn("[桥接] 进房精炼模型调用失败，回退启发式:", err);
      return null;
    }
  }

  /**
   * 明示退出（14 §1）。
   *
   * 1. userConfirmed 闸。2. meta 必须有 fusionRoomId 且房间存在。3. 收集房间消息/任务/摘要 →
   * modelCaller 或启发式 → buildRoomToSessionHandoff。4. 写回原 session 面板（系统通知卡）。
   * 5. 清 fusionRoomId、按剩余 Bot 重算 fusionMode（对齐 syncSourceSessionAfterRoomMemberChange 降档语义，
   * 但不依赖成员数自动触发）；房间转 paused。6. 通知 session meta 变更（默认 noop，meta 已落盘）。
   */
  async exitCollaborationWithBridge(
    input: ExitCollaborationWithBridgeServiceInput,
  ): Promise<ExitCollaborationWithBridgeResult> {
    if (input.userConfirmed !== true) throw new BridgeConfirmRequiredError();
    const sessionId = input.sessionId?.trim();
    if (!sessionId) throw new Error("sessionId 不能为空");
    const meta = getSessionMeta(sessionId);
    if (!meta) throw new Error("会话不存在");
    if (!meta.fusionRoomId) throw new Error("该会话未开启协作，无法退出");
    const room = this.roomService.getRoomById(meta.fusionRoomId);
    if (!room) throw new Error("关联的协作室不存在，无法退出");

    // 收集房间消息/任务/现有摘要
    const messages = this.roomService.listMessages(room.id);
    const tasks = this.roomService.listRoomTasks(room.id);
    const summaryText =
      latestCollaborationRoomSummaryText(getCollaborationSummary(room.id)) ??
      undefined;
    const transcript =
      buildRoomTranscript(messages, BRIEF_TRANSCRIPT_CHAR_BUDGET) +
      buildRoomContextBlock(tasks, summaryText);

    // modelCaller → JSON；失败 fail-closed 启发式
    let handoffSource: "llm" | "heuristic" = "heuristic";
    let fields: {
      outcomes: string[];
      changes: string[];
      risks: string[];
      narrative?: string;
    };
    const parsed = await this.callHandoffModel(transcript, input.signal);
    if (parsed) {
      fields = {
        outcomes: parsed.outcomes,
        changes: parsed.changes,
        risks: parsed.risks,
      };
      handoffSource = "llm";
    } else {
      fields = heuristicHandoffFields(messages, tasks, summaryText);
    }

    const handoff = buildRoomToSessionHandoff({
      outcomes: fields.outcomes,
      changes: fields.changes,
      risks: fields.risks,
      narrative: fields.narrative,
      roomId: room.id,
      sourceSessionId: sessionId,
      budgetTokens: ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS,
    });

    // 写回原 session 面板（项目惯例可见系统卡：assistant + modelId 标记，禁止写成 user）
    const notice = {
      type: "assistant" as const,
      modelId: "协作室回写",
      content: [
        {
          type: "text" as const,
          text: "【协作室回写】\n" + formatRoomToSessionHandoffForPrompt(handoff),
        },
      ],
      createdAt: Date.now(),
    };
    try {
      appendPanelMessages(meta.workspaceId, sessionId, [notice]);
    } catch (err) {
      console.error("[桥接] 回写面板消息落盘失败:", err);
    }

    // 降档 meta：清 fusionRoomId，fusionMode 按当前 botProfileIds.length 重算
    const botIds = [...new Set(meta.botProfileIds ?? [])].filter(
      (id): id is string => Boolean(id),
    );
    const mode = getFusionConversationMode(1, botIds.length);
    let fusionCoordinatorBotProfileId: string | undefined;
    if (mode === "multi-bot") {
      const existing = meta.fusionCoordinatorBotProfileId;
      fusionCoordinatorBotProfileId =
        existing && botIds.includes(existing) ? existing : botIds[0];
    }
    updateSessionMeta(sessionId, {
      fusionRoomId: undefined,
      fusionMode: mode,
      fusionCoordinatorBotProfileId,
    });
    // 房间转 paused（保留历史，可从协作列表再看，但不绑 Chat 壳；勿删历史）
    this.roomService.updateRoom({ roomId: room.id, status: "paused" });

    this.notifySessionMetaChanged(sessionId);
    return {
      roomId: room.id,
      sourceSessionId: sessionId,
      handoff,
      handoffSource,
    };
  }

  /** 调退出精炼模型并解析 JSON。模型抛错 / 解析失败 / 全空 → null（走启发式）；abort 向上抛。 */
  private async callHandoffModel(
    userPrompt: string,
    signal: AbortSignal | undefined,
  ): Promise<{ outcomes: string[]; changes: string[]; risks: string[] } | null> {
    try {
      const raw = await this.modelCaller({
        systemPrompt: BRIDGE_HANDOFF_SYSTEM_PROMPT,
        userPrompt,
        signal,
      });
      return parseHandoffJson(raw);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn("[桥接] 退出精炼模型调用失败，回退启发式:", err);
      return null;
    }
  }

  /**
   * 按需读原 session 摘录（14 §2，read_source_session_excerpt 服务函数；host tool 由 room service 接线）。
   *
   * - validateSourceExcerptBudget 失败 → 抛 BridgeExcerptBudgetError（稳定 code，IPC 可映射）。
   * - 读 sourceSessionId 的 panel；query 有则大小写不敏感包含匹配，否则最近 N 条（默认 12）。
   * - clampBridgeText 到 allowedTokens。
   */
  readSourceSessionExcerpt(
    req: SourceSessionExcerptRequest,
    alreadyUsedThisTurnTokens: number,
  ): SourceSessionExcerptResult {
    const budget = validateSourceExcerptBudget(
      req.maxTokens,
      alreadyUsedThisTurnTokens,
    );
    if (!budget.ok) throw new BridgeExcerptBudgetError(budget.reason);

    const sourceSessionId = req.sourceSessionId?.trim();
    if (!sourceSessionId) throw new Error("sourceSessionId 不能为空");
    const meta = getSessionMeta(sourceSessionId);
    if (!meta) throw new Error("来源会话不存在");
    const lines = extractTranscriptLines(
      readPanelMessages(meta.workspaceId, sourceSessionId),
    );

    let selected: TranscriptLine[];
    const query = req.query?.trim();
    if (query) {
      const q = query.toLowerCase();
      selected = lines.filter((line) => line.text.toLowerCase().includes(q));
    } else {
      const limit =
        req.recentMessageLimit && req.recentMessageLimit > 0
          ? req.recentMessageLimit
          : DEFAULT_EXCERPT_RECENT_LIMIT;
      selected = lines.slice(-limit);
    }

    const joined = selected
      .map((line) => `${line.role === "user" ? "用户" : "助手"}：${line.text}`)
      .join("\n\n");
    const clamped = clampBridgeText(joined, budget.allowedTokens);
    return {
      sourceSessionId,
      excerpt: clamped.text,
      tokenEstimate: clamped.tokenEstimate,
      charCount: clamped.charCount,
      truncated: clamped.truncated,
    };
  }
}

// ===== 内部纯函数：transcript 抽取 / 拼装 / 启发式 / JSON 解析 =====

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

/** 从面板消息行抽取文本（user / assistant 的 message.content 或 content 文本块）。 */
function extractPanelText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const r = msg as Record<string, unknown>;
  const inner = r.message;
  const content =
    inner && typeof inner === "object"
      ? (inner as Record<string, unknown>).content
      : r.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") out += b.text;
    }
  }
  return out.trim();
}

/** 把面板消息分类为最近有效发言行（真实 user / 主线 assistant；跳过控制文/工具轨迹/子代理）。 */
function extractTranscriptLines(messages: unknown[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const msg of messages) {
    if (isPersistedRealUserMessage(msg)) {
      const text = extractPersistedUserText(msg);
      if (text) lines.push({ role: "user", text });
    } else if (isPersistedMainAssistantMessage(msg)) {
      const text = extractPanelText(msg);
      if (text) lines.push({ role: "assistant", text });
    }
  }
  return lines;
}

/** 把发言行拼成 transcript，超字符硬顶则头尾保留（中段省略标记）。 */
function joinTranscript(lines: TranscriptLine[], charBudget: number): string {
  const text = lines
    .map((line) => `${line.role === "user" ? "用户" : "助手"}：${line.text}`)
    .join("\n\n");
  return clampHeadTail(text, charBudget);
}

/** 头尾保留裁剪：超 charBudget 时取前 60% + 后 40%，中段以省略标记替代。 */
function clampHeadTail(text: string, charBudget: number): string {
  if (text.length <= charBudget) return text;
  if (charBudget <= 0) return "";
  const head = Math.max(1, Math.floor(charBudget * 0.6));
  const tail = Math.max(1, charBudget - head);
  return `${text.slice(0, head)}\n\n…（中段已省略）…\n\n${text.slice(-tail)}`;
}

/** 把房间消息拼成 transcript（user/member 实质发言，跳过 system/task_event）。 */
function buildRoomTranscript(
  messages: CollaborationMessage[],
  charBudget: number,
): string {
  const text = messages
    .filter(
      (m) =>
        (m.authorType === "user" || m.authorType === "member") &&
        m.kind !== "task_event" &&
        m.kind !== "warning",
    )
    .map((m) => `${m.authorType === "user" ? "用户" : "成员"}：${m.content}`)
    .join("\n\n");
  return clampHeadTail(text, charBudget);
}

/** 房间任务 + 现有摘要拼成上下文块（追加到退出 transcript 末尾供模型参考）。 */
function buildRoomContextBlock(
  tasks: CollaborationRoomTask[],
  summaryText: string | undefined,
): string {
  const parts: string[] = [];
  if (summaryText) parts.push(`房间摘要：${summaryText}`);
  if (tasks.length > 0) {
    parts.push(
      "房间任务：\n" +
        tasks
          .slice(0, 30)
          .map((t) => `- 「${t.title}」状态：${t.status}`)
          .join("\n"),
    );
  }
  return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
}

/** 启发式进房 brief 字段：最近 user 文本作 goal，其余列表空，narrative = 最近若干条拼接再 clamp。 */
function heuristicBriefFields(
  lines: TranscriptLine[],
  goalHint: string | undefined,
): {
  goal: string;
  decisions: string[];
  openQuestions: string[];
  todos: string[];
  artifacts: string[];
  narrative: string;
} {
  let goal = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.role === "user") {
      goal = lines[i]!.text;
      break;
    }
  }
  if (!goal && goalHint) goal = goalHint.trim();
  goal = clampHeadTail(goal, HEURISTIC_GOAL_CHAR_BUDGET);
  const recent = lines.slice(-8);
  const narrative = clampHeadTail(
    recent
      .map((line) => `${line.role === "user" ? "用户" : "助手"}：${line.text}`)
      .join("\n"),
    HEURISTIC_NARRATIVE_CHAR_BUDGET,
  );
  return {
    goal,
    decisions: [],
    openQuestions: [],
    todos: [],
    artifacts: [],
    narrative,
  };
}

/** 启发式回写 handoff 字段：outcomes 取现有摘要或兜底，changes 取任务标题/状态，risks 空，narrative 取最近房间消息。 */
function heuristicHandoffFields(
  messages: CollaborationMessage[],
  tasks: CollaborationRoomTask[],
  summaryText: string | undefined,
): {
  outcomes: string[];
  changes: string[];
  risks: string[];
  narrative: string;
} {
  const outcomes: string[] = [];
  if (summaryText) outcomes.push(summaryText);
  if (outcomes.length === 0) outcomes.push("协作已结束（详见房间消息）");
  const changes = tasks
    .slice(0, 20)
    .map((t) => `任务「${t.title}」状态：${t.status}`);
  const recentMsgs = messages
    .filter(
      (m) =>
        (m.authorType === "user" || m.authorType === "member") &&
        m.kind !== "task_event" &&
        m.kind !== "warning",
    )
    .slice(-12);
  const narrative = clampHeadTail(
    recentMsgs
      .map((m) => `${m.authorType === "user" ? "用户" : "成员"}：${m.content}`)
      .join("\n"),
    3_000,
  );
  return { outcomes, changes, risks: [], narrative };
}

/** 从模型原始输出解析 JSON 对象（剥 ```json 围栏 + 截取首个 {…}）；失败返回 null。 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1]!.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 把未知值归一为非空 trimmed 字符串数组。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string" ? item : item == null ? "" : String(item),
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析进房 brief JSON；全空或非法 → null（调用方走启发式）。 */
function parseBriefJson(raw: string): {
  goal: string;
  decisions: string[];
  openQuestions: string[];
  todos: string[];
  artifacts: string[];
} | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;
  const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
  const decisions = toStringArray(obj.decisions);
  const openQuestions = toStringArray(obj.openQuestions);
  const todos = toStringArray(obj.todos);
  const artifacts = toStringArray(obj.artifacts);
  if (
    !goal &&
    decisions.length === 0 &&
    openQuestions.length === 0 &&
    todos.length === 0 &&
    artifacts.length === 0
  ) {
    return null;
  }
  return { goal, decisions, openQuestions, todos, artifacts };
}

/** 解析回写 handoff JSON；全空或非法 → null（调用方走启发式）。 */
function parseHandoffJson(raw: string): {
  outcomes: string[];
  changes: string[];
  risks: string[];
} | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;
  const outcomes = toStringArray(obj.outcomes);
  const changes = toStringArray(obj.changes);
  const risks = toStringArray(obj.risks);
  if (outcomes.length === 0 && changes.length === 0 && risks.length === 0) {
    return null;
  }
  return { outcomes, changes, risks };
}
