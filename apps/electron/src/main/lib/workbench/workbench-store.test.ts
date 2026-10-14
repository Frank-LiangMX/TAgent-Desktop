import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkbenchMutation, WorkbenchState } from "@tagent/shared";
import { WorkbenchStore } from "./workbench-store";

let dir: string, path: string, store: WorkbenchStore, state: WorkbenchState;
const now = new Date("2026-10-12T18:30:00").getTime();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tagent-workbench-test-"));
  path = join(dir, "workbench.json");
  store = new WorkbenchStore(path, () => now);
  state = store.read();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mutate = (change: WorkbenchMutation) =>
  (state = store.mutate({ expectedRevision: state.revision, change }));
const note = (
  project = "项目甲",
  kind: "note" | "progress" = "progress",
  occurredOn = "2026-10-12",
) =>
  mutate({
    type: "save-note",
    content: "发现问题，回归仍未完成。",
    tags: ["评审", "评审"],
    project,
    kind,
    occurredOn,
  });

describe("local workbench durable workflow", () => {
  it("persists planned tasks and linked time blocks without completing or duplicating tasks", () => {
    note();
    const original = state.notes[0]!;
    mutate({
      type: "save-todo",
      title: "评审",
      project: "项目甲",
      dueDate: "2026-10-12",
      dueTime: "14:30",
      noteId: original.id,
    });
    const todo = state.todos[0]!;
    expect(state.events).toHaveLength(0);
    mutate({
      type: "save-event",
      title: "评审时间",
      project: todo.project,
      todoId: todo.id,
      startAt: now,
      endAt: now + 3600000,
    });
    const event = state.events[0]!;
    expect(new WorkbenchStore(path).read()).toEqual(state);
    mutate({
      type: "save-todo",
      id: todo.id,
      expectedEntityRevision: todo.revision,
      title: todo.title,
      project: "项目乙",
      dueDate: "",
    });
    expect(state.todos[0]).toMatchObject({
      dueDate: "",
      dueTime: "",
      completedAt: null,
    });
    expect(state.events[0]).toMatchObject({
      project: "项目乙",
      todoId: todo.id,
      revision: 2,
    });
    expect(() =>
      mutate({
        type: "save-event",
        id: event.id,
        expectedEntityRevision: event.revision,
        title: event.title,
        project: "项目乙",
        todoId: todo.id,
        startAt: now,
        endAt: now + 7200000,
      }),
    ).toThrow("新版本");
    mutate({
      type: "save-event",
      id: event.id,
      expectedEntityRevision: 2,
      title: "独立安排",
      project: "项目乙",
      todoId: null,
      startAt: now,
      endAt: now + 7200000,
    });
    expect(state.events[0]?.todoId).toBeUndefined();
    mutate({ type: "delete-event", id: event.id });
    expect(state.events).toHaveLength(0);
    expect(state.todos).toHaveLength(1);
    expect(state.todos[0]?.completedAt).toBeNull();
    expect(state.notes[0]).toEqual(original);
  });
  it("rejects invalid times and missing or mismatched task relationships without writing", () => {
    mutate({
      type: "save-todo",
      title: "评审",
      project: "A",
      dueDate: "2026-10-12",
    });
    const before = readFileSync(path, "utf8");
    for (const dueTime of ["24:00", "09:99"])
      expect(() =>
        mutate({
          type: "save-todo",
          title: "无效",
          project: "A",
          dueDate: "2026-10-12",
          dueTime,
        }),
      ).toThrow();
    expect(() =>
      mutate({
        type: "save-todo",
        title: "无日期",
        project: "A",
        dueDate: "",
        dueTime: "09:00",
      }),
    ).toThrow("计划日期");
    expect(() =>
      mutate({
        type: "save-event",
        title: "错项目",
        project: "B",
        todoId: state.todos[0]!.id,
        startAt: now,
        endAt: now + 1000,
      }),
    ).toThrow("同一项目");
    expect(() =>
      mutate({
        type: "save-event",
        title: "不存在",
        project: "A",
        todoId: "missing",
        startAt: now,
        endAt: now + 1000,
      }),
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  it("retains notes across store restarts, deduplicates tags and backs up previous successful revision", () => {
    note();
    expect(new WorkbenchStore(path).read()).toEqual(state);
    const previous = state;
    note("项目乙");
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual(previous);
    expect(state.notes[0]?.tags).toEqual(["评审"]);
  });
  it("keeps personal completions out of work reports and preserves legacy work tasks", () => {
    for (const [title, area] of [
      ["买菜", "personal"],
      ["完成评审", "work"],
      ["原有工作任务", undefined],
    ] as const) {
      mutate({ type: "save-todo", title, area, project: "", dueDate: "" });
      mutate({ type: "toggle-todo", id: state.todos.at(-1)!.id });
    }
    mutate({ type: "create-report", date: "2026-10-12", project: "" });
    expect(state.reports[0]!.body).not.toContain("买菜");
    expect(state.reports[0]!.body).toContain("完成评审");
    expect(state.reports[0]!.body).toContain("原有工作任务");
  });
  it("rejects stale whole-store writes without replacing data", () => {
    note();
    const saved = readFileSync(path, "utf8");
    expect(() =>
      store.mutate({
        expectedRevision: 0,
        change: { type: "toggle-todo", id: "missing" },
      }),
    ).toThrow("其他窗口");
    expect(readFileSync(path, "utf8")).toBe(saved);
  });
  it("does not overwrite an older editing draft even after a fresh global reload", () => {
    note();
    const original = state.notes[0]!;
    mutate({
      type: "save-note",
      id: original.id,
      expectedEntityRevision: 1,
      content: "更新版本",
      tags: [],
      project: "",
      kind: "note",
      occurredOn: "2026-10-12",
    });
    expect(() =>
      mutate({
        type: "save-note",
        id: original.id,
        expectedEntityRevision: 1,
        content: "过时草稿",
        tags: [],
        project: "",
        kind: "note",
        occurredOn: "2026-10-12",
      }),
    ).toThrow("新版本");
    expect(store.read().notes[0]?.content).toBe("更新版本");
  });
  it("converts a note once and preserves its body and identity", () => {
    note();
    const original = state.notes[0]!;
    const change = {
      type: "save-todo" as const,
      title: "回归测试",
      project: original.project,
      noteId: original.id,
      dueDate: "2026-10-13",
    };
    mutate(change);
    mutate(change);
    expect(state.todos).toHaveLength(1);
    expect(state.notes[0]).toEqual(original);
    expect(state.todos[0]?.completedAt).toBeNull();
  });
  it("supports recoverable trash and excludes trashed progress from new reports", () => {
    note();
    mutate({
      type: "set-note-state",
      id: state.notes[0]!.id,
      status: "trashed",
    });
    expect(() =>
      mutate({ type: "create-report", date: "2026-10-12", project: "" }),
    ).toThrow("没有工作进展");
    mutate({
      type: "set-note-state",
      id: state.notes[0]!.id,
      status: "active",
    });
    mutate({ type: "create-report", date: "2026-10-12", project: "" });
    expect(state.reports[0]?.sources[0]?.text).toBe("发现问题，回归仍未完成。");
  });
  it("reports only explicit progress and completed todos for the requested date/project", () => {
    note();
    note("项目乙");
    note("项目甲", "note");
    note("项目甲", "progress", "2026-10-11");
    mutate({
      type: "save-todo",
      title: "未完成事项",
      project: "项目甲",
      dueDate: "2026-10-12",
    });
    mutate({
      type: "save-todo",
      title: "完成的测试",
      project: "项目甲",
      dueDate: "",
    });
    mutate({ type: "toggle-todo", id: state.todos[1]!.id });
    mutate({
      type: "save-event",
      title: "计划评审",
      project: "项目甲",
      startAt: now,
      endAt: now + 60_000,
    });
    mutate({ type: "create-report", date: "2026-10-12", project: "项目甲" });
    const report = state.reports[0]!;
    expect(report.sources).toHaveLength(2);
    expect(report.body).toContain("回归仍未完成");
    expect(report.body).toContain("完成的测试");
    expect(report.body).not.toContain("未完成事项");
    expect(report.body).not.toContain("计划评审");
    expect(
      report.sources.every(
        (source) => source.revision === (source.type === "todo" ? 2 : 1),
      ),
    ).toBe(true);
  });
  it("retains source snapshots, user edits and final versions when regenerating a report", () => {
    note();
    mutate({ type: "create-report", date: "2026-10-12", project: "" });
    const original = state.reports[0]!;
    mutate({
      type: "save-report",
      id: original.id,
      expectedEntityRevision: 1,
      body: "# 人工修订的日报",
      finalize: true,
    });
    const final = state.reports[0]!;
    mutate({
      type: "save-note",
      id: state.notes[0]!.id,
      expectedEntityRevision: 1,
      content: "回归已完成",
      tags: [],
      project: "项目甲",
      kind: "progress",
      occurredOn: "2026-10-12",
    });
    mutate({ type: "create-report", date: "2026-10-12", project: "" });
    expect(state.reports).toHaveLength(2);
    expect(state.reports[0]).toEqual(final);
    expect(state.reports[0]?.sources[0]?.text).toContain("仍未完成");
    expect(state.reports[1]?.sources[0]?.text).toBe("回归已完成");
    expect(() =>
      mutate({
        type: "save-report",
        id: original.id,
        expectedEntityRevision: 2,
        body: "覆盖定稿",
      }),
    ).toThrow("定稿");
  });
  it("rejects impossible dates, blank notes and reversed event ranges before any write", () => {
    expect(() => note("", "note", "2026-02-30")).toThrow();
    expect(() =>
      mutate({
        type: "save-note",
        content: "  ",
        tags: [],
        project: "",
        kind: "note",
        occurredOn: "2026-10-12",
      }),
    ).toThrow();
    expect(() =>
      mutate({
        type: "save-event",
        title: "错误日程",
        project: "",
        startAt: now,
        endAt: now - 1,
      }),
    ).toThrow("结束时间");
    expect(store.read().revision).toBe(0);
  });
  it("preserves Markdown indentation and trailing newlines across restarts", () => {
    const markdown = "    indented code\n\n- 一个列表\n";
    mutate({
      type: "save-note",
      content: markdown,
      tags: [],
      project: "",
      kind: "note",
      occurredOn: "2026-10-12",
    });
    expect(new WorkbenchStore(path).read().notes[0]?.content).toBe(markdown);
  });
  it("preserves corrupt or future-version data instead of silently resetting", () => {
    for (const raw of [
      "{broken",
      JSON.stringify({ ...state, schemaVersion: 2 }),
    ]) {
      writeFileSync(path, raw);
      expect(() => store.read()).toThrow("原文件已保留");
      expect(() => note()).toThrow("原文件已保留");
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });
});
