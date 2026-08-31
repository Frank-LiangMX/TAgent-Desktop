/**
 * 知识库关键词检索共享打分小工具。
 *
 * 让「来源目录检索」（kb-fs-index）与「正式文档检索」（knowledge-base-document-store /
 * kb-agent-tools）使用同一套分词 + 关键词打分 + 摘录逻辑，保证两路命中可比、可合并排序。
 *
 * 纯函数、零副作用、不依赖 node:fs，便于单测。
 *
 * @see docs/dev/knowledge-base/KB-P1-1-DOCS-SEARCH-brief.md §B
 */
/** 单条命中摘录最大字符数 */
export const SEARCH_EXCERPT_LEN = 200;
/** kb_search 默认返回上限 */
export const DEFAULT_SEARCH_LIMIT = 10;
/** kb_search 绝对上限 */
export const MAX_SEARCH_LIMIT = 50;

/** 将 limit 钳制到 [1, MAX_SEARCH_LIMIT]；undefined 走默认 */
export function clampSearchLimit(limit: number | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(n)));
}

/**
 * 查询分词：空白 / 常见标点切分，小写去重；CJK 无空格则整体作一词。
 * 与 fs-index 历史实现保持一致（OR 语义，按命中度排序）。
 */
export function tokenize(query: string): string[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const tokens = lower
    .split(/[\s,，。、；;:：!?！？()（）\[\]{}'"`|/\\]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set(tokens)];
}

/** 围绕首个关键词命中位置截取短摘录，折叠空白 */
export function makeExcerpt(
  content: string,
  firstKw: string,
  maxLen: number = SEARCH_EXCERPT_LEN,
): string {
  if (!content) return "";
  const lower = content.toLowerCase();
  const idx = firstKw ? lower.indexOf(firstKw) : -1;
  let start = 0;
  if (idx >= 0) start = Math.max(0, idx - Math.floor(maxLen / 3));
  let snippet = content
    .slice(start, start + maxLen)
    .replace(/\s+/g, " ")
    .trim();
  if (start > 0) snippet = "…" + snippet;
  if (start + maxLen < content.length) snippet = snippet + "…";
  return snippet;
}

/** 关键词命中位置 */
export type KeywordMatchedIn = "title" | "body" | "both";

/** 关键词打分结果 */
export interface KeywordScore {
  score: number;
  matchedIn: KeywordMatchedIn;
  excerpt: string;
}

/**
 * 对 title + content 用与 fs-index 同类关键词打分：
 * - 标题命中一个关键词 +5
 * - 正文命中次数计入 score（单关键词封顶 +10，防长文刷分）
 * - 无任何命中返回 null
 * - matchedIn：title / body / both
 * - excerpt：围绕首个关键词截取
 */
export function scoreKeywordHits(
  title: string,
  content: string,
  keywords: string[],
  excerptLen: number = SEARCH_EXCERPT_LEN,
): KeywordScore | null {
  if (keywords.length === 0) return null;
  const titleLower = title.toLowerCase();
  const bodyLower = content.toLowerCase();
  let score = 0;
  let matchedInTitle = false;
  let matchedInBody = false;
  for (const kw of keywords) {
    if (titleLower.includes(kw)) {
      score += 5;
      matchedInTitle = true;
    }
    let c = 0;
    let idx = 0;
    while ((idx = bodyLower.indexOf(kw, idx)) !== -1) {
      c += 1;
      idx += kw.length;
      if (c >= 100) break;
    }
    if (c > 0) {
      score += Math.min(c, 10);
      matchedInBody = true;
    }
  }
  if (score <= 0) return null;
  const matchedIn: KeywordMatchedIn =
    matchedInTitle && matchedInBody
      ? "both"
      : matchedInTitle
        ? "title"
        : "body";
  return {
    score,
    matchedIn,
    excerpt: makeExcerpt(content, keywords[0] ?? "", excerptLen),
  };
}
