import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isChatModeBlockedTool, isAutoModeAutoAllowTool } from "@tagent/shared";
import { WorkbenchStore } from "./workbench-store";
import { buildPiWorkbenchTools } from "./workbench-agent-tools";

let dir: string, store: WorkbenchStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tagent-workbench-agent-"));
  store = new WorkbenchStore(join(dir, "state.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tools = () =>
  buildPiWorkbenchTools({ sessionId: "agent-1", executionMode: "work", store });
async function call(name: string, params: object, callId = "call-1") {
  const value = await tools()
    .find((tool) => tool.name === name)!
    .execute(callId, params, new AbortController().signal);
  return JSON.parse((value.content[0] as { text: string }).text);
}
function source(content = "原始分享 https://example.com/article") {
  return store
    .mutate({
      expectedRevision: store.read().revision,
      change: {
        type: "save-note",
        content,
        tags: ["生活"],
        project: "个人",
        kind: "note",
        occurredOn: "2026-10-12",
      },
    })
    .notes.at(-1)!;
}
describe("personal workbench Agent tools", () => {
  it("adds a timed task to the calendar and links a separate block using its project", async () => {
    const task = await call(
      "workbench_add",
      {
        type: "todo",
        title: "评审",
        tags: ["工作/评审"],
        project: "A",
        dueDate: "2026-10-12",
        dueTime: "14:30",
      },
      "task",
    );
    expect(task.ok).toBe(true);
    expect(store.read().events).toHaveLength(0);
    const block = await call(
      "workbench_add",
      {
        type: "event",
        title: "评审时间段",
        tags: ["工作/评审"],
        todoId: task.id,
        start: "2026-10-12T14:30",
        end: "2026-10-12T15:30",
      },
      "block",
    );
    expect(block.ok).toBe(true);
    expect(store.read().events[0]).toMatchObject({
      todoId: task.id,
      project: "A",
    });
    expect(store.read().todos).toHaveLength(1);
    expect(store.read().todos[0]?.completedAt).toBeNull();
    const search = await call("workbench_search", { query: "评审" });
    expect(
      search.items.find((i: { id: string }) => i.id === task.id),
    ).toMatchObject({ dueDate: "2026-10-12", dueTime: "14:30" });
    expect(
      search.items.find((i: { id: string }) => i.id === block.id),
    ).toMatchObject({ todoId: task.id });
    expect(
      await call(
        "workbench_add",
        { type: "todo", title: "无日期", dueTime: "14:30" },
        "invalid",
      ),
    ).toMatchObject({ ok: false });
    expect(
      await call(
        "workbench_add",
        {
          type: "todo",
          title: "无效时间",
          dueDate: "2026-10-12",
          dueTime: "25:00",
        },
        "invalid-time",
      ),
    ).toMatchObject({ ok: false });
  });
  it("preserves source notes, records result provenance, and does not duplicate a replay after restart", async () => {
    const original = source();
    const output = await call("workbench_add", {
      type: "note",
      content: "提炼的核心信息\n来源 https://example.com/article",
      sourceNoteId: original.id,
    });
    expect(output.ok).toBe(true);
    store = new WorkbenchStore(join(dir, "state.json"));
    const replay = await call("workbench_add", {
      type: "note",
      content: "重试内容",
      sourceNoteId: original.id,
    });
    expect(replay).toMatchObject({
      ok: true,
      id: output.id,
      alreadySaved: true,
    });
    const state = store.read();
    expect(state.notes).toHaveLength(2);
    expect(state.notes[0]!.content).toBe(original.content);
    expect(state.notes[1]).toMatchObject({
      kind: "note",
      origin: {
        noteId: original.id,
        sessionId: "agent-1",
        toolCallId: "call-1",
      },
    });
  });
  it("searches personal records and paginates full text without exposing trashed notes", async () => {
    const original = source("健身心得\n" + "练习".repeat(12000));
    const hidden = source("秘密草稿");
    store.mutate({
      expectedRevision: store.read().revision,
      change: { type: "set-note-state", id: hidden.id, status: "trashed" },
    });
    const found = await call("workbench_search", {
      query: "健身",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ id: original.id, truncated: true });
    const first = await call("workbench_get", { id: original.id });
    expect(first.text).toHaveLength(20000);
    expect(first.item.content).toBeUndefined();
    const second = await call("workbench_get", {
      id: original.id,
      offset: first.nextOffset,
    });
    expect(first.text + second.text).toBe(original.content);
    expect(second.nextOffset).toBeNull();
    expect(await call("workbench_get", { id: hidden.id })).toMatchObject({
      ok: false,
    });
    expect(
      (await call("workbench_search", { query: "秘密" })).items,
    ).toHaveLength(0);
  });
  it("creates local tasks and schedules with source references and rejects invalid times", async () => {
    const original = source("明天下午整理旅行计划");
    expect(
      await call(
        "workbench_add",
        {
          type: "todo",
          title: "整理旅行计划",
          dueDate: "2026-10-13",
          sourceNoteId: original.id,
        },
        "todo",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await call(
        "workbench_add",
        {
          type: "event",
          title: "整理旅行计划",
          start: "2026-10-13T14:00",
          end: "2026-10-13T15:00",
          sourceNoteId: original.id,
        },
        "event",
      ),
    ).toMatchObject({ ok: true, reminder: false, wpsSync: false });
    expect(store.read().todos[0]).toMatchObject({
      completedAt: null,
      origin: { noteId: original.id },
    });
    expect(store.read().events[0]!.startAt).toBe(
      new Date("2026-10-13T14:00").getTime(),
    );
    expect(
      await call(
        "workbench_add",
        {
          type: "event",
          title: "错误日期",
          start: "2026-02-30T14:00",
          end: "2026-03-03T15:00",
        },
        "bad",
      ),
    ).toMatchObject({ ok: false });
    expect(
      await call(
        "workbench_add",
        {
          type: "event",
          title: "倒置时间",
          start: "2026-10-13T16:00",
          end: "2026-10-13T15:00",
        },
        "bad-2",
      ),
    ).toMatchObject({ ok: false });
    expect(store.read().events).toHaveLength(1);
  });
  it("finds events that overlap a queried day and excludes unrelated projects", async () => {
    await call("workbench_add", {
      type: "event",
      title: "跨午夜安排",
      tags: ["生活"],
      project: "生活",
      start: "2026-10-12T23:00",
      end: "2026-10-13T01:00",
    });
    expect(
      (
        await call("workbench_search", {
          type: "event",
          from: "2026-10-13",
          to: "2026-10-13",
          project: "生活",
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (await call("workbench_search", { project: "工作" })).items,
    ).toHaveLength(0);
  });
  it("does not save against missing sources or report a failed write as successful", async () => {
    expect(
      await call("workbench_add", {
        type: "note",
        content: "结果",
        sourceNoteId: "missing",
      }),
    ).toMatchObject({ ok: false });
    const failing = buildPiWorkbenchTools({
      sessionId: "agent-1",
      executionMode: "work",
      store: {
        read: () => store.read(),
        mutate: () => {
          throw new Error("磁盘失败");
        },
      },
    }).find((tool) => tool.name === "workbench_add")!;
    const output = await failing.execute(
      "failed",
      { type: "note", content: "结果", tags: ["整理"] },
      new AbortController().signal,
    );
    expect(
      JSON.parse((output.content[0] as { text: string }).text),
    ).toMatchObject({ ok: false, error: "磁盘失败" });
    expect(store.read().notes).toHaveLength(0);
  });
  it("keeps Chat read-only and applies normal permissions to Work writes", () => {
    expect(
      buildPiWorkbenchTools({
        sessionId: "chat",
        executionMode: "chat",
        store,
      }).map((tool) => tool.name),
    ).toEqual(["workbench_history", "workbench_search", "workbench_get"]);
    expect(isChatModeBlockedTool("workbench_history", {})).toBe(false);
    expect(isAutoModeAutoAllowTool("workbench_history", {})).toBe(true);
    expect(isChatModeBlockedTool("workbench_get", {})).toBe(false);
    expect(isChatModeBlockedTool("workbench_add", {})).toBe(true);
    expect(isAutoModeAutoAllowTool("workbench_add", {})).toBe(false);
  });
});
