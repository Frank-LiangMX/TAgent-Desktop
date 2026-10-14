// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchDate, type WorkbenchMutationInput } from "@tagent/shared";
import { buildPiWorkbenchTools } from "../../../main/lib/workbench/workbench-agent-tools";
import { WorkbenchStore } from "../../../main/lib/workbench/workbench-store";
import { WorkbenchPage } from "./WorkbenchPage";

// Exercise real state/storage and user actions; omit unrelated rich Markdown/dialog primitives.
vi.mock("@tagent/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tagent/ui")>()),
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DestructiveConfirmDialog: () => null,
}));
let dir: string, root: Root, container: HTMLDivElement, store: WorkbenchStore;
const onNavigate = vi.fn(),
  onUseAgent = vi.fn();
const api = {
  readWorkbench: vi.fn(),
  mutateWorkbench: vi.fn(),
  onWorkbenchChanged: vi.fn(),
  exportWorkbench: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listAutomations: vi.fn(),
  listKnowledgeBaseDocuments: vi.fn(),
  createKnowledgeBaseDocument: vi.fn(),
  updateKnowledgeBaseDocument: vi.fn(),
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.clearAllMocks();
  localStorage.clear();
  dir = mkdtempSync(join(tmpdir(), "tagent-workbench-ui-"));
  store = new WorkbenchStore(join(dir, "workbench.json"));
  api.readWorkbench.mockImplementation(async () => store.read());
  api.mutateWorkbench.mockImplementation(
    async (input: WorkbenchMutationInput) => store.mutate(input),
  );
  api.onWorkbenchChanged.mockReturnValue(() => {});
  api.listAutomations.mockResolvedValue([]);
  api.listKnowledgeBases.mockResolvedValue([
    { id: "kb-test", name: "测试知识库" },
    { id: "kb-other", name: "项目资料" },
  ]);
  api.listKnowledgeBaseDocuments.mockResolvedValue([]);
  api.createKnowledgeBaseDocument.mockImplementation(async (input) => ({
    id: "kb-document",
    ...input,
  }));
  api.updateKnowledgeBaseDocument.mockImplementation(async (input) => input);
  window.electronAPI = api as unknown as typeof window.electronAPI;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => {
    root.render(
      <WorkbenchPage onNavigate={onNavigate} onUseAgent={onUseAgent} />,
    );
  });
};
function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button, [role=menuitem]"),
  ].find(
    (item) =>
      item.textContent?.trim() === label ||
      item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found;
}
const click = async (label: string) => {
  if (["待办", "工作记录", "知识库", "自动化"].includes(label)) {
    await act(async () => {
      button("更多").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
  }
  await act(async () => button(label).click());
};
async function choose(label: string, option: string) {
  await act(async () => {
    document
      .querySelector(`[role=combobox][aria-label="${label}"]`)!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
  });
  await act(async () => {
    const target = [
      ...document.querySelectorAll<HTMLElement>("[role=option]"),
    ].find((item) => item.textContent === option)!;
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}
async function input(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    element.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : element.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
const seed = (kind: "note" | "progress" = "note") =>
  store.mutate({
    expectedRevision: store.read().revision,
    change: {
      type: "save-note",
      content: "定位到了问题，尚待回归",
      tags: ["测试"],
      project: "项目甲",
      kind,
      occurredOn: workbenchDate(),
    },
  });

describe("workbench user workflows", () => {
  it("opens the existing automation page and keeps local calendar usable if loading jobs fails", async () => {
    const day = workbenchDate();
    store.mutate({
      expectedRevision: 0,
      change: {
        type: "save-todo",
        title: "本地安排",
        project: "",
        dueDate: day,
        dueTime: "10:00",
      },
    });
    api.listAutomations.mockResolvedValue([
      {
        id: "job",
        name: "日报",
        enabled: true,
        nextRunAt: new Date(`${day}T11:00`).getTime(),
      },
    ]);
    await render();
    await click("日程");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".wb-timed-item.is-automation")!
        .click(),
    );
    expect(onNavigate).toHaveBeenCalledWith("automation");
    await click("今天");
    api.listAutomations.mockRejectedValue(new Error("offline"));
    await click("日程");
    expect(container.textContent).toContain("自动任务暂时无法加载");
    expect(
      container.querySelector(".wb-timed-item.is-todo")?.textContent,
    ).toContain("本地安排");
    await click("新建日程");
    expect(document.querySelector("#wb-event-title")).not.toBeNull();
  });
  it("edits timed tasks from calendar and links or detaches a block without duplicating the task", async () => {
    const day = workbenchDate();
    const task = store.mutate({
      expectedRevision: 0,
      change: {
        type: "save-todo",
        title: "安排评审",
        project: "A",
        dueDate: day,
        dueTime: "14:30",
        area: "work",
      },
    }).todos[0]!;
    await render();
    await click("日程");
    expect(
      container.querySelector(".wb-timed-item.is-todo")?.textContent,
    ).toContain("14:30");
    expect(store.read().events).toHaveLength(0);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".wb-timed-item.is-todo")!
        .click(),
    );
    await input(
      document.querySelector<HTMLInputElement>('[aria-label="待办计划时间"]')!,
      "15:00",
    );
    await click("保存待办");
    expect(
      container.querySelector(".wb-timed-item.is-todo")?.textContent,
    ).toContain("15:00");
    await click("今天");
    await click(`为 ${task.title} 安排时间段`);
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="日程开始时间"]')
        ?.value,
    ).toBe("15:00");
    await click("保存日程");
    expect(store.read().events[0]).toMatchObject({
      todoId: task.id,
      project: "A",
    });
    expect(store.read().todos).toHaveLength(1);
    expect(store.read().todos[0]?.completedAt).toBeNull();
    await click("日程");
    await click("月视图");
    expect(container.querySelectorAll(".wb-month-day")).toHaveLength(42);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".wb-calendar-item.is-event")!
        .click(),
    );
    await choose("关联待办", "独立日程，不关联待办");
    await click("保存日程");
    expect(store.read().events[0]?.todoId).toBeUndefined();
    expect(store.read().todos[0]?.completedAt).toBeNull();
  });
  it("saves a new empty capture under the day selected in the week planner", async () => {
    await render();
    const day = [
      ...container.querySelectorAll<HTMLButtonElement>(".wb-week-day"),
    ].find((item) => item.getAttribute("aria-pressed") === "false")!;
    const selectedDate = day
      .getAttribute("aria-label")!
      .match(/\d{4}-\d{2}-\d{2}/)![0];
    await act(async () => day.click());
    await input(container.querySelector("textarea")!, "这一天的记录");
    await click("记下Ctrl ↵");
    expect(store.read().notes[0]?.occurredOn).toBe(selectedDate);
    expect(container.querySelector(".wb-note")?.textContent).toContain(
      "这一天的记录",
    );
  });
  it("starts collection in browse mode and preserves the draft when folding its input", async () => {
    seed();
    await render();
    await click("收集");
    expect(container.querySelector("textarea")).toBeNull();
    await click("新增收集");
    await input(container.querySelector("textarea")!, "临时想法，稍后再保存");
    await click("收起输入");
    expect(container.querySelector("textarea")).toBeNull();
    await click("新增收集");
    expect(container.querySelector("textarea")?.value).toBe(
      "临时想法，稍后再保存",
    );
    expect(store.read().notes).toHaveLength(1);
  });
  it("opens the selected calendar day without losing an unsaved capture", async () => {
    seed();
    await render();
    await input(container.querySelector("textarea")!, "还没保存的想法");
    const day = [
      ...container.querySelectorAll<HTMLButtonElement>(".wb-week-day"),
    ].find((item) => item.getAttribute("aria-pressed") === "false")!;
    await act(async () => day.click());
    expect(
      container
        .querySelector(".wb-week-day[aria-pressed=true]")
        ?.getAttribute("aria-label"),
    ).toBe(day.getAttribute("aria-label"));
    expect(container.querySelector("textarea")?.value).toBe("还没保存的想法");
    expect(container.querySelectorAll(".wb-note")).toHaveLength(0);
  });
  it("drills from collection chart into matching cards and can expand their full content", async () => {
    seed();
    store.mutate({
      expectedRevision: store.read().revision,
      change: {
        type: "save-note",
        content:
          "链接摘录 https://example.com/a\n" + "需要核对的完整内容".repeat(80),
        project: "",
        tags: [],
        kind: "note",
        occurredOn: workbenchDate(),
      },
    });
    await render();
    await click("回顾");
    await click("工作日报");
    expect(container.querySelector(".wb-activity")?.textContent).toContain(
      "留下 2 条记录",
    );
    const links = container.querySelectorAll<HTMLButtonElement>(
      ".wb-collection-chart .wb-collection-kind",
    )[1]!;
    await act(async () => links.click());
    expect(container.querySelectorAll(".wb-note")).toHaveLength(1);
    expect(container.querySelector(".wb-note")?.textContent).toContain(
      "链接摘录",
    );
    expect(
      container.querySelector(".wb-note-preview")?.textContent?.length,
    ).toBeLessThan(310);
    await click("展开全文");
    expect(
      container.querySelector(".wb-note-body")?.textContent?.length,
    ).toBeGreaterThan(700);
    expect(button("收起全文").getAttribute("aria-expanded")).toBe("true");
  });
  it("keeps knowledge inside five primary destinations and lets users record and generate a report without leaving Today", async () => {
    await render();
    const nav = container.querySelector(".wb-nav")!;
    expect(
      [...nav.children]
        .filter(
          (item) =>
            item.tagName === "BUTTON" &&
            item.getAttribute("aria-haspopup") !== "menu",
        )
        .map((item) => item.textContent),
    ).toEqual(["今天", "收集", "日程", "知识", "回顾"]);
    expect(button("更多").getAttribute("aria-expanded")).toBe("false");
    await input(
      container.querySelector("textarea")!,
      "完成方案评审，回归尚未结束",
    );
    await click("工作进展");
    await click("记下Ctrl ↵");
    expect(store.read().notes[0]?.kind).toBe("progress");
    await click("生成日报");
    expect(store.read().reports[0]?.body).toContain("回归尚未结束");
  });
  it("filters projects and tags with the shared menus and can return to all", async () => {
    seed();
    store.mutate({
      expectedRevision: store.read().revision,
      change: {
        type: "save-note",
        content: "另一个项目的记录",
        project: "0",
        tags: ["其他"],
        kind: "note",
        occurredOn: workbenchDate(),
      },
    });
    await render();
    await click("收集");
    await choose("项目筛选", "项目甲");
    expect(container.querySelectorAll(".wb-note")).toHaveLength(1);
    expect(container.querySelector(".wb-note")?.textContent).toContain(
      "尚待回归",
    );
    await choose("项目筛选", "全部项目");
    expect(container.querySelectorAll(".wb-note")).toHaveLength(2);
    await choose("标签筛选", "#其他");
    expect(container.querySelectorAll(".wb-note")).toHaveLength(1);
    expect(container.querySelector(".wb-note")?.textContent).toContain(
      "另一个项目",
    );
    await choose("标签筛选", "全部标签");
    expect(container.querySelectorAll(".wb-note")).toHaveLength(2);
    await choose("项目筛选", "0");
    expect(container.querySelector(".wb-note")?.textContent).toContain(
      "另一个项目",
    );
  });
  it("selects and clears the note date filter using the themed calendar", async () => {
    seed();
    await render();
    await click("收集");
    await click("笔记日期筛选");
    const today = workbenchDate();
    const tomorrowDate = new Date(`${today}T12:00:00`);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, "0")}-${String(tomorrowDate.getDate()).padStart(2, "0")}`;
    await click(tomorrow);
    expect(container.querySelectorAll(".wb-note")).toHaveLength(0);
    await click("笔记日期筛选");
    await click("清除");
    expect(container.querySelectorAll(".wb-note")).toHaveLength(1);
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });
  it("saves a batch of link originals before handing the extraction request to Agent", async () => {
    await render();
    const original =
      "收藏一组资料 https://example.com/a 和 https://example.com/b";
    await input(container.querySelector("textarea")!, original);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.wb-composer button[aria-haspopup="menu"]',
        )!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    await click("提炼链接核心信息");
    const saved = store.read().notes[0]!;
    expect(saved).toMatchObject({ content: original, kind: "note" });
    expect(onUseAgent).toHaveBeenCalledTimes(1);
    expect(onUseAgent.mock.calls[0]?.[0]).toContain(saved.id);
    expect(onUseAgent.mock.calls[0]?.[0]).toContain("https://example.com/b");
    expect(onUseAgent.mock.calls[0]?.[0]).toContain("没有字幕/转写");
    expect(container.querySelector("textarea")?.value).toBe("");
    const saveTool = buildPiWorkbenchTools({
      sessionId: "link-agent",
      executionMode: "work",
      store,
    }).find((tool) => tool.name === "workbench_add")!;
    await act(async () => {
      await saveTool.execute(
        "summary-call",
        {
          type: "note",
          content: "已核实的链接要点：主题 A，来源 https://example.com/a",
          sourceNoteId: saved.id,
          tags: ["阅读/链接"],
        },
        new AbortController().signal,
      );
      api.onWorkbenchChanged.mock.calls[0]![0]();
    });
    expect(container.querySelectorAll(".wb-note")).toHaveLength(2);
    expect(container.textContent).toContain("已核实的链接要点");
    await click("查看原始收集 1");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      original,
    );
  });
  it("keeps the input and never launches Agent when saving the source fails", async () => {
    api.mutateWorkbench.mockRejectedValueOnce(new Error("磁盘失败"));
    await render();
    await input(container.querySelector("textarea")!, "https://example.com/a");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.wb-composer button[aria-haspopup="menu"]',
        )!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    await click("提炼链接核心信息");
    expect(onUseAgent).not.toHaveBeenCalled();
    expect(store.read().notes).toHaveLength(0);
    expect(container.querySelector("textarea")?.value).toBe(
      "https://example.com/a",
    );
  });
  it("offers a weekly personal review from the review page", async () => {
    await render();
    await click("回顾");
    await click("让 Agent 回顾这周");
    expect(onUseAgent.mock.calls[0]?.[0]).toContain("workbench_search");
    expect(onUseAgent.mock.calls[0]?.[0]).toContain("生活与灵感");
  });
  it("makes casual notes optional and explains that they do not become daily work evidence", async () => {
    await render();
    await click("随手记录");
    expect(container.textContent).toContain("直接记下会保存原文");
    await input(container.querySelector("textarea")!, "随手摘录的一句话");
    await click("记下Ctrl ↵");
    expect(store.read().notes[0]?.kind).toBe("note");
    await click("生成日报");
    expect(store.read().reports).toHaveLength(0);
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "还没有工作进展",
    );
  });
  it("recovers an unsent note after remount, then saves and edits without reopening an empty draft", async () => {
    await render();
    await input(container.querySelector("textarea")!, "会议上发现新的问题");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector("textarea")?.value).toBe(
      "会议上发现新的问题",
    );
    await click("记下Ctrl ↵");
    expect(store.read().notes[0]?.content).toBe("会议上发现新的问题");
    expect(container.querySelector("textarea")?.value).toBe("");
    await click("编辑");
    await input(container.querySelector("textarea")!, "补充回归结果");
    await click("保存修改Ctrl ↵");
    await click("编辑");
    expect(container.querySelector("textarea")?.value).toBe("补充回归结果");
  });
  it("converts one note to one todo, preserves original content, and completes the todo explicitly", async () => {
    seed();
    await render();
    await click("转待办");
    await click("转待办");
    expect(store.read().todos).toHaveLength(1);
    expect(store.read().notes[0]?.content).toContain("尚待回归");
    await click("待办");
    expect(container.textContent).toContain("来源笔记");
    await click("完成：定位到了问题，尚待回归");
    expect(store.read().todos[0]?.completedAt).not.toBeNull();
    await click("已完成");
    expect(container.textContent).toContain("定位到了问题");
  });
  it("creates, edits, finalizes and regenerates a report while retaining its source and final body", async () => {
    seed("progress");
    await render();
    await click("工作记录");
    await click("汇总日报");
    expect(store.read().reports[0]?.sources).toHaveLength(1);
    await input(
      container.querySelector(".wb-report textarea")!,
      "# 经核对的日报\n\n仍在回归中。",
    );
    await click("保存草稿");
    await click("确认定稿");
    expect(container.querySelector(".wb-report textarea")).toBeNull();
    await click("汇总新草稿");
    const reports = store.read().reports;
    expect(reports).toHaveLength(2);
    expect(reports[0]?.status).toBe("final");
    expect(reports[0]?.body).toContain("经核对");
    expect(container.textContent).toContain("已定稿");
    expect(container.textContent).toContain("核对来源");
  });
  it("retains the input and surfaces save errors without pretending the note was saved", async () => {
    api.mutateWorkbench.mockRejectedValueOnce(new Error("测试：写入失败"));
    await render();
    await input(container.querySelector("textarea")!, "失败后不能丢失的草稿");
    await click("记下Ctrl ↵");
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "写入失败",
    );
    expect(container.querySelector("textarea")?.value).toBe(
      "失败后不能丢失的草稿",
    );
    expect(store.read().notes).toHaveLength(0);
  });
  it("detects a stale report draft after restart and never overwrites the newer saved version", async () => {
    seed("progress");
    await render();
    await click("工作记录");
    await click("汇总日报");
    await input(
      container.querySelector(".wb-report textarea")!,
      "尚未保存的旧草稿",
    );
    const current = store.read(),
      report = current.reports[0]!;
    store.mutate({
      expectedRevision: current.revision,
      change: {
        type: "save-report",
        id: report.id,
        expectedEntityRevision: report.revision,
        body: "其他窗口保存的新版本",
      },
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click("回顾");
    await click("工作日报");
    expect(container.querySelector(".wb-report textarea")?.textContent).toBe(
      "尚未保存的旧草稿",
    );
    expect(container.textContent).toContain("暂存的修改仍在");
    await click("保存草稿");
    expect(store.read().reports[0]?.body).toBe("其他窗口保存的新版本");
    await click("放弃暂存，载入最新");
    expect(
      (container.querySelector(".wb-report textarea") as HTMLTextAreaElement)
        .value,
    ).toBe("其他窗口保存的新版本");
  });
  it("passes only the chosen note to Agent and opens knowledge inside the workbench", async () => {
    seed();
    await render();
    expect(onUseAgent).not.toHaveBeenCalled();
    await click("交给 Agent");
    expect(onUseAgent).toHaveBeenCalledTimes(1);
    expect(onUseAgent.mock.calls[0]?.[0]).toContain(store.read().notes[0]!.id);
    await click("知识");
    expect(container.querySelector('[aria-label="个人知识"]')).not.toBeNull();
    expect(onNavigate).not.toHaveBeenCalledWith("knowledge");
    await click("自动化");
    expect(onNavigate).toHaveBeenCalledWith("automation");
  });
  it("requires selecting and confirming the knowledge destination before saving", async () => {
    seed();
    await render();
    await click("入知识库");
    expect(api.createKnowledgeBaseDocument).not.toHaveBeenCalled();
    await choose("目标知识库", "项目资料");
    await click("确认入库");
    expect(api.createKnowledgeBaseDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-other",
        content: "定位到了问题，尚待回归",
        originNote: expect.stringContaining(store.read().notes[0]!.id),
      }),
    );
    expect(store.read().notes).toHaveLength(1);
    expect(
      store
        .read()
        .activities?.filter((item) => item.entityType === "knowledge"),
    ).toMatchObject([{ tags: ["测试"], knowledgeBaseId: "kb-other" }]);
  });
  it("browses daily footprints and filters parent tags across facts and plans", async () => {
    const day = workbenchDate();
    const save = (change: import("@tagent/shared").WorkbenchMutation) =>
      store.mutate({ expectedRevision: store.read().revision, change });
    save({
      type: "save-note",
      content: "界面设计灵感",
      tags: ["产品/交互"],
      kind: "note",
      project: "",
      occurredOn: day,
    });
    const todo = save({
      type: "save-todo",
      title: "评审已完成",
      project: "",
      dueDate: day,
      tags: ["产品/交互"],
    }).todos[0]!;
    save({ type: "toggle-todo", id: todo.id });
    save({ type: "toggle-todo", id: todo.id });
    save({
      type: "save-note",
      content: "买菜清单",
      tags: ["生活"],
      kind: "note",
      project: "",
      occurredOn: day,
    });
    await render();
    await click("回顾");
    expect(container.querySelectorAll(".wb-history-days button")).toHaveLength(
      42,
    );
    expect(
      container.querySelector(".wb-history-timeline")?.textContent,
    ).toContain("完成事项");
    expect(
      container.querySelector(".wb-history-timeline")?.textContent,
    ).toContain("重新打开");
    await choose("标签筛选", "#产品");
    expect(
      container.querySelector(".wb-history-timeline")?.textContent,
    ).toContain("界面设计灵感");
    expect(
      container.querySelector(".wb-history-timeline")?.textContent,
    ).not.toContain("买菜清单");
    await click("足迹上个月");
    expect(
      container.querySelector(".wb-history-month-title")?.textContent,
    ).not.toContain(day.slice(0, 7));
  });
  it("organizes selected notes together and leaves all originals intact", async () => {
    seed();
    const source = store.read().notes[0]!;
    store.mutate({
      expectedRevision: store.read().revision,
      change: {
        type: "save-note",
        content: "第二条原始资料",
        tags: ["研究"],
        kind: "note",
        project: "",
        occurredOn: workbenchDate(),
      },
    });
    await render();
    await click("收集");
    await act(async () => {
      container
        .querySelectorAll<HTMLInputElement>(
          '.wb-note-category input[type="checkbox"]',
        )
        .forEach((input) => input.click());
    });
    await click("整理所选 · 2");
    const request = onUseAgent.mock.calls[0]![0];
    expect(request).toContain(source.id);
    expect(request).toContain(store.read().notes[1]!.id);
    expect(request).toContain("sourceNoteIds");
    expect(request).toContain("tags");
    expect(store.read().notes).toHaveLength(2);
  });
  it("retries a saved knowledge document without duplicating it when the history write failed", async () => {
    seed();
    const docs: object[] = [];
    api.listKnowledgeBaseDocuments.mockImplementation(async () => docs);
    api.createKnowledgeBaseDocument.mockImplementation(async (input) => {
      const doc = { id: "kb-document", ...input };
      docs.push(doc);
      return doc;
    });
    await render();
    await click("入知识库");
    api.mutateWorkbench.mockRejectedValueOnce(new Error("足迹写入失败"));
    await click("确认入库");
    expect(docs).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await click("确认入库");
    expect(api.createKnowledgeBaseDocument).toHaveBeenCalledTimes(1);
    expect(
      store
        .read()
        .activities?.filter((item) => item.entityType === "knowledge"),
    ).toHaveLength(1);
  });
  it("requires editable topic tags before putting an unclassified note into knowledge", async () => {
    store.mutate({
      expectedRevision: 0,
      change: {
        type: "save-note",
        content: "无标签原文",
        tags: [],
        kind: "note",
        project: "",
        occurredOn: workbenchDate(),
      },
    });
    await render();
    await click("入知识库");
    expect(button("确认入库").disabled).toBe(true);
    await input(
      document.querySelector<HTMLInputElement>('[aria-label="入库主题标签"]')!,
      "#阅读/方法",
    );
    await click("确认入库");
    expect(api.createKnowledgeBaseDocument).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["阅读/方法"] }),
    );
    expect(store.read().notes[0]?.tags).toEqual([]);
  });
});
