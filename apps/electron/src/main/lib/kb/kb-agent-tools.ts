/**
 * 知识库 Agent 工具（Phase 0 · 只读检索，dual-mount · P1-1 统一数据源）
 *
 * - kb_list_roots：列出会话绑定的知识库（正式文档）与来源根目录
 * - kb_search({ query, rootId?, limit? })：在「正式文档 + 绑定来源目录」内关键词检索，
 *   命中带 source(document/directory)、documentId/路径、标题与摘录，按命中度排序
 * - kb_get({ documentId? | path? })：按 documentId 读正式文档全文（须属会话绑定库），
 *   或按 path 读来源目录内单文件（防路径穿越）
 * - kb_read_attachment({ localPath })：读取并解析当前会话刚上传的附件
 *   （.docx/.pdf/.xlsx/.md/.txt/.csv）为统一中间格式（文本 / 各工作表），供整理草稿。
 *   只读当前会话附件目录，会话隔离 + 防穿越，零写入、不自动保存
 *
 * 全部只读（readOnlyHint）。Chat / Work 均可用（不挂 Work 门控）。
 * kscc：createSdkMcpServer 注入 mcpServers.kb；Pi：TypeBox AgentTool 列表 extraTools。
 * 仿 kanban-agent-tools.ts / browser-agent-tools.ts 的 dual-mount 形态。
 *
 * 处理器在调用时读会话 meta.knowledgeBaseIds / kbRoots（非 spawn 时快照），故绑定变化对
 * 工具行为即时生效；绑定变化对「工具指纹 / 长驻进程配置」的影响由 session-service 负责
 * （Pi 热重建 / kscc re-spawn）。与 L0–L5 记忆 / BotMemory 物理隔离：KB 零写入。
 *
 * P1-1：正式文档（knowledge-base-documents.json）与来源目录共用同一套关键词打分
 * （kb-search-score），在 tools 层合并、统一 limit、统一来源标注。
 *
 * @see docs/dev/knowledge-base/KB-PRODUCT-SPEC-v2.md
 * @see docs/dev/knowledge-base/KB-P1-1-DOCS-SEARCH-brief.md
 * @see docs/dev/knowledge-base/KB-AGENT-MODE-DESIGN.md
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  KnowledgeBaseMode,
  KnowledgeBaseRecord,
  KnowledgeBaseStructuredDraft,
  KbProposeSaveKind,
  KbProposeSaveRequest,
} from "@tagent/shared";
import { normalizeKnowledgeBaseDocumentKind } from "@tagent/shared";
import { getSessionMeta, listSessions } from "../agent/session-store";
import { getDefaultKbIndex, normalizeKbRoots } from "./kb-fs-index";
import type { KbSearchHit } from "./kb-fs-index";
import { resolveKnowledgeBaseRootsForSession, listKnowledgeBases } from "./knowledge-base-store";
import {
  attachmentMediaType,
  getKnowledgeBaseDocument,
  isSupportedAttachmentExt,
  listKnowledgeBaseDocumentsForIds,
  parseAttachmentFile,
  searchKnowledgeBaseDocuments,
} from "./knowledge-base-document-store";
import { clampSearchLimit, tokenize } from "./kb-search-score";
import { kbProposeSaveService } from "./kb-propose-save-service";
import {
  KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE,
} from "./kb-write-policy";
import { resolveSessionAttachmentPath } from "../attachment-service";

export interface KbToolContext {
  sessionId: string;
  /**
   * 受控写入门控所需：把 kb_propose_save 确认请求推到渲染层横幅。
   * 缺省时 kb_propose_save 直接报错（绝不静默写入）。由 session-service 注入
   * （webContents.send(KB_PROPOSE_SAVE_REQUEST)）；只读工具不依赖此字段。
   */
  sendToRenderer?: (request: KbProposeSaveRequest) => void;
  /**
   * 是否允许文档写入。发行版默认关闭；测试或开发验证可显式打开。
   * 只读检索工具不依赖此字段。
   */
  knowledgeBaseWritesEnabled?: boolean;
  /**
   * 可选 run 级 abort signal：kb_propose_save 等待确认时若 run 被中止则 resolve aborted。
   * kscc/Pi 工具 execute 不一定能拿到 SDK run signal，缺省时靠 clearSessionPending 兜底。
   */
  signal?: AbortSignal;
}

/** 来源目录命中的结构（来自 kb-fs-index）用于映射为统一命中 */
type KbDirectoryHit = KbSearchHit;

/** kb_search 统一命中（document 与 directory 共形，向后兼容地补 source/documentId 等字段） */
export interface KbUnifiedSearchHit {
  source: "document" | "directory";
  /** document 命中：所属知识库 id */
  knowledgeBaseId?: string;
  /** document 命中：文档 id（可直接喂给 kb_get） */
  documentId?: string;
  /** document 命中的稳定片段 id，可用于后续定位 / 引用 */
  chunkId?: string;
  /** document 命中：文档类型标注（缺省 note）；directory 命中无此字段 */
  kind?: "note" | "contract" | "norm" | "snapshot";
  title: string;
  score: number;
  excerpt: string;
  matchedIn: "title" | "body" | "both";
  // directory only：
  rootId?: string;
  rootLabel?: string;
  relativePath?: string;
  absolutePath?: string;
  /** document only: the matched chunk section and source lines. */
  section?: string;
  sourcePosition?: { startLine: number; endLine: number };
}

/**
 * 未挂库时「可发现」的库条目（刀 3，仅元数据，绝不含正文 / 文档标题列表）。
 * - related=true：通过 {@link KnowledgeBaseRecord.relatedWorkspaceIds} 命中当前会话 workspaceId。
 * - related=false：无关联库时的「最近使用」兜底（从会话 metas 扫 knowledgeBaseIds）。
 */
