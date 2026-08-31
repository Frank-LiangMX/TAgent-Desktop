import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const share = await import("./kb-share-package");
const store = await import("./knowledge-base-store");
const docStore = await import("./knowledge-base-document-store");

let configDir = "";
let workDir = "";
let savedConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tagent-kb-share-cfg-"));
  workDir = mkdtempSync(join(tmpdir(), "tagent-kb-share-work-"));
  savedConfigDir = process.env.TAGENT_CONFIG_DIR;
  process.env.TAGENT_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  configDir = "";
  workDir = "";
  if (savedConfigDir === undefined) {
    delete process.env.TAGENT_CONFIG_DIR;
  } else {
    process.env.TAGENT_CONFIG_DIR = savedConfigDir;
  }
});

describe("kb-share-package · build", () => {
  test("导出库不存在 → 抛错", () => {
    expect(() => share.buildKnowledgeBaseSharePackage("no-such-kb")).toThrow(
      "知识库不存在",
    );
  });

  test("导出对象不含 relatedWorkspaceIds、不含原库 id、不含原文档 id/knowledgeBaseId", () => {
    const kb = store.createKnowledgeBase({
      name: "公约库",
      description: "团队公约",
      relatedWorkspaceIds: ["ws-1", "ws-2"],
    });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "接口公约",
      content: "所有工具调用必须先声明意图。",
      kind: "contract",
    });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    // 库元数据：无 id、无 relatedWorkspaceIds
    expect("id" in pkg.library).toBe(false);
    expect("relatedWorkspaceIds" in pkg.library).toBe(false);
    expect(pkg.library.name).toBe("公约库");
    expect(pkg.library.description).toBe("团队公约");
    // 文档：无 id、无 knowledgeBaseId、无 createdAt/updatedAt
    expect(pkg.documents).toHaveLength(1);
    const doc = pkg.documents[0]!;
    expect("id" in doc).toBe(false);
    expect("knowledgeBaseId" in doc).toBe(false);
    expect("createdAt" in doc).toBe(false);
    expect("updatedAt" in doc).toBe(false);
    expect(doc.title).toBe("接口公约");
    expect(doc.content).toBe("所有工具调用必须先声明意图。");
    expect(doc.kind).toBe("contract");
  });

  test("来源目录导出为 { label, path }，不含 id/createdAt/type", () => {
    const sourceDir = join(workDir, "src-a");
    mkdirSync(sourceDir, { recursive: true });
    const kb = store.createKnowledgeBase({
      name: "带来源库",
      sourcePaths: [sourceDir],
    });
    expect(kb.sources).toHaveLength(1);
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    expect(pkg.library.sources).toHaveLength(1);
    const src = pkg.library.sources![0]!;
    expect(src.label).toBe(kb.sources[0]!.label);
    expect(src.path).toBe(kb.sources[0]!.path);
    expect("id" in src).toBe(false);
    expect("createdAt" in src).toBe(false);
    expect("type" in src).toBe(false);
  });

  test("云来源元数据原样带上（url/provider/externalId/accessMode/syncedAt）", () => {
    const kb = store.createKnowledgeBase({ name: "云文档库" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "飞书设计稿",
      content: "正文",
      sourceUrl: "https://feishu.example/doc/abc",
      sourceProvider: "feishu",
      sourceExternalId: "abc",
      sourceAccessMode: "oauth",
      sourceSyncedAt: 1234567890,
    });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    const doc = pkg.documents[0]!;
    expect(doc.sourceUrl).toBe("https://feishu.example/doc/abc");
    expect(doc.sourceProvider).toBe("feishu");
    expect(doc.sourceExternalId).toBe("abc");
    expect(doc.sourceAccessMode).toBe("oauth");
    expect(doc.sourceSyncedAt).toBe(1234567890);
  });

  test("snapshotAt / originNote 原样带上", () => {
    const kb = store.createKnowledgeBase({ name: "快照库" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "资源快照",
      content: "统计 1234",
      kind: "snapshot",
      snapshotAt: 9900,
      originNote: "由会话确认沉淀",
    });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    const doc = pkg.documents[0]!;
    expect(doc.kind).toBe("snapshot");
    expect(doc.snapshotAt).toBe(9900);
    expect(doc.originNote).toBe("由会话确认沉淀");
  });
});

describe("kb-share-package · import 校验", () => {
  test("缺 format → 抛错", () => {
    const kb = store.createKnowledgeBase({ name: "源库" });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    const bad = { ...pkg } as Partial<typeof pkg>;
    delete bad.format;
    expect(() => share.importKnowledgeBaseSharePackage(bad)).toThrow(
      "format 不匹配",
    );
  });

  test("format 不匹配 → 抛错", () => {
    const kb = store.createKnowledgeBase({ name: "源库" });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    expect(() =>
      share.importKnowledgeBaseSharePackage({ ...pkg, format: "other" }),
    ).toThrow("format 不匹配");
  });

  test("缺 version → 抛错（不支持版本）", () => {
    const kb = store.createKnowledgeBase({ name: "源库" });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    const bad = { ...pkg } as Partial<typeof pkg>;
    delete bad.version;
    expect(() => share.importKnowledgeBaseSharePackage(bad)).toThrow(
      "不支持的分享包版本",
    );
  });

  test("version 不支持（未来版本）→ 抛错", () => {
    const kb = store.createKnowledgeBase({ name: "源库" });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    expect(() =>
      share.importKnowledgeBaseSharePackage({ ...pkg, version: 999 }),
    ).toThrow("不支持的分享包版本：999");
  });

  test("非对象 / null → 抛错", () => {
    expect(() => share.importKnowledgeBaseSharePackage(null)).toThrow(
      "不是合法的 JSON 对象",
    );
    expect(() => share.importKnowledgeBaseSharePackage("not json")).toThrow(
      "不是合法的 JSON 对象",
    );
    expect(() => share.importKnowledgeBaseSharePackage(undefined)).toThrow(
      "不是合法的 JSON 对象",
    );
  });

  test("缺 library → 抛错", () => {
    const kb = store.createKnowledgeBase({ name: "源库" });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    const bad = { ...pkg } as Partial<typeof pkg>;
    delete bad.library;
    expect(() => share.importKnowledgeBaseSharePackage(bad)).toThrow(
      "缺少库信息",
    );
  });

  test("库名称为空 → 抛错", () => {
    const kb = store.createKnowledgeBase({ name: "源库" });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    expect(() =>
      share.importKnowledgeBaseSharePackage({
        ...pkg,
        library: { ...pkg.library, name: "   " },
      }),
    ).toThrow("分享包库名称为空");
  });
});

