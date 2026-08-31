import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strToU8, zipSync } from "fflate";
import type {
  AgentSessionMeta,
  KnowledgeBaseMode,
  KbProposeSaveRequest,
} from "@tagent/shared";

let kbRoots: string[] = [];
// undefined = 旧式会话（只有 kbRoots，走 resolveKnowledgeBaseRootsForSession 的 kbRoots 回退）；
// 设成数组 = 新式会话（knowledgeBaseIds 优先，kbRoots 被忽略）。
let knowledgeBaseIds: string[] | undefined = undefined;
let knowledgeBaseMode: KnowledgeBaseMode | undefined = undefined;
// 刀 3：当前会话所属工作区（kb_list_available 据此筛 relatedWorkspaceIds；undefined = 无工作区）
let workspaceId: string | undefined = undefined;
// 刀 3：listSessions 返回的全部会话 meta（用于「最近使用」兜底扫描）
let allSessions: AgentSessionMeta[] = [];

vi.mock("../agent/session-store", () => ({
  // 闭包读取模块级 let：调用 getSessionMeta / listSessions 时才取值，故可在用例体内随时改绑定。
  getSessionMeta: () => ({
    id: "session-test",
    kbRoots,
    knowledgeBaseIds,
    knowledgeBaseMode,
    workspaceId,
  }),
  listSessions: () => allSessions,
}));

const tools = await import("./kb-agent-tools");
const store = await import("./knowledge-base-store");
const docStore = await import("./knowledge-base-document-store");
const proposeSave = await import("./kb-propose-save-service");
const attachment = await import("../attachment-service");

let root = "";
let configDir = "";
let savedConfigDir: string | undefined;

beforeEach(() => {
  // 文档相关用例需要隔离的应用配置目录（knowledge-bases.json / knowledge-base-documents.json）
  configDir = mkdtempSync(join(tmpdir(), "tagent-kb-cfg-"));
  savedConfigDir = process.env.TAGENT_CONFIG_DIR;
  process.env.TAGENT_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = "";
  if (savedConfigDir === undefined) {
    delete process.env.TAGENT_CONFIG_DIR;
  } else {
    process.env.TAGENT_CONFIG_DIR = savedConfigDir;
  }
  kbRoots = [];
  knowledgeBaseIds = undefined;
  knowledgeBaseMode = undefined;
  workspaceId = undefined;
  allSessions = [];
  // 兜底清掉残留 propose-save pending，避免用例间串味
  proposeSave.kbProposeSaveService.clearSessionPending("session-test");
});

describe("kb-agent-tools", () => {
  test("Pi dual-mount 暴露五个只读工具 + 一个受控写入工具", () => {
    const built = tools.buildPiKbTools({ sessionId: "session-test" });
    const names = built.map((tool) => tool.name);
    expect(names).toEqual([
      "kb_list_roots",
      "kb_list_available",
      "kb_search",
      "kb_get",
      "kb_read_attachment",
      "kb_propose_save",
    ]);
    // 只读工具为五个（含刀 3 的 kb_list_available 与主线第一步的 kb_read_attachment）；kb_propose_save 是写入工具
    expect(built).toHaveLength(6);
  });

  test("工具只检索当前会话绑定的根目录", async () => {
    root = mkdtempSync(join(tmpdir(), "tagent-kb-tools-"));
    writeFileSync(
      join(root, "guide.md"),
      "# 接线说明\nPi 与 kscc 都要挂载。",
      "utf8",
    );
    kbRoots = [root];

    const result = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0].source).toBe("directory");
    expect(body.hits[0].relativePath).toBe("guide.md");

    kbRoots = [];
    const empty = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(empty.content[0]!.text)).toMatchObject({ count: 0 });
  });

  test("kb_get 拒绝绑定根目录之外的文件", async () => {
    root = mkdtempSync(join(tmpdir(), "tagent-kb-tools-"));
    writeFileSync(join(root, "guide.md"), "# 指南\n正文", "utf8");
    kbRoots = [root];

    const result = await tools.handleKbGet(
      { path: "../secret.md" },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(result.content[0]!.text).error).toMatch(/路径穿越/);
  });

  test("知识库模式会生成对应的 Agent 检索策略", () => {
    const promptRoot = process.cwd();
    const preferred = tools.buildKbPromptAppend({
      kbRoots: [promptRoot],
      mode: "preferred",
    });
    expect(preferred).toContain("当前模式：优先使用（preferred）");
    expect(preferred).toContain("必须先调用 kb_search");

    const strict = tools.buildKbPromptAppend({
      kbRoots: [promptRoot],
      mode: "strict",
    });
    expect(strict).toContain("当前模式：仅使用（strict）");
    expect(strict).toContain("不得用常识猜测");

    const off = tools.buildKbPromptAppend({
      kbRoots: [promptRoot],
      mode: "off",
    });
    expect(off).toContain("当前模式：不主动使用（off）");
    expect(off).not.toContain("当前模式：优先使用（preferred）");
  });
});

// ── P1-1：正式文档接入 Agent 检索 ─────────────────────────

