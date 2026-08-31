import { describe, expect, test } from "bun:test";
import {
  collectTurnKbCitations,
  isKbSearchToolName,
  parseKbSearchCitations,
  type KbCitation,
} from "./kb-citations";

/** 构造 kb_search 工具结果（Pi/kscc IR 形状：content 为 text blocks）。
 *  返回完整 tool_result（含 content），collectTurnKbCitations 用例喂 result；
 *  parseKbSearchCitations 用例应取 .content 喂入（函数契约就是吃 content）。 */
function kbSearchResult(hits: unknown[]): { content: unknown; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify({ count: hits.length, hits }) }] };
}

describe("isKbSearchToolName", () => {
  test("裸名 / MCP 前缀都算；其它工具不算", () => {
    expect(isKbSearchToolName("kb_search")).toBe(true);
    expect(isKbSearchToolName("mcp__kb__kb_search")).toBe(true);
    expect(isKbSearchToolName("kb:kb_search")).toBe(true);
    expect(isKbSearchToolName("kb_get")).toBe(false);
    expect(isKbSearchToolName("kb_list_roots")).toBe(false);
    expect(isKbSearchToolName("not_kb_search_x")).toBe(false);
    expect(isKbSearchToolName(undefined)).toBe(false);
  });
});

describe("parseKbSearchCitations", () => {
  test("document + directory 混合命中各自映射", () => {
    const content = kbSearchResult([
      {
        source: "document",
        knowledgeBaseId: "kb-1",
        documentId: "doc-1",
        title: "接线说明文档",
        score: 12,
        excerpt: "…",
        matchedIn: "both",
      },
      {
        source: "directory",
        title: "guide.md",
        score: 5,
        excerpt: "…",
        matchedIn: "body",
        relativePath: "guide.md",
        absolutePath: "/tmp/root/guide.md",
      },
    ]).content;
    const cites = parseKbSearchCitations(content);
    expect(cites).toHaveLength(2);
    expect(cites[0]).toMatchObject({
      source: "document",
      knowledgeBaseId: "kb-1",
      documentId: "doc-1",
      title: "接线说明文档",
    });
    expect(cites[1]).toMatchObject({
      source: "directory",
      title: "guide.md",
      relativePath: "guide.md",
      absolutePath: "/tmp/root/guide.md",
    });
  });

  test("坏 JSON / 非 search 结果 → 空数组不抛", () => {
    // string 坏 JSON
    expect(parseKbSearchCitations("not json")).toEqual([]);
    // text blocks 坏 JSON
    expect(parseKbSearchCitations([{ type: "text", text: "{ broken" }])).toEqual([]);
    // 合法 JSON 但无 hits
    expect(parseKbSearchCitations([{ type: "text", text: JSON.stringify({ count: 0 }) }])).toEqual([]);
    // 空 / null
    expect(parseKbSearchCitations("")).toEqual([]);
    expect(parseKbSearchCitations(null)).toEqual([]);
    expect(parseKbSearchCitations(undefined)).toEqual([]);
    // 空数组
    expect(parseKbSearchCitations([])).toEqual([]);
  });

  test("string content 直接解析", () => {
    const content = JSON.stringify({
      count: 1,
      hits: [{ source: "document", knowledgeBaseId: "kb", documentId: "d", title: "T" }],
    });
    const cites = parseKbSearchCitations(content);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.documentId).toBe("d");
  });

  test("已解析对象 content（防御 adapter 整体塞对象）也能解析", () => {
    const content = {
      count: 1,
      hits: [{ source: "document", knowledgeBaseId: "kb", documentId: "d", title: "T" }],
    };
    const cites = parseKbSearchCitations(content);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.documentId).toBe("d");
  });

  test("document 同 documentId 去重；directory 同路径去重", () => {
    const content = kbSearchResult([
      { source: "document", knowledgeBaseId: "kb", documentId: "dup", title: "A" },
      { source: "document", knowledgeBaseId: "kb", documentId: "dup", title: "A again" },
      { source: "directory", title: "x.md", relativePath: "x.md", absolutePath: "/r/x.md" },
      { source: "directory", title: "x.md", relativePath: "x.md", absolutePath: "/r/x.md" },
      { source: "document", knowledgeBaseId: "kb", documentId: "other", title: "B" },
    ]).content;
    const cites = parseKbSearchCitations(content);
    expect(cites.map((c) => c.documentId ?? c.relativePath)).toEqual([
      "dup",
      "x.md",
      "other",
    ]);
  });

  test("document 缺 documentId 或 title 丢弃；directory 三者皆空丢弃", () => {
    const content = kbSearchResult([
      { source: "document", knowledgeBaseId: "kb", documentId: "", title: "无 id" },
      { source: "document", knowledgeBaseId: "kb", documentId: "d", title: "" },
      { source: "directory", title: "", relativePath: undefined, absolutePath: undefined },
      { source: "directory", title: "只有标题", relativePath: undefined, absolutePath: undefined },
      { source: "unknown", title: "怪东西" },
    ]).content;
    const cites = parseKbSearchCitations(content);
    // 只剩「只有标题」的 directory（无路径，不去重）
    expect(cites).toHaveLength(1);
    expect(cites[0]?.title).toBe("只有标题");
  });

  test("knowledgeBaseId 空串 → undefined（不污染 detail）", () => {
    const content = kbSearchResult([
      { source: "document", knowledgeBaseId: "  ", documentId: "d", title: "T" },
    ]).content;
    const cites = parseKbSearchCitations(content);
    expect(cites[0]?.knowledgeBaseId).toBeUndefined();
  });
});

