import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, it, expect } from "vitest";
import {
  workbenchFootprints,
  normalizeWorkbenchTags,
  workbenchHasTag,
  type WorkbenchMutation,
} from "@tagent/shared";
import { WorkbenchStore } from "./workbench-store";
import { buildPiWorkbenchTools } from "./workbench-agent-tools";
let dir: string, path: string, store: WorkbenchStore, now: number;
const stamp = (value: string) => new Date(value).getTime();
const save = (change: WorkbenchMutation) =>
  store.mutate({ expectedRevision: store.read().revision, change });
const note = (
  content = "评审记录",
  tags = ["产品/交互"],
  date = "2026-10-12",
) =>
  save({
    type: "save-note",
    content,
    tags,
    project: "工作台",
    kind: "progress",
    occurredOn: date,
  }).notes.at(-1)!;
const task = () =>
  save({
    type: "save-todo",
    title: "完成评审",
    project: "工作台",
    area: "work",
    dueDate: "2026-10-12",
    tags: ["产品/交互"],
  }).todos.at(-1)!;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tagent-history-"));
  path = join(dir, "state.json");
  now = stamp("2026-10-12T15:00");
  store = new WorkbenchStore(path, () => now);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it("keeps the original completion after reopening and renaming, including in a past report", () => {
  const todo = task();
  save({ type: "toggle-todo", id: todo.id });
  now = stamp("2026-10-13T10:00");
  save({ type: "toggle-todo", id: todo.id });
  save({
    type: "save-todo",
    id: todo.id,
    expectedEntityRevision: 3,
    title: "新一轮评审",
    tags: ["下一轮"],
    project: "工作台",
    dueDate: "2026-10-14",
  });
  const state = new WorkbenchStore(path).read();
  expect(workbenchFootprints(state, "2026-10-12")).toMatchObject([
    { action: "completed", title: "完成评审", tags: ["产品/交互"] },
  ]);
  expect(workbenchFootprints(state, "2026-10-13")).toMatchObject([
    { action: "reopened", title: "完成评审" },
  ]);
  const report = save({
    type: "create-report",
    date: "2026-10-12",
    project: "工作台",
  }).reports[0]!;
  expect(report.body).toContain("完成评审");
  expect(report.body).not.toContain("新一轮评审");
  expect(report.tags).toContain("产品/交互");
  expect(report.tags).not.toContain("下一轮");
});
it("migrates only surviving legacy facts before a reopened task can erase them", () => {
  const todo = task();
  const old = store.read();
  delete old.activities;
  delete old.historyStartedAt;
  old.todos[0]!.completedAt = now;
  writeFileSync(path, JSON.stringify(old));
  now = stamp("2026-10-13T10:00");
  const state = save({ type: "toggle-todo", id: todo.id });
  expect(state.historyStartedAt).toBe(now);
  expect(
    workbenchFootprints(state, "2026-10-12").filter(
      (item) => item.action === "completed",
    ),
  ).toHaveLength(1);
  expect(state.activities).toHaveLength(2);
});
it("keeps original note text and edit time without inventing a backfilled occurrence time", () => {
  const original = note("原始进展", ["项目/甲"], "2026-10-09");
  now = stamp("2026-10-13T11:20");
  save({
    type: "save-note",
    id: original.id,
    expectedEntityRevision: 1,
    content: "更新进展",
    tags: ["项目/乙"],
    kind: "progress",
    project: "工作台",
    occurredOn: "2026-10-09",
  });
  const state = store.read();
  const past = workbenchFootprints(state, "2026-10-09");
  expect(past.find((item) => item.text === "原始进展")).toMatchObject({
    at: null,
    tags: ["项目/甲"],
  });
  expect(workbenchFootprints(state, "2026-10-13")).toMatchObject([
    { action: "edited", text: "更新进展", at: now },
  ]);
  save({ type: "set-note-state", id: original.id, status: "trashed" });
  expect(workbenchFootprints(store.read(), "2026-10-09")).toEqual([]);
});
it("captures the surviving legacy note before its first edit and does not fabricate older versions", () => {
  const source = note("升级前的正文");
  const old = store.read();
  delete old.activities;
  delete old.historyStartedAt;
  writeFileSync(path, JSON.stringify(old));
  now = stamp("2026-10-13T11:00");
  save({
    type: "save-note",
    id: source.id,
    expectedEntityRevision: 1,
    content: "升级后的修改",
    tags: ["产品"],
    project: "工作台",
    kind: "progress",
    occurredOn: "2026-10-12",
  });
  const items = workbenchFootprints(store.read(), "2026-10-12");
  expect(items.find((item) => item.text === "升级前的正文")).toMatchObject({
    legacy: true,
    at: null,
  });
  expect(
    store.read().activities?.filter((item) => item.recovered),
  ).toHaveLength(1);
});
it("retains rescheduled and cancelled slots and never reports them as completed", () => {
  const event = save({
    type: "save-event",
    title: "产品评审",
    project: "工作台",
    tags: ["产品/评审"],
    startAt: stamp("2026-10-12T09:00"),
    endAt: stamp("2026-10-12T10:00"),
  }).events[0]!;
  save({
    type: "save-event",
    id: event.id,
    expectedEntityRevision: 1,
    title: "产品评审",
    project: "工作台",
    startAt: stamp("2026-10-14T09:00"),
    endAt: stamp("2026-10-14T10:00"),
  });
  save({ type: "delete-event", id: event.id });
  const state = new WorkbenchStore(path).read();
  expect(workbenchFootprints(state, "2026-10-12")).toMatchObject([
    { action: "rescheduled", tags: ["产品/评审"] },
  ]);
  expect(workbenchFootprints(state, "2026-10-14")).toMatchObject([
    { action: "cancelled", title: "产品评审" },
  ]);
  expect(state.activities?.some((item) => item.action === "completed")).toBe(
    false,
  );
});
it("shows a spanning current plan on every intersected local day with exclusive end", () => {
  save({
    type: "save-event",
    title: "跨日安排",
    project: "",
    startAt: stamp("2026-10-12T23:00"),
    endAt: stamp("2026-10-14T00:00"),
  });
  const items = workbenchFootprints(store.read(), "2026-10-12", "2026-10-14");
  expect(items.map((item) => item.occurredOn)).toEqual([
    "2026-10-12",
    "2026-10-13",
  ]);
  expect(items.every((item) => item.planned)).toBe(true);
  save({ type: "delete-event", id: store.read().events[0]!.id });
  expect(workbenchFootprints(store.read(), "2026-10-13")).toMatchObject([
    { action: "cancelled", planned: true },
  ]);
});
it("preserves an old plan when only its title changes, and pinning a note does not duplicate it", () => {
  const source = note();
  save({ type: "set-note-state", id: source.id, pinned: true });
  expect(
    workbenchFootprints(store.read(), "2026-10-12").filter(
      (item) => item.entityType === "note",
    ),
  ).toHaveLength(1);
  const event = save({
    type: "save-event",
    title: "旧标题",
    project: "",
    startAt: now,
    endAt: now + 3600000,
    tags: ["旧主题"],
  }).events[0]!;
  save({
    type: "save-event",
    id: event.id,
    expectedEntityRevision: 1,
    title: "新标题",
    project: "",
    startAt: now,
    endAt: now + 3600000,
    tags: ["新主题"],
  });
  expect(
    workbenchFootprints(store.read(), "2026-10-12").filter(
      (item) => item.entityType === "event",
    ),
  ).toMatchObject([
    { title: "旧标题", action: "rescheduled", tags: ["旧主题"] },
    { title: "新标题", action: "scheduled", tags: ["新主题"] },
  ]);
});
it("normalizes hierarchical tags and keeps snapshots searchable after later reclassification", () => {
  expect(
    normalizeWorkbenchTags([" #Product / UI ", "product/UI", "##灵感"]),
  ).toEqual(["product/UI", "灵感"]);
  expect(workbenchHasTag(["产品/交互"], "#产品")).toBe(true);
  expect(workbenchHasTag(["产品设计"], "产品")).toBe(false);
  const original = note();
  save({
    type: "save-note",
    id: original.id,
    expectedEntityRevision: 1,
    content: "更改",
    tags: ["生活"],
    kind: "note",
    project: "工作台",
    occurredOn: "2026-10-12",
  });
  expect(
    workbenchFootprints(
      store.read(),
      "2026-10-12",
      "2026-10-12",
      "",
      "产品",
    ).some((item) => item.text === "评审记录"),
  ).toBe(true);
});
it("requires tags for Agent results, preserves multiple sources, and rejects an invalid source in every type", async () => {
  const a = note("来源一"),
    b = note("来源二", ["研究"]);
  const tools = buildPiWorkbenchTools({
    store,
    sessionId: "s",
    executionMode: "work",
  });
  const call = async (id: string, args: object) =>
    JSON.parse(
      (
        (
          await tools
            .find((tool) => tool.name === "workbench_add")!
            .execute(id, args, new AbortController().signal)
        ).content[0]! as { text: string }
      ).text,
    );
  expect(
    await call("empty", { type: "note", content: "无标签结果" }),
  ).toMatchObject({ ok: false });
  const output = await call("multi", {
    type: "note",
    content: "主题整理",
    date: "2026-10-12",
    sourceNoteIds: [a.id, b.id, a.id],
  });
  expect(output.ok).toBe(true);
  expect(store.read().notes.at(-1)).toMatchObject({
    tags: ["产品/交互", "研究"],
    origin: { noteIds: [a.id, b.id] },
  });
  const read = await tools
    .find((tool) => tool.name === "workbench_history")!
    .execute(
      "read",
      { from: "2026-10-12", tag: "产品" },
      new AbortController().signal,
    );
  expect(
    JSON.parse((read.content[0]! as { text: string }).text).items.length,
  ).toBe(2);
  expect(() =>
    save({
      type: "save-todo",
      title: "非法来源",
      project: "",
      dueDate: "",
      tags: ["研究"],
      origin: { sessionId: "s", toolCallId: "bad", noteIds: ["missing"] },
    }),
  ).toThrow("不存在");
});
it("records knowledge once across restart and rejects tag removal from organized notes", () => {
  const source = note();
  const args: WorkbenchMutation = {
    type: "record-knowledge",
    documentId: "doc",
    knowledgeBaseId: "kb",
    noteId: source.id,
    title: "主题知识",
    tags: ["产品"],
  };
  save(args);
  store = new WorkbenchStore(path, () => now);
  save(args);
  expect(
    store.read().activities?.filter((item) => item.entityType === "knowledge"),
  ).toHaveLength(1);
  const organized = save({
    type: "save-note",
    content: "整理成果",
    kind: "note",
    occurredOn: "2026-10-12",
    project: "",
    tags: ["产品"],
    origin: { sessionId: "s", toolCallId: "c" },
  }).notes.at(-1)!;
  expect(() =>
    save({
      type: "save-note",
      id: organized.id,
      expectedEntityRevision: 1,
      content: "修改成果",
      kind: "note",
      occurredOn: "2026-10-12",
      project: "",
      tags: [],
    }),
  ).toThrow("主题标签");
});