describe("kb-agent-tools · 正式文档检索 (P1-1)", () => {
  test("绑定库 + 写入正式文档 → kb_search 命中 title/content，带 source=document + documentId", async () => {
    const kb = store.createKnowledgeBase({ name: "接线库" });
    const doc = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "接线说明文档",
      content: "Pi 与 kscc 都要挂载知识库工具，注意接线顺序。",
    });
    knowledgeBaseIds = [kb.id];

    const result = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0]).toMatchObject({
      source: "document",
      knowledgeBaseId: kb.id,
      documentId: doc.id,
      title: "接线说明文档",
      matchedIn: "both",
    });
    expect(body.hits[0].excerpt).toContain("接线");
    expect(body.hits[0].score).toBeGreaterThan(0);
  });

  test("未绑定任何知识库 → 搜不到该文档", async () => {
    const kb = store.createKnowledgeBase({ name: "未绑库" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "未绑定文档",
      content: "内容里有接线关键词",
    });
    knowledgeBaseIds = [];
    kbRoots = [];

    const result = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ count: 0 });
  });

  test("绑库 A 搜不到库 B 的文档（多库隔离）", async () => {
    const kbA = store.createKnowledgeBase({ name: "库A" });
    const kbB = store.createKnowledgeBase({ name: "库B" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kbA.id,
      title: "A 的文档",
      content: "A 专属接线内容",
    });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kbB.id,
      title: "B 的文档",
      content: "B 专属接线内容",
    });
    knowledgeBaseIds = [kbA.id];

    const result = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0]).toMatchObject({
      knowledgeBaseId: kbA.id,
      title: "A 的文档",
    });
  });

  test("kb_get(documentId) 可读全文；越权库拒绝", async () => {
    const kbA = store.createKnowledgeBase({ name: "库A" });
    const kbB = store.createKnowledgeBase({ name: "库B" });
    const docA = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kbA.id,
      title: "A 文档",
      content: "A 的正文内容",
      summary: "一份已确认的摘要",
      sources: [{ label: "上传材料", location: "第 2 页" }],
      parseWarnings: ["表格中的一列需要人工复核"],
      uncertainties: ["发布日期未能从附件中确认"],
      author: "agent",
      status: "confirmed",
    });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kbB.id,
      title: "B 文档",
      content: "B 的正文内容",
    });

    // 仅绑定 A，尝试读 B 的文档 → 越权拒绝
    knowledgeBaseIds = [kbA.id];
    const denied = await tools.handleKbGet(
      { documentId: docStore.createKnowledgeBaseDocument({
        knowledgeBaseId: kbB.id,
        title: "又一篇 B",
        content: "B2",
      }).id },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(denied.content[0]!.text).error).toMatch(/越权/);

    // 读 A 的文档 → 返回全文，与界面一致
    const ok = await tools.handleKbGet(
      { documentId: docA.id },
      { sessionId: "session-test" },
    );
    const okBody = JSON.parse(ok.content[0]!.text);
    expect(okBody).toMatchObject({
      source: "document",
      knowledgeBaseId: kbA.id,
      documentId: docA.id,
      title: "A 文档",
      content: "A 的正文内容",
      summary: "一份已确认的摘要",
      sources: [{ label: "上传材料", location: "第 2 页" }],
      parseWarnings: ["表格中的一列需要人工复核"],
      uncertainties: ["发布日期未能从附件中确认"],
      author: "agent",
      status: "confirmed",
      truncated: false,
    });

    // 不存在的 documentId（且未给 path）→ 报错
    const missing = await tools.handleKbGet(
      { documentId: "not-a-real-id" },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(missing.content[0]!.text).error).toMatch(/documentId 无效|找不到/);
  });

  test("documentId 与 path 都缺 → 报错；documentId 无效但有 path → 回退目录", async () => {
    const empty = await tools.handleKbGet(
      {},
      { sessionId: "session-test" },
    );
    expect(JSON.parse(empty.content[0]!.text).error).toMatch(
      /documentId 或 path 不能为空/,
    );

    root = mkdtempSync(join(tmpdir(), "tagent-kb-tools-"));
    writeFileSync(join(root, "guide.md"), "# 指南\n正文", "utf8");
    kbRoots = [root];
    // 给一个无效 documentId + 合法 path → 应回退到来源目录读取
    const fallback = await tools.handleKbGet(
      { documentId: "no-such-doc", path: "guide.md" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(fallback.content[0]!.text);
    expect(body.source).toBe("directory");
    expect(body.relativePath).toBe("guide.md");
    expect(body.content).toContain("正文");
  });

  test("目录命中回归：仅有来源目录时 kb_search 仍返回 directory 命中", async () => {
    root = mkdtempSync(join(tmpdir(), "tagent-kb-tools-"));
    writeFileSync(join(root, "notes.md"), "# 笔记\n回归关键词内容", "utf8");
    kbRoots = [root];
    // 旧式会话：knowledgeBaseIds 保持 undefined，走 kbRoots 回退

    const result = await tools.handleKbSearch(
      { query: "回归关键词" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0].source).toBe("directory");
    expect(body.hits[0].relativePath).toBe("notes.md");
  });

  test("仅有正式文档、无来源目录时 buildKbPromptAppend 仍输出 preferred/strict", () => {
    const kb = store.createKnowledgeBase({ name: "纯文档库" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "纯文档",
      content: "只有正式文档没有来源目录",
    });

    const preferred = tools.buildKbPromptAppend({
      knowledgeBaseIds: [kb.id],
      mode: "preferred",
    });
    expect(preferred).toContain("当前模式：优先使用（preferred）");
    expect(preferred).toContain("必须先调用 kb_search");
    expect(preferred).toContain("纯文档库");
    expect(preferred).toContain("1 篇正式文档");

    const strict = tools.buildKbPromptAppend({
      knowledgeBaseIds: [kb.id],
      mode: "strict",
    });
    expect(strict).toContain("当前模式：仅使用（strict）");
    expect(strict).toContain("不得用常识猜测");

    // 未绑定任何库且无 roots → 仍返回未绑定提示
    const none = tools.buildKbPromptAppend({
      knowledgeBaseIds: [],
      mode: "preferred",
    });
    expect(none).toContain("未绑定知识库");
    expect(none).not.toContain("当前模式：优先使用（preferred）");
  });

  test("kb_search 文档命中带章节和来源行号", async () => {
    const kb = store.createKnowledgeBase({ name: "定位库" });
    const doc = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "定位文档",
      content: "# 概览\n普通内容\n\n## 目标章节\n目标关键词位于这里。",
    });
    knowledgeBaseIds = [kb.id];

    const result = await tools.handleKbSearch(
      { query: "目标关键词" },
      { sessionId: "session-test" },
    );
    const hit = JSON.parse(result.content[0]!.text).hits[0];
    expect(hit).toMatchObject({
      documentId: doc.id,
      section: "目标章节",
      sourcePosition: { startLine: 4, endLine: 5 },
      chunkId: doc.id + ":4-5",
    });
  });
  test("kb_list_roots 列出绑定知识库与文档数", async () => {
    const kb = store.createKnowledgeBase({ name: "统计库" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "文档一",
      content: "内容一",
    });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "文档二",
      content: "内容二",
    });
    knowledgeBaseIds = [kb.id];

    const result = await tools.handleKbListRoots({ sessionId: "session-test" });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.knowledgeBases).toEqual([
      { id: kb.id, name: "统计库", documentCount: 2 },
    ]);
    expect(body.documentCount).toBe(2);
    expect(body.roots).toEqual([]);
  });

  test("document-store 新查询函数直接单测", () => {
    const kb = store.createKnowledgeBase({ name: "直测库" });
    const d1 = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "标题含苹果",
      content: "正文不含关键词",
    });
    const d2 = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "无关标题",
      content: "正文含香蕉关键词",
    });

    // getKnowledgeBaseDocument
    expect(docStore.getKnowledgeBaseDocument(d1.id)?.title).toBe("标题含苹果");
    expect(docStore.getKnowledgeBaseDocument("nope")).toBeUndefined();

    // listKnowledgeBaseDocumentsForIds
    const listed = docStore.listKnowledgeBaseDocumentsForIds([kb.id]);
    expect(listed.map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
    expect(docStore.listKnowledgeBaseDocumentsForIds([])).toEqual([]);

    // searchKnowledgeBaseDocuments：同类打分，标题命中 +5
    const hits = docStore.searchKnowledgeBaseDocuments({
      knowledgeBaseIds: [kb.id],
      query: "苹果",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      knowledgeBaseId: kb.id,
      documentId: d1.id,
      matchedIn: "title",
    });

    const bodyHits = docStore.searchKnowledgeBaseDocuments({
      knowledgeBaseIds: [kb.id],
      query: "香蕉",
    });
    expect(bodyHits).toHaveLength(1);
    expect(bodyHits[0]!.matchedIn).toBe("body");

    // 越权 id 不命中
    expect(
      docStore.searchKnowledgeBaseDocuments({
        knowledgeBaseIds: ["other-kb"],
        query: "苹果",
      }),
    ).toEqual([]);
  });
});

