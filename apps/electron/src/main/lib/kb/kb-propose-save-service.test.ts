import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbProposeSaveRequest } from "@tagent/shared";

const service = await import("./kb-propose-save-service");
const store = await import("./knowledge-base-store");
const docStore = await import("./knowledge-base-document-store");

let configDir = "";
let savedConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tagent-kb-propose-cfg-"));
  savedConfigDir = process.env.TAGENT_CONFIG_DIR;
  process.env.TAGENT_CONFIG_DIR = configDir;
});

afterEach(() => {
  // 兜底清掉残留 pending，避免用例间串味
  service.kbProposeSaveService.clearSessionPending("session-svc");
  service.kbProposeSaveService.clearSessionPending("session-other");
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = "";
  if (savedConfigDir === undefined) {
    delete process.env.TAGENT_CONFIG_DIR;
  } else {
    process.env.TAGENT_CONFIG_DIR = savedConfigDir;
  }
});

/** 捕获 sendToRenderer 推送的请求，便于随后 respond / abort */
function captureSender(captured: KbProposeSaveRequest[]) {
  return (request: KbProposeSaveRequest) => captured.push(request);
}

describe("kb-propose-save-service", () => {
  test("confirm → 写入正式文档并 resolve ok:true + documentId", async () => {
    const kb = store.createKnowledgeBase({ name: "公约库" });
    const captured: KbProposeSaveRequest[] = [];
    const pending = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      {
        knowledgeBaseId: kb.id,
        title: "接口公约 v1",
        content: "所有工具调用必须先声明意图。",
      },
      { sendToRenderer: captureSender(captured) },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      sessionId: "session-svc",
      knowledgeBaseId: kb.id,
      knowledgeBaseName: "公约库",
      title: "接口公约 v1",
    });

    const handled = service.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "confirm",
    });
    expect(handled).toEqual({ sessionId: "session-svc", action: "confirm" });

    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      knowledgeBaseId: kb.id,
      title: "接口公约 v1",
    });
    expect((result as { documentId: string }).documentId).toBeTruthy();

    // 文档确实落盘
    const docs = docStore.listKnowledgeBaseDocumentsForIds([kb.id]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("接口公约 v1");
  });

  test("reject → 零写入，resolve ok:false user_rejected", async () => {
    const kb = store.createKnowledgeBase({ name: "统计库" });
    const captured: KbProposeSaveRequest[] = [];
    const pending = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      { knowledgeBaseId: kb.id, title: "不该写入的统计", content: "内容" },
      { sendToRenderer: captureSender(captured) },
    );
    service.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "reject",
    });
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: "user_rejected" });
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);
  });

  test("clearSessionPending（会话停止）→ 零写入，resolve ok:false aborted，返回已清 requestId", async () => {
    const kb = store.createKnowledgeBase({ name: "规范库" });
    const captured: KbProposeSaveRequest[] = [];
    const pending = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      { knowledgeBaseId: kb.id, title: "被中止的规范", content: "内容" },
      { sendToRenderer: captureSender(captured) },
    );
    const cleared = service.kbProposeSaveService.clearSessionPending(
      "session-svc",
    );
    expect(cleared).toEqual([captured[0]!.requestId]);
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: "aborted" });
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);
  });

  test("signal abort → 零写入，resolve ok:false aborted", async () => {
    const kb = store.createKnowledgeBase({ name: "快照库" });
    const controller = new AbortController();
    const captured: KbProposeSaveRequest[] = [];
    const pending = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      { knowledgeBaseId: kb.id, title: "被中止的快照", content: "内容" },
      { sendToRenderer: captureSender(captured), signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: "aborted" });
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(0);
  });

  test("clearSessionPending 只清目标会话，不影响其他会话 pending", async () => {
    const kb = store.createKnowledgeBase({ name: "隔离库" });
    const capA: KbProposeSaveRequest[] = [];
    const capB: KbProposeSaveRequest[] = [];
    const pendingA = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      { knowledgeBaseId: kb.id, title: "A 文档", content: "A" },
      { sendToRenderer: captureSender(capA) },
    );
    const pendingB = service.kbProposeSaveService.handleProposeSave(
      "session-other",
      { knowledgeBaseId: kb.id, title: "B 文档", content: "B" },
      { sendToRenderer: captureSender(capB) },
    );
    // 只清 session-svc
    const cleared = service.kbProposeSaveService.clearSessionPending(
      "session-svc",
    );
    expect(cleared).toEqual([capA[0]!.requestId]);
    expect(await pendingA).toEqual({ ok: false, reason: "aborted" });
    // session-other 仍可正常 confirm
    service.kbProposeSaveService.respond({
      requestId: capB[0]!.requestId,
      action: "confirm",
    });
    expect(await pendingB).toMatchObject({ ok: true, title: "B 文档" });
    expect(docStore.listKnowledgeBaseDocumentsForIds([kb.id])).toHaveLength(1);
  });

  test("respond 未知 requestId → 返回 null（幂等，不动 pending）", async () => {
    const handled = service.kbProposeSaveService.respond({
      requestId: "no-such-request",
      action: "confirm",
    });
    expect(handled).toBeNull();
  });

  test("kind 透传到请求与落盘；写入正文不变", async () => {
    const kb = store.createKnowledgeBase({ name: "类型库" });
    const captured: KbProposeSaveRequest[] = [];
    const pending = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      {
        knowledgeBaseId: kb.id,
        title: "公约带类型",
        content: "正文内容",
        kind: "contract",
      },
      { sendToRenderer: captureSender(captured) },
    );
    expect(captured[0]!.kind).toBe("contract");
    service.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "confirm",
    });
    const result = await pending;
    expect(result.ok).toBe(true);
    const docs = docStore.listKnowledgeBaseDocumentsForIds([kb.id]);
    expect(docs[0]!.content).toBe("正文内容");
    // 刀 2 §A：入参带 kind → 落盘带 kind；统一记沉淀来源
    expect(docs[0]!.kind).toBe("contract");
    expect(docs[0]!.originNote).toContain("确认沉淀");
    // 非 snapshot 不写 snapshotAt
    expect(docs[0]!.snapshotAt).toBeUndefined();
  });

  test("kind=snapshot confirm → 文档带 kind=snapshot + snapshotAt + originNote", async () => {
    const kb = store.createKnowledgeBase({ name: "快照库" });
    const captured: KbProposeSaveRequest[] = [];
    const pending = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      {
        knowledgeBaseId: kb.id,
        title: "UE 资源统计快照",
        content: "探查时间 2026-08-27，统计 1234 个资源。",
        kind: "snapshot",
      },
      { sendToRenderer: captureSender(captured) },
    );
    expect(captured[0]!.kind).toBe("snapshot");
    service.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "confirm",
    });
    const result = await pending;
    expect(result.ok).toBe(true);
    const docs = docStore.listKnowledgeBaseDocumentsForIds([kb.id]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe("snapshot");
    expect(docs[0]!.snapshotAt).toBeGreaterThan(0);
    expect(docs[0]!.originNote).toContain("确认沉淀");
  });

  test("无 kind confirm → 文档无 kind 字段（读取时归一 note），仍记 originNote", async () => {
    const kb = store.createKnowledgeBase({ name: "无类型库" });
    const captured: KbProposeSaveRequest[] = [];
    const pending = service.kbProposeSaveService.handleProposeSave(
      "session-svc",
      { knowledgeBaseId: kb.id, title: "普通笔记", content: "内容" },
      { sendToRenderer: captureSender(captured) },
    );
    expect(captured[0]!.kind).toBeUndefined();
    service.kbProposeSaveService.respond({
      requestId: captured[0]!.requestId,
      action: "confirm",
    });
    expect((await pending).ok).toBe(true);
    const docs = docStore.listKnowledgeBaseDocumentsForIds([kb.id]);
    expect(docs[0]!.kind).toBeUndefined();
    expect(docs[0]!.snapshotAt).toBeUndefined();
    expect(docs[0]!.originNote).toContain("确认沉淀");
  });
});
