/**
 * 知识库 Agent 工具（Phase 0 · 只读检索，dual-mount）
 *
 * - kb_list_roots：列出会话绑定的知识库根目录
 * - kb_search({ query, rootId?, limit? })：在已绑定 roots 的 .md/.txt 内关键词检索，命中带来源路径 + 摘录
 * - kb_get({ path })：按路径读单文件（须在已绑定 root 内，防路径穿越）
 *
 * 全部只读（readOnlyHint）。Chat / Work 均可用（不挂 Work 门控）。
 * kscc：createSdkMcpServer 注入 mcpServers.kb；Pi：TypeBox AgentTool 列表 extraTools。
 * 仿 kanban-agent-tools.ts / browser-agent-tools.ts 的 dual-mount 形态。
 *
 * 处理器在调用时读会话 meta.kbRoots（非 spawn 时快照），故绑定变化对工具行为即时生效；
 * 绑定变化对「工具指纹 / 长驻进程配置」的影响由 session-service 负责（Pi 热重建 / kscc re-spawn）。
 * 与 L0–L5 记忆 / BotMemory 物理隔离：KB 零写入。
 *
 * @see docs/dev/knowledge-base/KB-PRODUCT-SPEC-v1.md §5 Phase 0 / §6 工具契约
 * @see docs/dev/knowledge-base/KB-PHASE0-brief.md
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { KnowledgeBaseMode } from "@tagent/shared";
import { getSessionMeta } from "../agent/session-store";
import { getDefaultKbIndex, normalizeKbRoots } from "./kb-fs-index";
import { resolveKnowledgeBaseRootsForSession } from "./knowledge-base-store";

export interface KbToolContext {
  sessionId: string;
}

/**
 * 知识库工具系统提示词（静态指引段）。始终注入；具体绑定根目录由
 * {@link buildKbPromptAppend} 追加，绑定变化 → 该段内容变化 → Pi 工具指纹变化（热重建）。
 */
export const KB_SYSTEM_PROMPT =
  "## 知识库（Library）\n" +
  "你有只读知识库工具：kb_list_roots（列出会话绑定的根目录）、kb_search（在绑定根目录的 .md/.txt 内关键词检索，返回带来源路径与摘录）、kb_get（按路径读单个 .md/.txt）。\n" +
  "这些工具仅在会话已绑定的根目录内检索；未绑定则返回空结果，绝不扫描全盘。\n" +
  "知识库是否主动检索由当前会话的知识范围模式决定。\n" +
  "命中后请在回答中用 [KB: 相对路径] 标注来源。知识库与你的记忆层完全隔离，不得把检索结果写入任何记忆。";

/**
 * 构建知识库系统提示词段（静态指引 + 当前绑定根目录清单）。
 * 绑定变化 → 返回串变化 → 注入到 Pi systemPromptAppend / kscc systemPrompt.append，
 * 使工具指纹随绑定变化（Pi 热重建 Agent；kscc 由 session-service 检测后 re-spawn）。
 */