// ── P1-5：kb_propose_save 受控写入 ─────────────────────────

describe("kb-agent-tools · 受控写入 kb_propose_save (P1-5)", () => {
  /** 构造一个捕获 sendToRenderer 的 ctx，返回 { promise, captured } */
  function callProposeSave(
    args: Record<string, unknown>,
    ctx?: { signal?: AbortSignal },
  ) {
    const captured: KbProposeSaveRequest[] = [];
    const promise = tools.handleKbProposeSave(args, {
      sessionId: "session-test",
      knowledgeBaseWritesEnabled: true,
      sendToRenderer: (req) => captured.push(req),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    return { promise, captured };
  }

  test("未绑定库 → 工具立即 error，不发 UI（captured 为空）", async () => {
    const kb = store.createKnowledgeBase({ name: "未绑库" });
    knowledgeBaseIds = [];

    const { promise, captured } = callProposeSave({
      knowledgeBaseId: kb.id,
      title: "标题",
      content: "正文",
    });
    const body = JSON.parse((await promise).content[0]!.text);
    expect(body.error).toMatch(/未绑定任何知识库/);
    expect(captured).toHaveLength(0); // 不弹横幅
  });

  test("绑定库 + confirm → document-store 多一篇，kb_search 能命中标题关键词", async () => {
    const kb = store.createKnowledgeBase({ name: "接线库" });
    knowledgeBaseIds = [kb.id];
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);

    const { promise, captured } = callProposeSave({
      knowledgeBaseId: kb.id,
      title: "接口接线公约",
      content: "Pi 与 kscc 都要先声明意图再调用工具。",
      kind: "contract",
    });
    // 校验通过 → 已弹横幅（captured 收到请求）
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      knowledgeBaseId: kb.id,
      knowledgeBaseName: "接线库",
      title: "接口接线公约",
      kind: "contract",
    });

    // 确认前文档数不变（验收 §1：确认前管理页文档列表不变）
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);

    proposeSave.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "confirm",
    });
    const result = JSON.parse((await promise).content[0]!.text);
    expect(result).toMatchObject({
      ok: true,
      knowledgeBaseId: kb.id,
      title: "接口接线公约",
    });
    expect(result.documentId).toBeTruthy();

    // 库内多一篇
    const docs = docStore.listKnowledgeBaseDocumentsForIds([kb.id]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("接口接线公约");

    // 同会话 kb_search 能搜到标题关键词（验收 §2）
    const search = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(search.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0]).toMatchObject({
      source: "document",
      knowledgeBaseId: kb.id,
      documentId: result.documentId,
      title: "接口接线公约",
    });
  });

  test("结构化草稿进入确认请求，确认后随正式知识保留", async () => {
    const kb = store.createKnowledgeBase({ name: "草稿库" });
    knowledgeBaseIds = [kb.id];

    const { promise, captured } = callProposeSave({
      knowledgeBaseId: kb.id,
      title: "附件整理结果",
      content: "## 结论\n正文",
      kind: "norm",
      draft: {
        summary: "一份可审核的规范草稿",
        sources: [{ label: "rules.docx", location: "第 2 页 / 适用范围" }],
        warnings: ["PDF 文本层可能不完整"],
        uncertainties: ["第 3 条的例外条件需要确认"],
      },
    });

    expect(captured[0]?.draft).toEqual({
      summary: "一份可审核的规范草稿",
      sources: [{ label: "rules.docx", location: "第 2 页 / 适用范围" }],
      warnings: ["PDF 文本层可能不完整"],
      uncertainties: ["第 3 条的例外条件需要确认"],
    });

    proposeSave.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "confirm",
    });
    const result = JSON.parse((await promise).content[0]!.text);
    expect(result.ok).toBe(true);

    const saved = docStore.getKnowledgeBaseDocument(result.documentId);
    expect(saved).toMatchObject({
      kind: "norm",
      summary: "一份可审核的规范草稿",
      sources: [{ label: "rules.docx", location: "第 2 页 / 适用范围" }],
      parseWarnings: ["PDF 文本层可能不完整"],
      uncertainties: ["第 3 条的例外条件需要确认"],
      author: "agent",
      status: "confirmed",
    });
  });
  test("reject → 文档数不变，工具返回 ok:false user_rejected", async () => {
    const kb = store.createKnowledgeBase({ name: "拒绝库" });
    knowledgeBaseIds = [kb.id];

    const { promise, captured } = callProposeSave({
      knowledgeBaseId: kb.id,
      title: "应被拒绝的文档",
      content: "内容",
    });
    expect(captured).toHaveLength(1);
    proposeSave.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "reject",
    });
    const result = JSON.parse((await promise).content[0]!.text);
    expect(result).toEqual({ ok: false, reason: "user_rejected" });
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);
  });

  test("abort（会话停止 clearSessionPending）→ 不写入，返回 ok:false aborted", async () => {
    const kb = store.createKnowledgeBase({ name: "中止库" });
    knowledgeBaseIds = [kb.id];

    const { promise, captured } = callProposeSave({
      knowledgeBaseId: kb.id,
      title: "被中止的文档",
      content: "内容",
    });
    expect(captured).toHaveLength(1);
    const cleared =
      proposeSave.kbProposeSaveService.clearSessionPending("session-test");
    expect(cleared).toEqual([captured[0]!.requestId]);
    const result = JSON.parse((await promise).content[0]!.text);
    expect(result).toEqual({ ok: false, reason: "aborted" });
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);
  });

  test("越权 knowledgeBaseId（非本会话绑定）→ error，不发 UI", async () => {
    const kbA = store.createKnowledgeBase({ name: "库A" });
    const kbB = store.createKnowledgeBase({ name: "库B" });
    knowledgeBaseIds = [kbA.id]; // 只绑 A

    const { promise, captured } = callProposeSave({
      knowledgeBaseId: kbB.id, // 越权写 B
      title: "越权文档",
      content: "内容",
    });
    const body = JSON.parse((await promise).content[0]!.text);
    expect(body.error).toMatch(/越权写入/);
    expect(captured).toHaveLength(0); // 不弹横幅
    // A/B 都没多文档
    expect(docStore.listKnowledgeBaseDocumentsForIds([kbA.id])).toHaveLength(0);
    expect(docStore.listKnowledgeBaseDocumentsForIds([kbB.id])).toHaveLength(0);
  });

  test("标题空 / 正文空 / 目标库不存在 → 各自 error，不发 UI", async () => {
    const kb = store.createKnowledgeBase({ name: "校验库" });
    knowledgeBaseIds = [kb.id];

    // 标题空
    const noTitle = await callProposeSave({
      knowledgeBaseId: kb.id,
      title: "   ",
      content: "正文",
    }).promise;
    expect(JSON.parse(noTitle.content[0]!.text).error).toMatch(/title/);
    expect(JSON.parse(noTitle.content[0]!.text).error).toMatch(/不能为空/);

    // 正文空
    const noContent = await callProposeSave({
      knowledgeBaseId: kb.id,
      title: "标题",
      content: "   \n  ",
    }).promise;
    expect(JSON.parse(noContent.content[0]!.text).error).toMatch(/content/);

    // knowledgeBaseId 空
    const noId = await callProposeSave({
      knowledgeBaseId: "",
      title: "标题",
      content: "正文",
    }).promise;
    expect(JSON.parse(noId.content[0]!.text).error).toMatch(/knowledgeBaseId/);
  });

  test("未配置 sendToRenderer → error，绝不静默写入", async () => {
    const kb = store.createKnowledgeBase({ name: "无通道库" });
    knowledgeBaseIds = [kb.id];

    const promise = tools.handleKbProposeSave(
      { knowledgeBaseId: kb.id, title: "标题", content: "正文" },
      { sessionId: "session-test", knowledgeBaseWritesEnabled: true }, // 无 sendToRenderer
    );
    const body = JSON.parse((await promise).content[0]!.text);
    expect(body.error).toMatch(/未配置.*通道|拒绝静默写入/);
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);
  });

  test("发行版写入闸门关闭 → 不发确认横幅、不写入", async () => {
    const kb = store.createKnowledgeBase({ name: "发行版闸门库" });
    knowledgeBaseIds = [kb.id];
    const captured: KbProposeSaveRequest[] = [];

    const result = await tools.handleKbProposeSave(
      { knowledgeBaseId: kb.id, title: "标题", content: "正文" },
      {
        sessionId: "session-test",
        knowledgeBaseWritesEnabled: false,
        sendToRenderer: (request) => captured.push(request),
      },
    );
    const body = JSON.parse(result.content[0]!.text);

    expect(body.error).toContain("知识库文档写入");
    expect(captured).toHaveLength(0);
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);
  });
});