describe("collectTurnKbCitations", () => {
  test("仅收集 kb_search 成功结果；跨多次调用去重", () => {
    const process = [
      { type: "thinking" },
      {
        type: "tool",
        tool: { name: "kb_list_roots" },
        result: { content: [{ type: "text", text: "{}" }] },
      },
      {
        type: "tool",
        tool: { name: "kb_search" },
        result: kbSearchResult([
          { source: "document", knowledgeBaseId: "kb", documentId: "d1", title: "第一篇" },
          { source: "directory", title: "a.md", relativePath: "a.md", absolutePath: "/r/a.md" },
        ]),
      },
      {
        type: "tool",
        tool: { name: "mcp__kb__kb_search" },
        result: kbSearchResult([
          { source: "document", knowledgeBaseId: "kb", documentId: "d1", title: "重复" },
          { source: "document", knowledgeBaseId: "kb", documentId: "d2", title: "第二篇" },
        ]),
      },
      {
        type: "tool",
        tool: { name: "kb_search" },
        result: { content: [{ type: "text", text: "坏 JSON" }], isError: false },
      },
      {
        type: "tool",
        tool: { name: "kb_search" },
        result: { content: [{ type: "text", text: "{}" }], isError: true },
      },
    ];
    const cites = collectTurnKbCitations(process);
    // d1 去重、a.md、d2；坏 JSON 与 isError 不产生
    expect(cites.map((c) => c.documentId ?? c.relativePath)).toEqual([
      "d1",
      "a.md",
      "d2",
    ]);
  });

  test("工具仍在跑（无 result）跳过", () => {
    const process = [
      { type: "tool", tool: { name: "kb_search" } },
      {
        type: "tool",
        tool: { name: "kb_search" },
        result: kbSearchResult([
          { source: "document", knowledgeBaseId: "kb", documentId: "d", title: "T" },
        ]),
      },
    ];
    const cites = collectTurnKbCitations(process);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.documentId).toBe("d");
  });

  test("非 tool 条目（thinking/text）忽略", () => {
    const process = [
      { type: "thinking" },
      { type: "text" },
      {
        type: "tool",
        tool: { name: "kb_search" },
        result: kbSearchResult([
          { source: "document", knowledgeBaseId: "kb", documentId: "d", title: "T" },
        ]),
      },
    ] as Array<{ type: string; tool?: { name: string }; result?: { content: unknown; isError?: boolean } }>;
    const cites = collectTurnKbCitations(process);
    expect(cites).toHaveLength(1);
  });

  test("返回值类型断言", () => {
    const process = [
      {
        type: "tool",
        tool: { name: "kb_search" },
        result: kbSearchResult([
          { source: "directory", title: "f.md", relativePath: "f.md" },
        ]),
      },
    ];
    const cites: KbCitation[] = collectTurnKbCitations(process);
    expect(cites[0]?.source).toBe("directory");
  });
});