export interface KbAvailableEntry {
  id: string;
  name: string;
  /** 可选一句话描述（来自知识库 description），用于口头推荐时点一下用途 */
  description?: string;
  /** 是否关联当前工作区；false 表示是「最近使用」兜底推荐 */
  related: boolean;
}

/** kb_list_available 返回（刀 3）：当前是否已挂库 + 未挂时可发现的库（仅元数据） */
export interface KbAvailableResult {
  /** 当前会话是否已挂库（有 knowledgeBaseIds 或 kbRoots） */
  bound: boolean;
  /** 未挂库时可发现的库；已挂库时为空（检索仍只用绑定集，提示词以绑定库为准） */
  available: KbAvailableEntry[];
}

/**
 * 知识库工具系统提示词（静态指引段）。始终注入；具体绑定知识库与根目录由
 * {@link buildKbPromptAppend} 追加，绑定变化 → 该段内容变化 → Pi 工具指纹变化（热重建）。
 */
export const KB_SYSTEM_PROMPT =
  "## 知识库（Library）\n" +
  "你有只读知识库工具：kb_read_attachment（读取当前会话附件并转换为可整理内容）、kb_list_roots（列出会话绑定的知识库与来源目录）、kb_search（在绑定知识库的正式文档与来源目录 .md/.txt 内关键词检索，返回带来源与摘录的命中）、kb_get（按 documentId 读取正式文档全文，或按 path 读取来源目录内的单个 .md/.txt）、kb_list_available（未挂库时列出本机可能与当前工作相关的库名，仅元数据无正文）。\n" +
  "这些工具仅在会话已绑定的知识库 / 来源目录内检索；未绑定则 kb_list_roots 返回空、kb_search 返回空结果，绝不扫描全盘，也绝不返回正文。\n" +
  "知识库是否主动检索由当前会话的知识范围模式决定。\n" +
  "命中后请在回答中用 [KB: 文档标题] 或 [KB: 相对路径] 标注来源。知识库与你的记忆层完全隔离，不得把检索结果写入任何记忆。\n" +
  "当用户在聊天里上传了附件（.docx/.pdf/.xlsx/.md/.txt/.csv），用户消息里会给出每个附件的 localPath；用 kb_read_attachment(localPath) 读取并解析为结构化文本或各工作表内容，作为整理知识草稿的输入。该工具只读当前会话的附件目录、不写入知识库、不自动保存；过大内容会在 warnings 里说明截断。整理成草稿后仍需用户确认才调用 kb_propose_save；提议保存时应尽量同时提交 draft.summary、draft.sources、draft.warnings、draft.uncertainties，供用户审核。\n" +
  "另有受控写入工具 kb_propose_save：当需要把整理好的结论/统计/公约/规范沉淀为正式文档时，调用它提议保存到当前会话绑定的知识库（须已挂库，且 knowledgeBaseId 必须是绑定列表里的库）。这是「提议保存」而非「直接写入」：调用后会弹确认横幅，用户确认后才会写入，工具返回 ok:true 才算保存成功。禁止凭空声称已保存；未挂库时不要调用本工具。可选 kind 标注类型：接口公约 contract、规范 norm、统计/常识快照 snapshot（自动记探查时间）、普通笔记 note 或省略。";

/** 读取会话当前绑定信息（调用时读 meta，非 spawn 快照） */
function bindingForSession(sessionId: string): {
  knowledgeBaseIds: string[];
  kbRoots: string[];
} {
  const meta = getSessionMeta(sessionId);
  if (!meta) return { knowledgeBaseIds: [], kbRoots: [] };
  return {
    knowledgeBaseIds: Array.isArray(meta.knowledgeBaseIds)
      ? meta.knowledgeBaseIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
      : [],
    kbRoots: resolveKnowledgeBaseRootsForSession(meta),
  };
}

/** 把 {@link KnowledgeBaseRecord} 映射为可发现条目（仅元数据，无正文） */
function toAvailableEntry(
  kb: KnowledgeBaseRecord,
  related: boolean,
): KbAvailableEntry {
  return {
    id: kb.id,
    name: kb.name,
    ...(kb.description?.trim() ? { description: kb.description.trim() } : {}),
    related,
  };
}

/** 「最近使用」兜底上限（无关联库时，从未挂库会话扫 knowledgeBaseIds 取最多 3 个） */
const RECENT_AVAILABLE_LIMIT = 3;

/**
 * 计算未挂库时「可发现」的库列表（刀 3，仅元数据）。
 *
 * - 已挂库（有 knowledgeBaseIds 或 kbRoots）：available=[]，检索仍只用绑定集。
 * - 未挂库：available = relatedWorkspaceIds 含当前 session.workspaceId 的库（related=true）；
 *   若无关联库，则从未挂库会话 metas 扫 knowledgeBaseIds 按「最近使用」取最多 3 个兜底
 *   （related=false）。
 * - 绝不返回文档标题列表或正文摘录。
 *
 * 供 kb_list_available 工具与 buildKbPromptAppend 复用，单一真源。
 */