// ── 刀 2：文档 kind 标注 / 模板检索 ─────────────────────────

describe("kb-agent-tools · 文档 kind 标注 (刀 2)", () => {
  test("create 带 kind → 读回一致；无 kind 兼容；非法 kind 被丢弃", () => {
    const kb = store.createKnowledgeBase({ name: "kind 库" });
    const contract = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "登录接口约定",
      content: "POST /api/login 入口与禁忌。",
      kind: "contract",
    });
    const snapshot = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "资源统计快照",
      content: "UE 资源统计探查时间与数据。",
      kind: "snapshot",
      snapshotAt: 1234567890,
      originNote: "手测沉淀",
    });
    const note = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "随手笔记",
      content: "普通笔记无 kind。",
    });
    // 非法 kind 入参 → 不持久化（读取时归一 note）
    const bad = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "坏 kind",
      content: "内容",
      kind: "garbage" as unknown as "note",
    });

    expect(docStore.getKnowledgeBaseDocument(contract.id)?.kind).toBe("contract");
    expect(docStore.getKnowledgeBaseDocument(snapshot.id)?.kind).toBe("snapshot");
    expect(docStore.getKnowledgeBaseDocument(snapshot.id)?.snapshotAt).toBe(1234567890);
    expect(docStore.getKnowledgeBaseDocument(snapshot.id)?.originNote).toBe("手测沉淀");
    expect(docStore.getKnowledgeBaseDocument(note.id)?.kind).toBeUndefined();
    expect(docStore.getKnowledgeBaseDocument(bad.id)?.kind).toBeUndefined();

    // document-store 检索命中带 kind；无 kind 归一 note
    const contractHits = docStore.searchKnowledgeBaseDocuments({
      knowledgeBaseIds: [kb.id],
      query: "登录",
    });
    expect(contractHits).toHaveLength(1);
    expect(contractHits[0]!.kind).toBe("contract");

    const noteHits = docStore.searchKnowledgeBaseDocuments({
      knowledgeBaseIds: [kb.id],
      query: "笔记",
    });
    expect(noteHits).toHaveLength(1);
    expect(noteHits[0]!.kind).toBe("note");
  });

  test("kb_search / kb_get document 命中带 kind；旧文档无 kind 归一 note", async () => {
    const kb = store.createKnowledgeBase({ name: "agent kind 库" });
    const contract = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "接线公约卡",
      content: "接口接线约定与禁忌。",
      kind: "contract",
    });
    const legacy = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "旧笔记无 kind",
      content: "旧文档关键词。",
    });
    knowledgeBaseIds = [kb.id];

    const search = await tools.handleKbSearch(
      { query: "公约" },
      { sessionId: "session-test" },
    );
    const sBody = JSON.parse(search.content[0]!.text);
    expect(sBody.hits[0]).toMatchObject({
      source: "document",
      documentId: contract.id,
      kind: "contract",
    });

    const legacySearch = await tools.handleKbSearch(
      { query: "旧文档" },
      { sessionId: "session-test" },
    );
    const lBody = JSON.parse(legacySearch.content[0]!.text);
    expect(lBody.hits[0]).toMatchObject({
      source: "document",
      kind: "note",
    });

    const get = await tools.handleKbGet(
      { documentId: contract.id },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(get.content[0]!.text).kind).toBe("contract");
    expect(JSON.parse(get.content[0]!.text)).not.toHaveProperty("snapshotAt");

    const getLegacy = await tools.handleKbGet(
      { documentId: legacy.id },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(getLegacy.content[0]!.text).kind).toBe("note");
  });

  test("kb_search directory 命中不带 kind（仅 document 命中带）", async () => {
    root = mkdtempSync(join(tmpdir(), "tagent-kb-tools-"));
    writeFileSync(join(root, "guide.md"), "# 指南\n关键词内容", "utf8");
    kbRoots = [root];
    // 旧式会话：knowledgeBaseIds 保持 undefined，走 kbRoots 回退（设成 [] 会被当成新式而忽略 kbRoots）
    knowledgeBaseIds = undefined;
    const result = await tools.handleKbSearch(
      { query: "关键词" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0].source).toBe("directory");
    expect(body.hits[0]).not.toHaveProperty("kind");
  });

  test("buildKbPromptAppend 含优先参考 contract/norm/snapshot 指引", () => {
    const kb = store.createKnowledgeBase({ name: "prompt 库" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "接口约定",
      content: "内容",
      kind: "contract",
    });
    const prompt = tools.buildKbPromptAppend({
      knowledgeBaseIds: [kb.id],
      mode: "preferred",
    });
    expect(prompt).toContain("kind");
    expect(prompt).toContain("优先关注");
    expect(prompt).toMatch(/contract[\s\S]*norm[\s\S]*snapshot/);
    // propose_save 提示也带 kind 建议
    expect(prompt).toContain("kind:contract");
  });
});