export function buildKbPromptAppend(
  kbRoots: string[] | undefined,
  mode: KnowledgeBaseMode | undefined = "off",
): string {
  const roots = normalizeKbRoots(kbRoots);
  const effectiveMode: KnowledgeBaseMode =
    roots.length > 0 && (mode === "preferred" || mode === "strict")
      ? mode
      : "off";
  if (roots.length === 0) {
    return (
      KB_SYSTEM_PROMPT +
      "\n当前会话未绑定知识库根目录：kb_list_roots 将返回空，kb_search 返回空结果。"
    );
  }
  const lines = roots
    .map((r) => `- ${r.label}（rootId=${r.id}）：${r.path}`)
    .join("\n");
  const policy =
    effectiveMode === "strict"
      ? "当前模式：仅使用（strict）。回答前必须先调用 kb_search；回答只能依据检索到的知识库内容。没有足够依据时请明确说明知识库中没有找到答案，不得用常识猜测或伪装成知识库结论。"
      : effectiveMode === "preferred"
        ? "当前模式：优先使用（preferred）。回答前必须先调用 kb_search；知识库命中内容优先，结果不足时可以使用通用能力，但必须明确区分知识库依据与通用补充。"
        : "当前模式：不主动使用（off）。知识库工具可用，但只在用户明确要求或问题明显涉及绑定资料时调用。";
  return (
    KB_SYSTEM_PROMPT +
    `\n${policy}` +
    `\n当前会话绑定的知识库根目录（${roots.length} 个）：\n${lines}\n` +
    "可在这些根目录的 .md/.txt 内用 kb_search 检索；用 kb_get 读取命中的单文件全文。"
  );
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

/** 读取会话当前绑定的 kbRoots（调用时读 meta，非 spawn 快照） */
function rootsForSession(sessionId: string): string[] {
  const meta = getSessionMeta(sessionId);
  return meta ? resolveKnowledgeBaseRootsForSession(meta) : [];
}

// ── handlers ──────────────────────────────────────────

export async function handleKbListRoots(
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const idx = getDefaultKbIndex();
  const roots = idx.listRoots(rootsForSession(ctx.sessionId));
  return textResult(
    json({
      count: roots.length,
      roots: roots.map((r) => ({ id: r.id, label: r.label, path: r.path })),
    }),
  );
}

export async function handleKbSearch(
  args: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = String(args.query ?? "").trim();
  if (!query) return textResult(json({ error: "query 不能为空" }));
  const idx = getDefaultKbIndex();
  const rootId =
    typeof args.rootId === "string" && args.rootId.trim()
      ? args.rootId.trim()
      : undefined;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? args.limit
      : undefined;
  const hits = idx.search(rootsForSession(ctx.sessionId), query, {
    rootId,
    limit,
  });
  return textResult(json({ count: hits.length, hits }));
}

export async function handleKbGet(
  args: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const path = String(args.path ?? "").trim();
  if (!path) return textResult(json({ error: "path 不能为空" }));
  const idx = getDefaultKbIndex();
  const res = idx.getFile(rootsForSession(ctx.sessionId), path);
  if (!res) {
    return textResult(
      json({
        error:
          "文件不在已绑定的知识库根目录内，或不存在 / 非 .md/.markdown/.txt（已拒绝路径穿越）",
      }),
    );
  }
  return textResult(json(res));
}

// ── Pi tools ──────────────────────────────────────────

export function buildPiKbTools(ctx: KbToolContext): AgentTool[] {
  return [
    {
      name: "kb_list_roots",
      label: "kb_list_roots",
      description:
        "列出当前会话绑定的知识库根目录（id/label/path）。未绑定则返回空列表。",
      parameters: Type.Object({}),
      execute: async () =>
        piText((await handleKbListRoots(ctx)).content[0]!.text),
    },
    {
      name: "kb_search",
      label: "kb_search",
      description:
        "在已绑定知识库根目录的 .md/.txt 内关键词检索，返回带来源路径、标题与短摘录的命中列表。未绑定则返回空。可选 rootId 限定单根，limit 限定返回数。",
      parameters: Type.Object({
        query: Type.String({ description: "关键词（空白/标点分词，OR 语义）" }),
        rootId: Type.Optional(
          Type.String({
            description: "限定单个根目录（= kb_list_roots 返回的 id）",
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
        "按路径读取单个 .md/.txt 全文（须在已绑定根目录内；路径穿越会被拒绝）。path 可为绝对路径或相对某根目录的相对路径。",
      parameters: Type.Object({
        path: Type.String({ description: "绝对路径或相对路径" }),
      }),
      execute: async (_id, params) =>
        piText(
          (await handleKbGet(params as Record<string, unknown>, ctx))
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
      "列出当前会话绑定的知识库根目录（id/label/path）。未绑定则返回空。",
      {},
      async () => handleKbListRoots(ctx),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      "kb_search",
      "在已绑定知识库根目录的 .md/.txt 内关键词检索，返回带来源路径、标题与短摘录的命中列表。未绑定则返回空。",
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
      "按路径读取单个 .md/.txt 全文（须在已绑定根目录内；路径穿越会被拒绝）。",
      { path: z.string() },
      async (args: Record<string, unknown>) => handleKbGet(args, ctx),
      { annotations: { readOnlyHint: true } },
    ),
  ];
  mcpServers.kb = sdk.createSdkMcpServer({
    name: "kb",
    version: "1.0.0",
    tools,
  });
}