export function resolveAvailableKnowledgeBases(
  sessionId: string,
): KbAvailableResult {
  const { knowledgeBaseIds, kbRoots } = bindingForSession(sessionId);
  const bound = knowledgeBaseIds.length > 0 || kbRoots.length > 0;
  if (bound) return { bound: true, available: [] };

  const workspaceId = getSessionMeta(sessionId)?.workspaceId;
  const allKbs = listKnowledgeBases();

  // 关联库：relatedWorkspaceIds 含当前 workspaceId（workspaceId 缺省则无关联库）
  const relatedKbs = workspaceId
    ? allKbs.filter((kb) => {
        const ids = Array.isArray(kb.relatedWorkspaceIds)
          ? kb.relatedWorkspaceIds
          : [];
        return ids.some((id) => typeof id === "string" && id.trim() === workspaceId);
      })
    : [];
  if (relatedKbs.length > 0) {
    return {
      bound: false,
      available: relatedKbs.map((kb) => toAvailableEntry(kb, true)),
    };
  }

  // 无关联库 → 「最近使用」兜底：从未挂库会话 metas 扫 knowledgeBaseIds，
  // 按「最近一次引用该库的会话 updatedAt」倒序取最多 3 个（频次作次序兜底）。
  const recent = computeRecentlyUsedKnowledgeBases(allKbs, RECENT_AVAILABLE_LIMIT);
  return {
    bound: false,
    available: recent.map((kb) => toAvailableEntry(kb, false)),
  };
}

/**
 * 从会话 metas 扫 knowledgeBaseIds，按「最近使用」排序取前 N 个知识库。
 * - 仅扫未挂库会话也行，但更稳的做法是扫所有会话（用户最近在别的会话挂过也算「最近用」）。
 * - 每个 kbId 取引用它的会话里最大的 updatedAt（最近用时间）；频次（引用会话数）作次序兜底。
 * - 只返回仍存在的库（listKnowledgeBases 交集）。
 * 纯函数风格，便于单测（依赖 listSessions() 的可注入性靠模块 mock）。
 */
function computeRecentlyUsedKnowledgeBases(
  allKbs: KnowledgeBaseRecord[],
  limit: number,
): KnowledgeBaseRecord[] {
  if (allKbs.length === 0 || limit <= 0) return [];
  const kbById = new Map(allKbs.map((kb) => [kb.id, kb] as const));
  // kbId → { lastUsedAt, count }
  const stats = new Map<string, { lastUsedAt: number; count: number }>();
  for (const session of listSessions({ includeHidden: true })) {
    const ids = Array.isArray(session.knowledgeBaseIds)
      ? session.knowledgeBaseIds
      : [];
    const updatedAt =
      typeof session.updatedAt === "number" ? session.updatedAt : 0;
    for (const id of ids) {
      if (typeof id !== "string" || !id.trim()) continue;
      const cur = stats.get(id);
      if (cur) {
        cur.count += 1;
        if (updatedAt > cur.lastUsedAt) cur.lastUsedAt = updatedAt;
      } else {
        stats.set(id, { lastUsedAt: updatedAt, count: 1 });
      }
    }
  }
  const ranked = [...stats.entries()]
    .filter(([id]) => kbById.has(id))
    .sort(
      (a, b) =>
        b[1].lastUsedAt - a[1].lastUsedAt || b[1].count - a[1].count,
    )
    .slice(0, limit)
    .map(([id]) => kbById.get(id)!);
  return ranked;
}

/**
 * 构建知识库系统提示词段（静态指引 + 当前绑定知识库与来源目录清单）。
 * 绑定变化 → 返回串变化 → 注入到 Pi systemPromptAppend / kscc systemPrompt.append，
 * 使工具指纹随绑定变化（Pi 热重建 Agent；kscc 由 session-service 检测后 re-spawn）。
 *
 * P1-1：有 knowledgeBaseIds 或 roots 任一非空即算已绑定（preferred/strict 才能生效），
 * 不再只看来源目录路径；有 knowledgeBaseIds 时列出库名与文档数（不必列全文）。
 *
 * 刀 3：未绑定时由调用方传入 `available`（仅元数据的可发现库列表，来自
 * {@link resolveAvailableKnowledgeBases}），本函数据此注入「口头轻问」规则——
 * 可荐库名、不教怎么挂、拒绝后不再荐、未挂不可偷读正文。已绑定时一句带过「无需再推荐」。
 */