// ── 刀 3：可发现、不可偷用（口头轻问）─────────────────────────

function makeSessionMeta(
  partial: Partial<AgentSessionMeta> & { id: string },
): AgentSessionMeta {
  return {
    title: partial.title ?? "s",
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    ...partial,
  } as AgentSessionMeta;
}

describe("kb-agent-tools · 可发现不可偷用 (刀 3)", () => {
  test("store: createKnowledgeBase / updateKnowledgeBase 维护 relatedWorkspaceIds", () => {
    const kb = store.createKnowledgeBase({
      name: "关联库",
      relatedWorkspaceIds: ["ws-a", "ws-a", " ws-b ", ""],
    });
    // 去重 + trim + 去空
    expect(kb.relatedWorkspaceIds).toEqual(["ws-a", "ws-b"]);
    expect(store.listKnowledgeBases()[0]?.relatedWorkspaceIds).toEqual([
      "ws-a",
      "ws-b",
    ]);

    // 追加关联
    const updated = store.updateKnowledgeBase({
      id: kb.id,
      relatedWorkspaceIds: ["ws-a", "ws-c"],
    });
    expect(updated.relatedWorkspaceIds).toEqual(["ws-a", "ws-c"]);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(kb.updatedAt);

    // 清空关联 → 字段被删除（listKnowledgeBases 读回 undefined）
    const cleared = store.updateKnowledgeBase({ id: kb.id, relatedWorkspaceIds: [] });
    expect(cleared.relatedWorkspaceIds).toBeUndefined();
    expect(store.listKnowledgeBases()[0]?.relatedWorkspaceIds).toBeUndefined();

    // 改名 / 描述
    const renamed = store.updateKnowledgeBase({
      id: kb.id,
      name: "新名",
      description: "新描述",
    });
    expect(renamed.name).toBe("新名");
    expect(renamed.description).toBe("新描述");
    // 描述传空串 → 清除
    expect(
      store.updateKnowledgeBase({ id: kb.id, description: "   " }).description,
    ).toBeUndefined();

    // 不存在的库 → 抛错
    expect(() =>
      store.updateKnowledgeBase({ id: "no-such", name: "x" }),
    ).toThrow(/不存在/);
    // 空名 → 抛错
    expect(() =>
      store.updateKnowledgeBase({ id: kb.id, name: "  " }),
    ).toThrow(/名称不能为空/);
  });

  test("normalizeRelatedWorkspaceIds: trim / 去重 / 去空 / 保留顺序", () => {
    expect(store.normalizeRelatedWorkspaceIds(["b", "a", "b", " a "])).toEqual([
      "b",
      "a",
    ]);
    expect(store.normalizeRelatedWorkspaceIds(undefined)).toEqual([]);
    expect(
      store.normalizeRelatedWorkspaceIds(["", "  ", "x"]),
    ).toEqual(["x"]);
  });

  test("未绑定：kb_search count=0 / kb_get 越权 error / kb_propose_save error（不可偷用）", async () => {
    const kb = store.createKnowledgeBase({ name: "偷用库" });
    const doc = docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "敏感正文",
      content: "这是不该被未挂库会话读到的正文。",
    });
    // 未挂库（新式空数组）
    knowledgeBaseIds = [];
    kbRoots = [];

    // 搜不到正文
    const search = await tools.handleKbSearch(
      { query: "敏感" },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(search.content[0]!.text)).toMatchObject({ count: 0 });

    // 直接拿 documentId 也越权拒绝（不得读正文）
    const get = await tools.handleKbGet(
      { documentId: doc.id },
      { sessionId: "session-test" },
    );
    expect(JSON.parse(get.content[0]!.text).error).toMatch(/越权/);

    // 提议保存也直接 error，不弹横幅
    const captured: KbProposeSaveRequest[] = [];
    const propose = await tools.handleKbProposeSave(
      { knowledgeBaseId: kb.id, title: "t", content: "c" },
      {
        sessionId: "session-test",
        knowledgeBaseWritesEnabled: true,
        sendToRenderer: (req) => captured.push(req),
      },
    );
    expect(JSON.parse(propose.content[0]!.text).error).toMatch(
      /未绑定任何知识库/,
    );
    expect(captured).toHaveLength(0);
  });

  test("kb_list_available: 未绑定 + 关联库 → 仅元数据（id/name/related），无正文字段", async () => {
    const kb = store.createKnowledgeBase({
      name: "设计规范库",
      description: "产品设计规范与公约",
    });
    store.updateKnowledgeBase({ id: kb.id, relatedWorkspaceIds: ["ws-1"] });
    workspaceId = "ws-1";
    knowledgeBaseIds = [];
    kbRoots = [];

    const result = await tools.handleKbListAvailable({
      sessionId: "session-test",
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.bound).toBe(false);
    expect(body.available).toHaveLength(1);
    const entry = body.available[0];
    expect(entry).toMatchObject({
      id: kb.id,
      name: "设计规范库",
      description: "产品设计规范与公约",
      related: true,
    });
    // 钉死「不可偷用」：条目只含这四个键，绝无 content / title 列表 / 文档摘录
    expect(Object.keys(entry).sort()).toEqual([
      "description",
      "id",
      "name",
      "related",
    ]);
  });

  test("kb_list_available: 已挂库 → available 为空（检索仍只用绑定集）", async () => {
    const kb = store.createKnowledgeBase({ name: "已挂库" });
    store.updateKnowledgeBase({ id: kb.id, relatedWorkspaceIds: ["ws-1"] });
    workspaceId = "ws-1";
    knowledgeBaseIds = [kb.id]; // 已挂库

    const result = await tools.handleKbListAvailable({
      sessionId: "session-test",
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.bound).toBe(true);
    expect(body.available).toEqual([]);
  });

  test("kb_list_available: 无关联库 → 「最近使用」兜底（按会话 updatedAt 倒序取 3）", async () => {
    const kbA = store.createKnowledgeBase({ name: "最近A" });
    const kbB = store.createKnowledgeBase({ name: "最近B" });
    const kbC = store.createKnowledgeBase({ name: "最近C" });
    const kbD = store.createKnowledgeBase({ name: "最近D" });
    // 没有任何库关联当前工作区
    workspaceId = "ws-1";
    knowledgeBaseIds = [];
    kbRoots = [];
    // 历史会话引用情况：B 最久未用、A/C/D 最近用过（D 最新、C 次之、A 再次、B 最旧）
    allSessions = [
      makeSessionMeta({ id: "s-old", knowledgeBaseIds: [kbB.id], updatedAt: 100 }),
      makeSessionMeta({ id: "s-a", knowledgeBaseIds: [kbA.id], updatedAt: 300 }),
      makeSessionMeta({ id: "s-c", knowledgeBaseIds: [kbC.id], updatedAt: 500 }),
      makeSessionMeta({ id: "s-d", knowledgeBaseIds: [kbD.id], updatedAt: 900 }),
    ];

    const result = await tools.handleKbListAvailable({
      sessionId: "session-test",
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.bound).toBe(false);
    // 兜底最多 3 个，按最近使用时间倒序：D > C > A（B 被挤出）
    expect(body.available.map((e: { name: string }) => e.name)).toEqual([
      "最近D",
      "最近C",
      "最近A",
    ]);
    expect(
      body.available.every((e: { related: boolean }) => e.related === false),
    ).toBe(true);
  });

  test("kb_list_available: 无关联且无最近使用 → available 为空", async () => {
    store.createKnowledgeBase({ name: "孤库" });
    workspaceId = "ws-1";
    knowledgeBaseIds = [];
    kbRoots = [];
    allSessions = [];

    const result = await tools.handleKbListAvailable({
      sessionId: "session-test",
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.bound).toBe(false);
    expect(body.available).toEqual([]);
  });

  test("绑定后 kb_search 仍只命中绑定库（回归；未绑定库即便关联也不命中）", async () => {
    const kbA = store.createKnowledgeBase({ name: "绑定A" });
    const kbB = store.createKnowledgeBase({ name: "关联但未绑B" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kbA.id,
      title: "A 公约",
      content: "接线关键词",
    });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kbB.id,
      title: "B 公约",
      content: "接线关键词",
    });
    store.updateKnowledgeBase({ id: kbB.id, relatedWorkspaceIds: ["ws-1"] });
    workspaceId = "ws-1";
    // 只绑 A；B 仅关联未挂
    knowledgeBaseIds = [kbA.id];

    const search = await tools.handleKbSearch(
      { query: "接线" },
      { sessionId: "session-test" },
    );
    const body = JSON.parse(search.content[0]!.text);
    expect(body.count).toBe(1);
    expect(body.hits[0]).toMatchObject({ knowledgeBaseId: kbA.id });

    // kb_list_available 此时 bound=true → available 空（不把 B 列出来当可挂）
    const avail = JSON.parse(
      (await tools.handleKbListAvailable({ sessionId: "session-test" })).content[0]!
        .text,
    );
    expect(avail).toMatchObject({ bound: true, available: [] });
  });

  test("buildKbPromptAppend: 未绑定 + 有可发现库 → 口头轻问规则 + 不教怎么挂 + 不可偷读正文", () => {
    const prompt = tools.buildKbPromptAppend({
      knowledgeBaseIds: [],
      mode: "preferred",
      available: [
        {
          id: "kb-1",
          name: "设计规范库",
          description: "产品规范",
          related: true,
        },
        { id: "kb-2", name: "最近库", related: false },
      ],
    });
    // 列出库名
    expect(prompt).toContain("《设计规范库》");
    expect(prompt).toContain("《最近库》");
    // 口头轻问规则
    expect(prompt).toContain("口头轻问");
    expect(prompt).toContain("是否需要挂上");
    // 不教怎么挂（除非用户问）
    expect(prompt).toContain("不要说明如何挂载");
    expect(prompt).toContain("怎么挂");
    // 拒绝后不再荐
    expect(prompt).toContain("本会话不要再推荐");
    // 不可偷读正文
    expect(prompt).toContain("禁止把知识库内容当作答案依据");
    // 未绑定时不应注入 preferred/strict 模式文案
    expect(prompt).not.toContain("当前模式：优先使用");
    expect(prompt).not.toContain("当前模式：仅使用");
  });

  test("buildKbPromptAppend: 未绑定 + 无可发现库 → 不硬荐、不教操作", () => {
    const prompt = tools.buildKbPromptAppend({
      knowledgeBaseIds: [],
      mode: "preferred",
      available: [],
    });
    expect(prompt).toContain("未绑定知识库");
    expect(prompt).toContain("没有可与当前工作关联的知识库可推荐");
    expect(prompt).toContain("不要主动建议用户挂载");
    // 不应出现口头轻问的库名清单（无可荐库）
    expect(prompt).not.toContain("口头轻问规则");
    expect(prompt).not.toContain("是否需要挂上");
  });

  test("buildKbPromptAppend: 已绑定 → 一句带过「无需再推荐挂载」", () => {
    const kb = store.createKnowledgeBase({ name: "已挂库" });
    const prompt = tools.buildKbPromptAppend({
      knowledgeBaseIds: [kb.id],
      mode: "preferred",
      // 已绑定时 available 应被忽略
      available: [
        { id: "x", name: "不应出现的库", related: true },
      ],
    });
    expect(prompt).toContain("当前模式：优先使用（preferred）");
    expect(prompt).toContain("无需再向用户推荐挂载");
    expect(prompt).not.toContain("不应出现的库");
  });
});


