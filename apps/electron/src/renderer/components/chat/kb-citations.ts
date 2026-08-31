/**
 * 知识库引用解析（P1-2 §A）— 纯函数，零 React 依赖，便于 bun:test。
 *
 * 一轮对话里若 Agent 调了 `kb_search`，把命中收敛成可点击来源芯片需要的数据：
 * - document 命中 → 带 knowledgeBaseId / documentId，可点击打开该文档
 * - directory 命中 → 带 relativePath / absolutePath，仅展示路径（本轮不可点）
 *
 * 数据来源是工具结果（tool_result），不是模型文案里的 `[KB: …]`，避免与模型耦合。
 * kb_search 返回结构见 apps/electron/src/main/lib/kb/kb-agent-tools.ts 的 KbUnifiedSearchHit：
 *   { count, hits: [{ source, knowledgeBaseId?, documentId?, title, relativePath?, absolutePath?, … }] }
 *
 * 兼容 MCP 工具名带前缀（kscc 注入时为 `mcp__kb__kb_search`）：name 以 `kb_search` 结尾或
 * 等于即算（前后由 `_` / `:` 分隔）。坏 JSON / 非 search 结果 → 空数组，绝不抛错。
 *
 * @see docs/dev/knowledge-base/KB-P1-2-CITATIONS-brief.md §A
 */

/** 一条可展示的知识库来源引用 */
export type KbCitation = {
  source: "document" | "directory";
  title: string;
  /** document 命中：所属知识库 id（点击打开时用于切到目标库） */
  knowledgeBaseId?: string;
  /** document 命中：文档 id（点击打开时用于选中该文档） */
  documentId?: string;
  /** directory 命中：相对路径（芯片展示） */
  relativePath?: string;
  /** directory 命中：绝对路径（tooltip 展示） */
  absolutePath?: string;
};

/** 跨组件「打开知识库文档」事件名（由 App.tsx 监听并切到知识库 rail） */
export const OPEN_KB_DOCUMENT_EVENT = "tagent:open-knowledge-document";

/** 工具名是否为 kb_search（兼容 MCP 前缀 mcp__kb__kb_search / server:kb_search） */
export function isKbSearchToolName(name: string | undefined): boolean {
  return typeof name === "string" && /(^|[_:])kb_search$/.test(name);
}

/** 容错 JSON.parse：失败返回 null（不抛） */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 tool_result content（string / text blocks / 已解析对象）抽出可解析的 JSON 对象 */
function extractJsonObject(content: unknown): Record<string, unknown> | null {
  // 已是对象（非数组）：直接用（防御某些 adapter 把对象整体塞进 content）
  if (content != null && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  // string 或 text blocks：抽文本再 JSON.parse
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : "",
      )
      .join("\n")
      .trim();
  } else {
    return null;
  }
  if (!text) return null;
  const parsed = tryParseJson(text);
  if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

/** 把一条 kb_search hit 映射成 KbCitation；形状不符返回 null */
function toCitation(hit: unknown): KbCitation | null {
  if (!hit || typeof hit !== "object") return null;
  const h = hit as Record<string, unknown>;
  const source = h.source;
  const title = typeof h.title === "string" ? h.title.trim() : "";

  if (source === "document") {
    const documentId =
      typeof h.documentId === "string" ? h.documentId.trim() : "";
    if (!documentId || !title) return null;
    const knowledgeBaseId =
      typeof h.knowledgeBaseId === "string" && h.knowledgeBaseId.trim()
        ? h.knowledgeBaseId.trim()
        : undefined;
    return {
      source: "document",
      title,
      knowledgeBaseId,
      documentId,
    };
  }
  if (source === "directory") {
    const relativePath =
      typeof h.relativePath === "string" && h.relativePath.trim()
        ? h.relativePath
        : undefined;
    const absolutePath =
      typeof h.absolutePath === "string" && h.absolutePath.trim()
        ? h.absolutePath
        : undefined;
    if (!title && !relativePath && !absolutePath) return null;
    return {
      source: "directory",
      title: title || relativePath || absolutePath || "",
      relativePath,
      absolutePath,
    };
  }
  return null;
}

/** 去重键：document 用 documentId，directory 用 absolutePath|relativePath；无则空串（不去重） */
function dedupKey(c: KbCitation): string {
  if (c.source === "document" && c.documentId) return `document:${c.documentId}`;
  if (c.source === "directory") {
    const p = c.absolutePath || c.relativePath;
    if (p) return `dir:${p}`;
  }
  return "";
}

/**
 * 从 tool_result content（string / text blocks / 已解析对象）解析 kb_search JSON → citations。
 * 坏 JSON / 非 search 结果 / hits 非数组 → 空数组，不抛。
 */
export function parseKbSearchCitations(content: unknown): KbCitation[] {
  const obj = extractJsonObject(content);
  if (!obj) return [];
  const hits = obj.hits;
  if (!Array.isArray(hits)) return [];
  const citations: KbCitation[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const c = toCitation(hit);
    if (!c) continue;
    const key = dedupKey(c);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    citations.push(c);
  }
  return citations;
}

/**
 * 从 turn process 工具条目收集去重后的 citations（仅 kb_search 成功结果）。
 *
 * @param process turn 过程条目（ProcessEntry 形状：type/tool.name/result.content/result.isError）
 * @returns 去重后的 KbCitation[]（document 优先按 documentId 去重，directory 按路径去重）
 */
export function collectTurnKbCitations(
  process: Array<{
    type: string;
    tool?: { name: string };
    result?: { content?: unknown; isError?: boolean };
  }>,
): KbCitation[] {
  const citations: KbCitation[] = [];
  const seen = new Set<string>();
  for (const entry of process) {
    if (entry.type !== "tool") continue;
    if (!isKbSearchToolName(entry.tool?.name)) continue;
    const result = entry.result;
    // 工具仍在跑（无 result）或失败 → 跳过；本轮只展示成功命中的来源
    if (!result || result.isError) continue;
    const parsed = parseKbSearchCitations(result.content);
    for (const c of parsed) {
      const key = dedupKey(c);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      citations.push(c);
    }
  }
  return citations;
}