export function buildKbPromptAppend(input: {
  kbRoots?: string[] | undefined;
  knowledgeBaseIds?: string[] | undefined;
  mode?: KnowledgeBaseMode | undefined;
  /** 是否允许 Agent 提议写入正式文档；未传时保持开发工具的兼容默认值。 */
  knowledgeBaseWritesEnabled?: boolean | undefined;
  /** 未绑定时可发现的库（仅元数据；已绑定时该字段被忽略） */
  available?: KbAvailableEntry[] | undefined;
}): string {
  const mode: KnowledgeBaseMode = input.mode ?? "off";
  const knowledgeBaseWritesEnabled = input.knowledgeBaseWritesEnabled ?? true;
  const roots = normalizeKbRoots(input.kbRoots);
  const kbIds = Array.isArray(input.knowledgeBaseIds)
    ? input.knowledgeBaseIds
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean)
    : [];
  const bound = roots.length > 0 || kbIds.length > 0;
  const effectiveMode: KnowledgeBaseMode =
    bound && (mode === "preferred" || mode === "strict") ? mode : "off";
  if (!bound) {
    const available = Array.isArray(input.available) ? input.available : [];
    const parts: string[] = [
      KB_SYSTEM_PROMPT,
      "\n当前会话未绑定知识库：kb_list_roots 返回空，kb_search / kb_get 返回空或报错，kb_propose_save 会直接报错（请先挂库）。",
      "\n未挂库时禁止把任何知识库内容当作答案依据；也不要调用 kb_search / kb_get / kb_propose_save 指望读到正文（调用会返回空或报错）。",
    ];
    if (available.length > 0) {
      const lines = available
        .map(
          (kb) =>
            `- 《${kb.name}》${kb.description ? "：" + kb.description : ""}${
              kb.related ? "（关联当前工作区）" : "（最近使用）"
            }`,
        )
        .join("\n");
      parts.push(
        `\n本机存在可能与当前工作相关的知识库（仅库名与一句话描述，未挂载不可读正文）：\n${lines}`,
      );
      parts.push(
        "\n口头轻问规则（刀 3）：" +
          "\n- 仅当用户问题明显依赖项目规范 / 公约 / 资源统计等本地项目知识时，可口头问一句「是否需要挂上《某库》参考」，不要主动展开或复述库内内容。" +
          "\n- 不要说明如何挂载（不要教操作步骤、不要说去哪个菜单），除非用户明确问「怎么挂」。" +
          "\n- 用户拒绝、表示不用、或忽略后继续聊别的 → 本会话不要再推荐挂载。" +
          "\n- 未挂上前禁止把知识库内容当作答案依据；也不要调用 kb_search / kb_get / kb_propose_save 指望读到正文（调用会返回空或报错）。用户口头同意挂上也不算已挂——必须由用户在「+」里操作，你只问不代挂。",
      );
    } else {
      parts.push(
        "\n本机没有可与当前工作关联的知识库可推荐；不要主动建议用户挂载，也不要教如何挂载。",
      );
    }
    return parts.join("");
  }
  const policy =
    effectiveMode === "strict"
      ? "当前模式：仅使用（strict）。回答前必须先调用 kb_search；回答只能依据检索到的知识库内容。没有足够依据时请明确说明知识库中没有找到答案，不得用常识猜测或伪装成知识库结论。"
      : effectiveMode === "preferred"
        ? "当前模式：优先使用（preferred）。回答前必须先调用 kb_search；知识库命中内容优先，结果不足时可以使用通用能力，但必须明确区分知识库依据与通用补充。"
        : "当前模式：不主动使用（off）。知识库工具可用，但只在用户明确要求或问题明显涉及绑定资料时调用。";

  const parts: string[] = [KB_SYSTEM_PROMPT, `\n${policy}`];
  // 已绑定：无需再向用户推荐挂载（刀 3）
  parts.push("\n当前会话已挂载知识库，无需再向用户推荐挂载，也不要教如何挂载。");

  // 知识库正式文档
  if (kbIds.length > 0) {
    const kbs = listKnowledgeBases().filter((kb) => kbIds.includes(kb.id));
    const docs = listKnowledgeBaseDocumentsForIds(kbIds);
    const countByKb = new Map<string, number>();
    for (const doc of docs) {
      countByKb.set(
        doc.knowledgeBaseId,
        (countByKb.get(doc.knowledgeBaseId) ?? 0) + 1,
      );
    }
    const kbLines = kbs
      .map(
        (kb) =>
          `- ${kb.name}（id=${kb.id}）：${countByKb.get(kb.id) ?? 0} 篇正式文档`,
      )
      .join("\n");
    parts.push(
      `\n当前会话绑定的知识库（${kbs.length} 个，正式文档共 ${docs.length} 篇）：\n${kbLines}`,
    );
    parts.push("可在这些知识库的正式文档内用 kb_search 检索；用 kb_get(documentId) 读取命中的文档全文。");
    parts.push(
      "文档可能带 kind 标注（note 笔记 / contract 接口约定 / norm 规范 / snapshot 常识快照）；kb_search 与 kb_get 的 document 命中都会带 kind。" +
        "查用法 / 接口约定 / 规范 / 项目常识时优先关注 contract、norm、snapshot 这类短卡，按需用 kb_get 读全文；长 note 仅作补充，不要把整篇长文当公约复述。",
    );
    parts.push(
      knowledgeBaseWritesEnabled
        ? "需要把整理好的结论/公约/统计/规范沉淀为正式文档时，调用 kb_propose_save(knowledgeBaseId, title, content, kind?, draft?) 提议保存到上述某个绑定库：接口公约用 kind:contract，规范用 norm，统计/常识快照用 snapshot（会自动记探查时间），普通笔记可省略 kind。请同时传 draft.summary、draft.sources、draft.warnings、draft.uncertainties 供用户审核。用户确认后才写入，只有工具返回 ok:true 才算保存成功，禁止凭空声称已保存。"
        : "当前版本暂不允许知识库文档写入；不要调用 kb_propose_save，也不要声称已保存任何知识库文档。",
    );
  }

  // 来源目录
  if (roots.length > 0) {
    const rootLines = roots
      .map((r) => `- ${r.label}（rootId=${r.id}）：${r.path}`)
      .join("\n");
    parts.push(`\n当前会话绑定的来源目录（${roots.length} 个）：\n${rootLines}`);
    parts.push("可在这些来源目录的 .md/.txt 内用 kb_search 检索；用 kb_get(path) 读取命中的单文件全文。");
  }
  return parts.join("");
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }] };
}

function piText(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details: {} };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * 读取 Agent 提交的结构化草稿元数据。
 * 这是确认前的临时请求数据，做长度和类型收敛，避免坏参数撑爆 UI 或存储。
 */
function parseStructuredDraft(value: unknown): KnowledgeBaseStructuredDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const trimList = (input: unknown, maxItems: number, maxChars: number): string[] =>
    Array.isArray(input)
      ? input
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, maxChars))
          .filter(Boolean)
          .slice(0, maxItems)
      : [];
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 500) : "";
  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          label: typeof item.label === "string" ? item.label.trim().slice(0, 300) : "",
          ...(typeof item.location === "string" && item.location.trim()
            ? { location: item.location.trim().slice(0, 300) }
            : {}),
        }))
        .filter((item) => item.label)
        .slice(0, 20)
    : [];
  const warnings = trimList(raw.warnings, 20, 500);
  const uncertainties = trimList(raw.uncertainties, 20, 500);
  if (!summary && sources.length === 0 && warnings.length === 0 && uncertainties.length === 0) {
    return undefined;
  }
  return {
    ...(summary ? { summary } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(uncertainties.length > 0 ? { uncertainties } : {}),
  };
}