describe("XLSX multi-sheet import", () => {
  test("splits worksheets and restores shared strings into Markdown tables", async () => {
    const workbook = '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="First" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>';
    const shared = '<sst><si><t>Name</t></si><si><t>Alice</t></si><si><t>Age</t></si></sst>';
    const sheet1 = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>30</v></c></row></sheetData></worksheet>';
    const sheet2 = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A1"><v>42</v></c></row></sheetData></worksheet>';
    const archive = zipSync({
      "xl/workbook.xml": strToU8(workbook),
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/sharedStrings.xml": strToU8(shared),
      "xl/worksheets/sheet1.xml": strToU8(sheet1),
      "xl/worksheets/sheet2.xml": strToU8(sheet2),
    });
    const filePath = join(configDir, "multi-sheet.xlsx");
    writeFileSync(filePath, archive);
    const knowledgeBase = store.createKnowledgeBase({ name: "xlsx-test" });
    const documents = await docStore.importKnowledgeBaseDocuments({
      knowledgeBaseId: knowledgeBase.id,
      filePath,
      title: "Workbook",
    });
    expect(documents).toHaveLength(2);
    expect(documents.map((document) => document.title)).toEqual([
      "Workbook\uFF5CFirst",
      "Workbook\uFF5CSecond",
    ]);
    expect(documents[0]?.content).toContain("| Name | Age |");
    expect(documents[0]?.content).toContain("| Alice | 30 |");
    expect(documents[1]?.content).toContain("| Value |");
    expect(documents[1]?.content).toContain("| 42 |");
  });
});