describe("kb-share-package · roundtrip", () => {
  test("build → import roundtrip：标题/正文/kind 一致；新旧 id 不同", () => {
    const kb = store.createKnowledgeBase({
      name: "原库",
      description: "原描述",
    });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "接口公约 v1",
      content: "所有工具调用必须先声明意图。",
      kind: "contract",
    });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "资源统计快照",
      content: "探查时间 2026-08-27，统计 1234 个资源。",
      kind: "snapshot",
      snapshotAt: 1234,
      originNote: "由会话确认沉淀",
    });
    const { package: pkg, json } = share.buildKnowledgeBaseSharePackage(kb.id);

    // JSON 可往返解析
    expect(JSON.parse(json)).toEqual(pkg);

    const imported = share.importKnowledgeBaseSharePackage(pkg);
    // 新库 id 与原库不同
    expect(imported.id).not.toBe(kb.id);
    expect(imported.name).toBe("原库");
    expect(imported.description).toBe("原描述");
    // 默认不绑定目录
    expect(imported.sources).toEqual([]);

    const importedDocs = docStore.listKnowledgeBaseDocuments(imported.id);
    expect(importedDocs).toHaveLength(2);
    const byTitle = new Map(importedDocs.map((d) => [d.title, d]));
    const contract = byTitle.get("接口公约 v1")!;
    expect(contract.content).toBe("所有工具调用必须先声明意图。");
    expect(contract.kind).toBe("contract");
    expect(contract.id).not.toBe(
      // 新文档 id 与原文档不同
      docStore.listKnowledgeBaseDocuments(kb.id).find((d) => d.title === "接口公约 v1")!.id,
    );
    const snapshot = byTitle.get("资源统计快照")!;
    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.snapshotAt).toBe(1234);
    expect(snapshot.originNote).toBe("由会话确认沉淀");
  });

  test("空文档库也可导出 / 导入", () => {
    const kb = store.createKnowledgeBase({ name: "空库" });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    expect(pkg.documents).toEqual([]);
    expect(pkg.library.name).toBe("空库");

    const imported = share.importKnowledgeBaseSharePackage(pkg);
    expect(imported.id).not.toBe(kb.id);
    expect(imported.name).toBe("空库");
    expect(docStore.listKnowledgeBaseDocuments(imported.id)).toEqual([]);
  });

  test("导入默认不绑定目录（即便 package 带 path 且在本机存在）", () => {
    const sourceDir = join(workDir, "shareable");
    mkdirSync(sourceDir, { recursive: true });
    const kb = store.createKnowledgeBase({
      name: "带来源库",
      sourcePaths: [sourceDir],
    });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    expect(pkg.library.sources).toHaveLength(1);

    const imported = share.importKnowledgeBaseSharePackage(pkg);
    // 默认不绑定：新库 sources 为空
    expect(imported.sources).toEqual([]);
  });

  test("非法文档项（无标题）跳过，合法项仍导入", () => {
    const kb = store.createKnowledgeBase({ name: "源库" });
    docStore.createKnowledgeBaseDocument({
      knowledgeBaseId: kb.id,
      title: "好文档",
      content: "正文",
    });
    const { package: pkg } = share.buildKnowledgeBaseSharePackage(kb.id);
    // 注入一个无标题的坏文档项 + 一个非对象项
    const tampered = {
      ...pkg,
      documents: [
        ...pkg.documents,
        { content: "无标题" },
        "not-an-object",
        { title: "  ", content: "空白标题" },
        { title: "带云元数据", content: "c", sourceProvider: "wps" },
      ],
    };
    const imported = share.importKnowledgeBaseSharePackage(tampered);
    const docs = docStore.listKnowledgeBaseDocuments(imported.id);
    const titles = docs.map((d) => d.title).sort();
    expect(titles).toEqual(["好文档", "带云元数据"]);
    const cloud = docs.find((d) => d.title === "带云元数据")!;
    expect(cloud.sourceProvider).toBe("wps");
  });

  test("坏云元数据被丢弃，不阻断导入", () => {
    const pkg = {
      format: "tagent-kb-share",
      version: 1,
      exportedAt: 1,
      library: { name: "坏云元库" },
      documents: [
        {
          title: "文档",
          content: "正文",
          kind: "not-a-real-kind",
          sourceProvider: "not-a-provider",
          sourceAccessMode: "not-a-mode",
        },
      ],
    };
    const imported = share.importKnowledgeBaseSharePackage(pkg);
    const docs = docStore.listKnowledgeBaseDocuments(imported.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBeUndefined(); // 非法 kind 丢弃
    expect(docs[0]!.sourceProvider).toBeUndefined();
    expect(docs[0]!.sourceAccessMode).toBeUndefined();
  });
});