// ── handlers ──────────────────────────────────────────

export async function handleKbListRoots(
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { knowledgeBaseIds, kbRoots } = bindingForSession(ctx.sessionId);
  const idx = getDefaultKbIndex();
  const roots = idx.listRoots(kbRoots);
  const kbs =
    knowledgeBaseIds.length > 0
      ? listKnowledgeBases().filter((kb) => knowledgeBaseIds.includes(kb.id))
      : [];
  const docs = listKnowledgeBaseDocumentsForIds(knowledgeBaseIds);
  const countByKb = new Map<string, number>();
  for (const doc of docs) {
    countByKb.set(
      doc.knowledgeBaseId,
      (countByKb.get(doc.knowledgeBaseId) ?? 0) + 1,
    );
  }
  return textResult(
    json({
      count: roots.length,
      roots: roots.map((r) => ({ id: r.id, label: r.label, path: r.path })),
      knowledgeBases: kbs.map((kb) => ({
        id: kb.id,
        name: kb.name,
        documentCount: countByKb.get(kb.id) ?? 0,
      })),
      documentCount: docs.length,
    }),
  );
}

/**
 * kb_list_available 处理器（刀 3 · 只读，未挂库时的「可发现」元数据）。
 *
 * 返回 {@link KbAvailableResult}：当前是否已挂库 + 未挂时可发现的库（仅 id/name/description/related）。
 * 绝不返回文档标题列表或正文摘录；已挂库时 available 为空（检索仍只用绑定集）。
 */
export async function handleKbListAvailable(
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return textResult(json(resolveAvailableKnowledgeBases(ctx.sessionId)));
}

export async function handleKbSearch(
  args: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = String(args.query ?? "").trim();
  if (!query) return textResult(json({ error: "query 不能为空" }));
  const { knowledgeBaseIds, kbRoots } = bindingForSession(ctx.sessionId);
  const rootId =
    typeof args.rootId === "string" && args.rootId.trim()
      ? args.rootId.trim()
      : undefined;
  const limit = clampSearchLimit(
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? args.limit
      : undefined,
  );
  const keywords = tokenize(query);

  // 目录命中（rootId 仅过滤目录；文档不归属 root）
  const idx = getDefaultKbIndex();
  const dirHits: KbDirectoryHit[] = kbRoots.length > 0
    ? idx.search(kbRoots, query, { rootId, limit })
    : [];

  const hits: KbUnifiedSearchHit[] = dirHits.map((h) => ({
    source: "directory",
    title: h.title,
    score: h.score,
    excerpt: h.excerpt,
    matchedIn: h.matchedIn,
    rootId: h.rootId,
    rootLabel: h.rootLabel,
    relativePath: h.relativePath,
    absolutePath: h.absolutePath,
  }));

  // 正式文档命中（与 fs-index 同类打分；多库只命中会话授权的 knowledgeBaseIds）
  if (knowledgeBaseIds.length > 0 && keywords.length > 0) {
    const docHits = searchKnowledgeBaseDocuments({
      knowledgeBaseIds,
      query,
      limit,
    });
    for (const dh of docHits) {
      hits.push({
        source: "document",
        knowledgeBaseId: dh.knowledgeBaseId,
        documentId: dh.documentId,
        ...(dh.chunkId ? { chunkId: dh.chunkId } : {}),
        kind: dh.kind,
        title: dh.title,
        score: dh.score,
        excerpt: dh.excerpt,
        matchedIn: dh.matchedIn,
        ...(dh.section ? { section: dh.section } : {}),
        ...(dh.sourcePosition ? { sourcePosition: dh.sourcePosition } : {}),
      });
    }
  }

  // 合并后按 score 降序、标题字典序兜底，统一 limit 截断
  hits.sort(
    (a, b) => b.score - a.score || a.title.localeCompare(b.title),
  );
  const capped = hits.slice(0, limit);
  return textResult(json({ count: capped.length, hits: capped }));
}

export async function handleKbGet(
  args: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const documentId =
    typeof args.documentId === "string" ? args.documentId.trim() : "";
  const path = String(args.path ?? "").trim();
  if (!documentId && !path) {
    return textResult(json({ error: "documentId 或 path 不能为空" }));
  }
  const { knowledgeBaseIds } = bindingForSession(ctx.sessionId);

  // 优先按 documentId 读取正式文档（须属会话绑定库）
  if (documentId) {
    const doc = getKnowledgeBaseDocument(documentId);
    if (doc) {
      if (!knowledgeBaseIds.includes(doc.knowledgeBaseId)) {
        return textResult(
          json({ error: "文档不在当前会话绑定的知识库内（已拒绝越权读取）" }),
        );
      }
      return textResult(
        json({
          source: "document",
          knowledgeBaseId: doc.knowledgeBaseId,
          documentId: doc.id,
          title: doc.title,
          content: doc.content,
          size: doc.content.length,
          truncated: false,
          // 刀 2：document 命中带 kind（旧文档无 kind 归一为 note）；snapshot/originNote 按需带
          kind: normalizeKnowledgeBaseDocumentKind(doc.kind),
          ...(doc.snapshotAt ? { snapshotAt: doc.snapshotAt } : {}),
          ...(doc.originNote ? { originNote: doc.originNote } : {}),
          ...(doc.summary ? { summary: doc.summary } : {}),
          ...(doc.sources?.length ? { sources: doc.sources } : {}),
          ...(doc.parseWarnings?.length
            ? { parseWarnings: doc.parseWarnings }
            : {}),
          ...(doc.uncertainties?.length
            ? { uncertainties: doc.uncertainties }
            : {}),
          ...(doc.author ? { author: doc.author } : {}),
          ...(doc.status ? { status: doc.status } : {}),
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}),
          ...(doc.sourceProvider ? { sourceProvider: doc.sourceProvider } : {}),
          ...(doc.sourceExternalId ? { sourceExternalId: doc.sourceExternalId } : {}),
          ...(doc.sourceAccessMode ? { sourceAccessMode: doc.sourceAccessMode } : {}),
          ...(doc.sourceSyncedAt ? { sourceSyncedAt: doc.sourceSyncedAt } : {}),
        }),
      );
    }
    if (!path) {
      return textResult(json({ error: "找不到该文档（documentId 无效）" }));
    }
  }

  // 回退：按 path 读取来源目录内单文件（防路径穿越）
  const idx = getDefaultKbIndex();
  const { kbRoots } = bindingForSession(ctx.sessionId);
  const res = idx.getFile(kbRoots, path);
  if (!res) {
    return textResult(
      json({
        error:
          "文件不在已绑定的知识库根目录内，或不存在 / 非 .md/.markdown/.txt（已拒绝路径穿越）",
      }),
    );
  }
  return textResult(json({ source: "directory", ...res }));
}

