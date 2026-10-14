import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createKnowledgeBase } from "./knowledge-base-store";
import {
  createKnowledgeBaseDocument,
  updateKnowledgeBaseDocument,
  getKnowledgeBaseDocument,
  listKnowledgeBaseDocuments,
  searchKnowledgeBaseDocuments,
} from "./knowledge-base-document-store";
import {
  buildKnowledgeBaseSharePackage,
  importKnowledgeBaseSharePackage,
} from "./kb-share-package";
import { KbProposeSaveService } from "./kb-propose-save-service";
let dir: string, previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tagent-kb-tags-"));
  previous = process.env.TAGENT_CONFIG_DIR;
  process.env.TAGENT_CONFIG_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.TAGENT_CONFIG_DIR;
  else process.env.TAGENT_CONFIG_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
it("persists normalized tags and searches them without rewriting the document text", () => {
  const kb = createKnowledgeBase({ name: "知识" });
  const doc = createKnowledgeBaseDocument({
    knowledgeBaseId: kb.id,
    title: "设计摘录",
    content: "减少选择成本",
    tags: ["#产品/交互", "产品/交互", " 灵感 "],
  });
  expect(getKnowledgeBaseDocument(doc.id)?.tags).toEqual(["产品/交互", "灵感"]);
  expect(listKnowledgeBaseDocuments(kb.id, "#产品")).toHaveLength(1);
  expect(
    searchKnowledgeBaseDocuments({
      knowledgeBaseIds: [kb.id],
      query: "产品",
    })[0],
  ).toMatchObject({
    documentId: doc.id,
    title: "设计摘录",
    tags: ["产品/交互", "灵感"],
    matchedIn: "tags",
  });
  expect(getKnowledgeBaseDocument(doc.id)?.content).toBe("减少选择成本");
  expect(
    JSON.parse(
      readFileSync(join(dir, "knowledge-base-documents.json"), "utf8"),
    )[0].tags,
  ).toEqual(doc.tags);
});
it("requires nonempty tags for Agent documents and prevents later clearing", () => {
  const kb = createKnowledgeBase({ name: "知识" });
  expect(() =>
    createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "整理成果",
      content: "内容",
      author: "agent",
    }),
  ).toThrow("主题标签");
  const doc = createKnowledgeBaseDocument({
    knowledgeBaseId: kb.id,
    title: "整理成果",
    content: "内容",
    author: "agent",
    tags: ["工作"],
  });
  expect(() =>
    updateKnowledgeBaseDocument({
      id: doc.id,
      title: doc.title,
      content: doc.content,
      tags: [],
    }),
  ).toThrow("主题标签");
  expect(
    updateKnowledgeBaseDocument({
      id: doc.id,
      title: doc.title,
      content: "更新内容",
    }).tags,
  ).toEqual(["工作"]);
});
it("preserves editable tags and provenance through export and import", () => {
  const kb = createKnowledgeBase({ name: "知识" });
  const doc = createKnowledgeBaseDocument({
    knowledgeBaseId: kb.id,
    title: "主题成果",
    content: "正文",
    author: "agent",
    tags: ["阅读/设计"],
    originNote: "工作台笔记 source · 版本 2",
    sources: [{ label: "source" }],
  });
  updateKnowledgeBaseDocument({
    id: doc.id,
    title: doc.title,
    content: doc.content,
    tags: ["产品/方法"],
  });
  const imported = importKnowledgeBaseSharePackage(
    buildKnowledgeBaseSharePackage(kb.id).package,
  );
  expect(listKnowledgeBaseDocuments(imported.id)[0]).toMatchObject({
    tags: ["产品/方法"],
    originNote: doc.originNote,
    sources: doc.sources,
  });
});
it("marks unclassified legacy Agent imports explicitly rather than inventing topics", () => {
  const kb = createKnowledgeBase({ name: "旧知识" });
  createKnowledgeBaseDocument({
    knowledgeBaseId: kb.id,
    title: "旧稿",
    content: "旧正文",
  });
  const pkg = buildKnowledgeBaseSharePackage(kb.id).package;
  pkg.documents[0]!.author = "agent";
  delete pkg.documents[0]!.tags;
  const imported = importKnowledgeBaseSharePackage(pkg);
  expect(listKnowledgeBaseDocuments(imported.id)[0]?.tags).toEqual([
    "未分类/历史导入",
  ]);
});
it("rejects an untagged confirmed proposal without silently saving a document", async () => {
  const kb = createKnowledgeBase({ name: "知识" });
  const service = new KbProposeSaveService();
  let requestId = "";
  const pending = service.handleProposeSave(
    "session",
    { knowledgeBaseId: kb.id, title: "未分类整理稿", content: "内容" },
    {
      sendToRenderer: (request) => {
        requestId = request.requestId;
      },
    },
  );
  service.respond({ requestId, action: "confirm" });
  expect(await pending).toMatchObject({ ok: false, reason: "write_failed" });
  expect(listKnowledgeBaseDocuments(kb.id)).toEqual([]);
});
it("keeps a backup of knowledge before editing and can read it if replacement was interrupted", () => {
  const kb = createKnowledgeBase({ name: "知识" });
  const doc = createKnowledgeBaseDocument({
    knowledgeBaseId: kb.id,
    title: "知识正文",
    content: "修改前",
    tags: ["产品"],
  });
  updateKnowledgeBaseDocument({
    id: doc.id,
    title: doc.title,
    content: "修改后",
    tags: ["研究"],
  });
  const file = join(dir, "knowledge-base-documents.json");
  expect(JSON.parse(readFileSync(file + ".bak", "utf8"))[0]).toMatchObject({
    content: "修改前",
    tags: ["产品"],
  });
  unlinkSync(file);
  expect(getKnowledgeBaseDocument(doc.id)?.content).toBe("修改前");
});
it("never replaces damaged knowledge with an empty collection", () => {
  const kb = createKnowledgeBase({ name: "知识" });
  const file = join(dir, "knowledge-base-documents.json"),
    damaged = '[{"title":"未完成';
  writeFileSync(file, damaged);
  expect(() =>
    createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "新笔记",
      content: "正文",
    }),
  ).toThrow("原文件已保留");
  expect(readFileSync(file, "utf8")).toBe(damaged);
});