// ── 主线第一步：kb_read_attachment 附件读取 ─────────────────

describe("kb-agent-tools · kb_read_attachment 附件读取 (主线第一步)", () => {
  function bytesToBase64(bytes: Uint8Array): string {
    const { buffer, byteOffset, byteLength } = bytes;
    return Buffer.from(buffer as ArrayBuffer, byteOffset, byteLength).toString(
      "base64",
    );
  }

  function buildDocx(paragraphs: string[]): Uint8Array {
    const body = paragraphs
      .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
      .join("");
    return zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    });
  }

  function buildXlsx(
    sheets: Array<{ name: string; xml: string }>,
    sharedStrings: string[],
  ): Uint8Array {
    const files: Record<string, Uint8Array> = {};
    files["[Content_Types].xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    );
    files["_rels/.rels"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    );
    const sheetTags = sheets
      .map(
        (s, i) =>
          `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("");
    files["xl/workbook.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`,
    );
    const relTags = sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("");
    files["xl/_rels/workbook.xml.rels"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags}</Relationships>`,
    );
    const sharedItems = sharedStrings
      .map((s) => `<si><t>${s}</t></si>`)
      .join("");
    files["xl/sharedStrings.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedItems}</sst>`,
    );
    sheets.forEach((s, i) => {
      files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.xml}</sheetData></worksheet>`,
      );
    });
    return zipSync(files);
  }

  function saveBytes(
    sessionId: string,
    filename: string,
    mediaType: string,
    bytes: Uint8Array,
  ) {
    return attachment.saveAttachment({
      sessionId,
      filename,
      mediaType,
      data: bytesToBase64(bytes),
    });
  }

  test("会话隔离：只能读当前会话附件，拒绝其它会话 / 路径穿越 / 不存在 / 绝对路径", async () => {
    const docx = buildDocx(["本会话专属段落", "另一段内容"]);
    const saved = saveBytes(
      "session-a",
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docx,
    );

    // 当前会话 → 可读
    const ok = await tools.handleKbReadAttachment(
      { localPath: saved.localPath },
      { sessionId: "session-a" },
    );
    const okBody = JSON.parse(ok.content[0]!.text);
    expect(okBody.content).toContain("本会话专属段落");
    expect(okBody.content).toContain("另一段内容");
    expect(okBody.extension).toBe(".docx");
    expect(okBody.filename).toBe(saved.localPath.split("/").pop());
    expect(okBody.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(okBody.warnings).toEqual([]);
    expect(okBody.truncated).toBe(false);

    // 其它会话读同一附件 → 拒绝
    const other = await tools.handleKbReadAttachment(
      { localPath: saved.localPath },
      { sessionId: "session-b" },
    );
    expect(JSON.parse(other.content[0]!.text).error).toMatch(
      /不属于当前会话|越界|不可读/,
    );

    // 路径穿越（../ 逃到别的会话）→ 拒绝
    const traversal = await tools.handleKbReadAttachment(
      { localPath: "../session-a/" + saved.localPath.split("/").pop() },
      { sessionId: "session-b" },
    );
    expect(JSON.parse(traversal.content[0]!.text).error).toMatch(
      /不属于当前会话|越界|不可读/,
    );

    // 不存在 → 拒绝
    const missing = await tools.handleKbReadAttachment(
      { localPath: "session-a/nonexistent.docx" },
      { sessionId: "session-a" },
    );
    expect(JSON.parse(missing.content[0]!.text).error).toMatch(
      /不存在|不可读|越界/,
    );

    // 绝对路径 → 拒绝
    const abs = await tools.handleKbReadAttachment(
      { localPath: "C:/whatever.docx" },
      { sessionId: "session-a" },
    );
    expect(JSON.parse(abs.content[0]!.text).error).toMatch(
      /不支持|不可读|越界/,
    );
  });

  test("XLSX 解析保留多个工作表名与各表内容（不混入页面参数/HTML/CSS）", async () => {
    const sheet1 =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10</v></c></row>';
    const sheet2 = '<row r="1"><c r="A1"><v>42</v></c></row>';
    const xlsx = buildXlsx(
      [
        { name: "Sheet1", xml: sheet1 },
        { name: "数据", xml: sheet2 },
      ],
      ["名称", "数量", "苹果"],
    );
    const saved = saveBytes(
      "session-x",
      "workbook.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xlsx,
    );

    const result = await tools.handleKbReadAttachment(
      { localPath: saved.localPath },
      { sessionId: "session-x" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.extension).toBe(".xlsx");
    expect(body.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // xlsx 返回 sheets（保留多表名与各表内容），不返回 content
    expect(body.sheets).toHaveLength(2);
    expect(body.sheets.map((s: { name: string }) => s.name)).toEqual([
      "Sheet1",
      "数据",
    ]);
    expect(body.sheets[0].content).toContain("名称");
    expect(body.sheets[0].content).toContain("苹果");
    expect(body.sheets[0].content).toContain("10");
    expect(body.sheets[1].content).toContain("42");
    // 不应混入页面参数 / HTML / CSS / 原始 XML 标签
    expect(body.sheets[0].content).not.toMatch(/[<]/);
    expect(body.sheets[1].content).not.toMatch(/[<]/);
    expect(body).not.toHaveProperty("content");
  });

  test("不支持格式 → 清晰错误（不读盘）", async () => {
    const result = await tools.handleKbReadAttachment(
      { localPath: "session-a/data.zip" },
      { sessionId: "session-a" },
    );
    expect(JSON.parse(result.content[0]!.text).error).toMatch(
      /不支持.*格式|kb_read_attachment 支持/,
    );
  });

  test("localPath 为空 → 清晰错误", async () => {
    const result = await tools.handleKbReadAttachment(
      { localPath: "   " },
      { sessionId: "session-a" },
    );
    expect(JSON.parse(result.content[0]!.text).error).toMatch(
      /localPath 不能为空/,
    );
  });

  test("只读：解析结果不写入知识库（无 documentId / ok 字段）", async () => {
    const docx = buildDocx(["草稿素材段落"]);
    const saved = saveBytes(
      "session-r",
      "note.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docx,
    );
    const result = await tools.handleKbReadAttachment(
      { localPath: saved.localPath },
      { sessionId: "session-r" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toHaveProperty("content");
    expect(body.content).toContain("草稿素材段落");
    expect(body).not.toHaveProperty("documentId");
    expect(body).not.toHaveProperty("ok");
    expect(body.truncated).toBe(false);
  });

  test("MD / TXT / CSV 文本附件直接读为 utf8 文本", async () => {
    const saved = saveBytes(
      "session-t",
      "notes.csv",
      "text/csv",
      strToU8("name,value\n苹果,10\n香蕉,20"),
    );
    const result = await tools.handleKbReadAttachment(
      { localPath: saved.localPath },
      { sessionId: "session-t" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.extension).toBe(".csv");
    expect(body.mediaType).toBe("text/csv");
    expect(body.content).toContain("苹果,10");
    expect(body.content).toContain("香蕉,20");
    expect(body).not.toHaveProperty("sheets");
  });
});