/**
 * kb_propose_save 处理器（受控写入，刀 1）。
 *
 * 先做全部校验（失败立即返回 error JSON，不弹 UI）：
 * - knowledgeBaseId / title / content 非空
 * - 会话已绑定库且 knowledgeBaseId ∈ 绑定列表（越权拒绝）
 * - 目标库存在
 * - 已配置 sendToRenderer（否则无法门控，绝不静默写入）
 *
 * 校验通过后委托 kbProposeSaveService 弹横幅等用户确认：
 * - confirm → 写入正式文档 → { ok:true, documentId, knowledgeBaseId, title }
 * - reject → { ok:false, reason:"user_rejected" }（零写入）
 * - abort（会话停止 / run 中止）→ { ok:false, reason:"aborted" }（零写入）
 * - 写入失败（罕见竞态）→ { ok:false, reason:"write_failed", error }
 *
 * 门控逻辑放在 execute 内（非 canUseTool），双核统一走同一段 await。
 */
export async function handleKbProposeSave(
  args: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (ctx.knowledgeBaseWritesEnabled !== true) {
    return textResult(json({ error: KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE }));
  }
  const knowledgeBaseId =
    typeof args.knowledgeBaseId === "string" ? args.knowledgeBaseId.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const content = typeof args.content === "string" ? args.content : "";
  const rawKind = args.kind;
  const kind: KbProposeSaveKind | undefined =
    rawKind === "note" || rawKind === "contract" || rawKind === "norm" || rawKind === "snapshot"
      ? (rawKind as KbProposeSaveKind)
      : undefined;
  const draft = parseStructuredDraft(args.draft);

  if (!knowledgeBaseId) {
    return textResult(json({ error: "knowledgeBaseId 不能为空" }));
  }
  if (!title) {
    return textResult(json({ error: "title 不能为空（或仅空白）" }));
  }
  if (!content.trim()) {
    return textResult(json({ error: "content 不能为空（或仅空白）" }));
  }

  const { knowledgeBaseIds } = bindingForSession(ctx.sessionId);
  if (knowledgeBaseIds.length === 0) {
    return textResult(
      json({ error: "当前会话未绑定任何知识库，无法提议保存（请先挂库）" }),
    );
  }
  if (!knowledgeBaseIds.includes(knowledgeBaseId)) {
    return textResult(
      json({
        error:
          "knowledgeBaseId 不在当前会话绑定的知识库列表内（已拒绝越权写入）",
      }),
    );
  }
  if (!listKnowledgeBases().some((kb) => kb.id === knowledgeBaseId)) {
    return textResult(json({ error: "目标知识库不存在" }));
  }
  if (!ctx.sendToRenderer) {
    return textResult(
      json({ error: "未配置 propose-save 确认通道，无法安全写入（已拒绝静默写入）" }),
    );
  }

  const result = await kbProposeSaveService.handleProposeSave(
    ctx.sessionId,
    {
      knowledgeBaseId,
      title,
      content,
      ...(kind ? { kind } : {}),
      ...(draft ? { draft } : {}),
    },
    { signal: ctx.signal, sendToRenderer: ctx.sendToRenderer },
  );
  return textResult(json(result));
}

/**
 * kb_read_attachment 处理器（主线第一步 · 只读附件解析，零写入）。
 *
 * 读取并解析「当前会话」刚上传的附件（.docx/.pdf/.xlsx/.md/.markdown/.txt/.csv）为
 * 统一中间格式，供 Agent 整理成结构化知识草稿。不写知识库、不自动保存。
 *
 * 校验顺序（失败立即返回 error JSON，绝不读盘外文件）：
 * 1. localPath 非空
 * 2. 扩展名属于支持集合（否则清晰错误，无需文件存在）
 * 3. {@link resolveSessionAttachmentPath} 会话隔离 + 路径穿越 + 符号链接 + 存在性
 * 4. {@link parseAttachmentFile} 复用已有 DOCX/PDF/XLSX 解析逻辑
 *
 * 返回稳定 JSON：filename（存储名）、extension、mediaType、content（文本类）或
 * sheets（xlsx，保留各表名与内容）、truncated、warnings。过大内容截断时 warnings 明确告知。
 */
export async function handleKbReadAttachment(
  args: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const localPath = typeof args.localPath === "string" ? args.localPath.trim() : "";
  if (!localPath) {
    return textResult(json({ error: "localPath 不能为空" }));
  }
  // 统一分隔符后取末段做扩展名 / 存储名推断（OS 无关）
  const normalized = localPath.replace(/\\/g, "/").trim();
  const lastSegment = normalized.split("/").filter(Boolean).pop() ?? "";
  const ext = (lastSegment.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
  if (!isSupportedAttachmentExt(ext)) {
    return textResult(
      json({
        error: `不支持的附件格式：${ext || "无扩展名"}（kb_read_attachment 支持 .docx / .pdf / .xlsx / .md / .markdown / .txt / .csv）`,
      }),
    );
  }

  const absolutePath = resolveSessionAttachmentPath(ctx.sessionId, localPath);
  if (!absolutePath) {
    return textResult(
      json({
        error:
          "附件不可读：localPath 路径越界、不属于当前会话或文件不存在（已拒绝）",
      }),
    );
  }

  let parsed: Awaited<ReturnType<typeof parseAttachmentFile>>;
  try {
    parsed = await parseAttachmentFile(absolutePath);
  } catch (err) {
    return textResult(
      json({ error: err instanceof Error ? err.message : String(err) }),
    );
  }

  const anySheetTruncated = parsed.sheets.some((sheet) => sheet.truncated);
  const result: Record<string, unknown> = {
    localPath: normalized,
    filename: lastSegment,
    extension: ext,
    mediaType: attachmentMediaType(ext),
    truncated: parsed.truncated || anySheetTruncated,
    warnings: parsed.warnings,
  };
  if (parsed.truncated) {
    result.originalLength = parsed.originalLength;
  }
  // xlsx 返回 sheets（保留多表名与各表内容）；其余返回 content。二者互斥，便于 Agent 整理。
  if (parsed.sheets.length > 0) {
    result.sheets = parsed.sheets;
  } else {
    result.content = parsed.content;
  }
  return textResult(json(result));
}

// ── Pi tools ──────────────────────────────────────────

export function buildPiKbTools(ctx: KbToolContext): AgentTool[] {
  return [
    {
      name: "kb_list_roots",
      label: "kb_list_roots",
      description:
        "列出当前会话绑定的知识库（正式文档，含 id/name/documentCount）与来源目录（id/label/path）。未绑定则返回空。",
      parameters: Type.Object({}),
      execute: async () =>
        piText((await handleKbListRoots(ctx)).content[0]!.text),
    },
    {
      name: "kb_list_available",
      label: "kb_list_available",
      description:
        "未挂库时列出本机可能与当前工作相关的知识库（仅 id/name/description/related 元数据，无正文、无文档标题列表）。已挂库时 available 为空。用于口头轻问是否挂上参考，未挂前不得据此回答正文。",
      parameters: Type.Object({}),
      execute: async () =>
        piText((await handleKbListAvailable(ctx)).content[0]!.text),
    },
    {
      name: "kb_search",
      label: "kb_search",
      description:
        "在已绑定知识库的正式文档与来源目录 .md/.txt 内关键词检索，返回带 source(document/directory)、documentId/路径、标题与短摘录的命中列表。未绑定则返回空。可选 rootId 限定单根（仅目录），limit 限定返回数（默认 10，最大 50）。",
      parameters: Type.Object({
        query: Type.String({ description: "关键词（空白/标点分词，OR 语义）" }),
        rootId: Type.Optional(
          Type.String({
            description: "限定单个来源目录（= kb_list_roots 返回的 rootId；不影响正式文档命中）",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "返回上限，默认 10，最大 50" }),
        ),
      }),
      execute: async (_id, params) =>
        piText(
          (await handleKbSearch(params as Record<string, unknown>, ctx))
            .content[0]!.text,
        ),
    },
    {
      name: "kb_get",
      label: "kb_get",
      description:
        "读取单条知识库内容全文。优先按 documentId 读取正式文档（须属会话绑定的知识库）；或按 path 读取来源目录内的单个 .md/.txt（须在已绑定根目录内，路径穿越会被拒绝）。documentId 与 path 至少给一个。",
      parameters: Type.Object({
        documentId: Type.Optional(
          Type.String({
            description: "正式文档 id（优先；来自 kb_search 的 document 命中）",
          }),
        ),
        path: Type.Optional(
          Type.String({
            description: "来源目录内的绝对路径或相对路径（来自 kb_search 的 directory 命中）",
          }),
        ),
      }),
      execute: async (_id, params) =>
        piText(
          (await handleKbGet(params as Record<string, unknown>, ctx))
            .content[0]!.text,
        ),
    },
    {
      name: "kb_read_attachment",
      label: "kb_read_attachment",
      description:
        "读取并解析当前会话刚上传的附件（.docx/.pdf/.xlsx/.md/.markdown/.txt/.csv）为结构化文本或各工作表内容，供后续整理成知识草稿。只读，不写入知识库、不自动保存。localPath 为附件相对路径（来自聊天附件注入，形如 {sessionId}/{uuid}.{ext}）；仅允许当前会话目录内附件，路径穿越/其它会话/不存在/符号链接逃逸会被拒绝。XLSX 保留各工作表名与内容；过大内容会在 warnings 中说明截断，不静默截断。",
      parameters: Type.Object({
        localPath: Type.String({
          description:
            "附件相对路径（来自聊天附件注入的 localPath，形如 {sessionId}/{uuid}.{ext}）",
        }),
      }),
      execute: async (_id, params) =>
        piText(
          (await handleKbReadAttachment(params as Record<string, unknown>, ctx))
            .content[0]!.text,
        ),
    },
    {
      name: "kb_propose_save",
      label: "kb_propose_save",
      description:
        "提议把整理好的结论/统计/公约/规范作为正式文档保存到当前会话绑定的知识库（受控写入）。调用后会弹出确认横幅，用户确认后才写入；只有工具返回 ok:true 才算保存成功，禁止凭空声称已保存。未挂库、knowledgeBaseId 不在绑定列表、标题/正文为空会直接报错（不弹横幅）。可选 kind 标注文档类型：接口公约用 contract、规范用 norm、统计/常识快照用 snapshot（自动记探查时间）、普通笔记用 note 或省略。",
      parameters: Type.Object({
        knowledgeBaseId: Type.String({
          description: "目标知识库 id（必须 ∈ 当前会话绑定的 knowledgeBaseIds；可用 kb_list_roots 查询）",
        }),
        title: Type.String({ description: "文档标题（trim 后非空）" }),
        content: Type.String({ description: "Markdown 正文（trim 后非空）" }),
        draft: Type.Optional(
          Type.Object({
            summary: Type.Optional(Type.String({ description: "草稿摘要" })),
            sources: Type.Optional(
              Type.Array(
                Type.Object({
                  label: Type.String({ description: "来源名称" }),
                  location: Type.Optional(Type.String({ description: "页码、工作表、章节或行号" })),
                }),
              ),
            ),
            warnings: Type.Optional(Type.Array(Type.String({ description: "解析警告" }))),
            uncertainties: Type.Optional(Type.Array(Type.String({ description: "待确认内容" }))),
          }),
        ),
        kind: Type.Optional(
          Type.Union(
            [
              Type.Literal("note"),
              Type.Literal("contract"),
              Type.Literal("norm"),
              Type.Literal("snapshot"),
            ],
            { description: "可选文档类型标注（note 笔记 / contract 公约 / norm 规范 / snapshot 快照）" },
          ),
        ),
      }),
      execute: async (_id, params) =>
        piText(
          (await handleKbProposeSave(params as Record<string, unknown>, ctx))
            .content[0]!.text,
        ),
    },
  ];
}

// ── kscc MCP 注入 ─────────────────────────────────────

export async function injectKbMcpServer(
  mcpServers: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<void> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    sdk.tool(
      "kb_list_roots",
      "列出当前会话绑定的知识库（正式文档，含 id/name/documentCount）与来源目录（id/label/path）。未绑定则返回空。",
      {},
      async () => handleKbListRoots(ctx),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      "kb_list_available",
      "未挂库时列出本机可能与当前工作相关的知识库（仅 id/name/description/related 元数据，无正文、无文档标题列表）。已挂库时 available 为空。用于口头轻问是否挂上参考，未挂前不得据此回答正文。",
      {},
      async () => handleKbListAvailable(ctx),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      "kb_search",
      "在已绑定知识库的正式文档与来源目录 .md/.txt 内关键词检索，返回带 source(document/directory)、documentId/路径、标题与短摘录的命中列表。未绑定则返回空。",
      {
        query: z.string(),
        rootId: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args: Record<string, unknown>) => handleKbSearch(args, ctx),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      "kb_get",
      "读取单条知识库内容全文。优先按 documentId 读取正式文档（须属会话绑定的知识库）；或按 path 读取来源目录内的单个 .md/.txt（路径穿越会被拒绝）。documentId 与 path 至少给一个。",
      {
        documentId: z.string().optional(),
        path: z.string().optional(),
      },
      async (args: Record<string, unknown>) => handleKbGet(args, ctx),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      "kb_read_attachment",
      "读取并解析当前会话刚上传的附件（.docx/.pdf/.xlsx/.md/.markdown/.txt/.csv）为结构化文本或各工作表内容，供后续整理成知识草稿。只读，不写入知识库、不自动保存。localPath 为附件相对路径（形如 {sessionId}/{uuid}.{ext}）；仅允许当前会话目录内附件，路径穿越/其它会话/不存在/符号链接逃逸会被拒绝。XLSX 保留各工作表名与内容；过大内容会在 warnings 中说明截断，不静默截断。",
      {
        localPath: z.string(),
      },
      async (args: Record<string, unknown>) => handleKbReadAttachment(args, ctx),
      { annotations: { readOnlyHint: true } },
    ),
    // 受控写入（刀 1）：不挂 readOnlyHint。门控在 execute 内 await，不依赖 canUseTool 覆盖 MCP 工具。
    sdk.tool(
      "kb_propose_save",
      "提议把整理好的结论/统计/公约/规范作为正式文档保存到当前会话绑定的知识库（受控写入）。调用后弹出确认横幅，用户确认后才写入；只有工具返回 ok:true 才算保存成功，禁止凭空声称已保存。未挂库、knowledgeBaseId 不在绑定列表、标题/正文为空会直接报错（不弹横幅）。可选 kind 标注文档类型：接口公约用 contract、规范用 norm、统计/常识快照用 snapshot（自动记探查时间）、普通笔记用 note 或省略。",
      {
        knowledgeBaseId: z.string(),
        title: z.string(),
        content: z.string(),
        draft: z
          .object({
            summary: z.string().optional(),
            sources: z.array(z.object({ label: z.string(), location: z.string().optional() })).optional(),
            warnings: z.array(z.string()).optional(),
            uncertainties: z.array(z.string()).optional(),
          })
          .optional(),
        kind: z.enum(["note", "contract", "norm", "snapshot"]).optional(),
      },
      async (args: Record<string, unknown>) => handleKbProposeSave(args, ctx),
    ),
  ];
  mcpServers.kb = sdk.createSdkMcpServer({
    name: "kb",
    version: "1.0.0",
    tools,
  });
}
