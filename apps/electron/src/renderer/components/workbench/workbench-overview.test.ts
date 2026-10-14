import { describe, expect, it } from "vitest";
import { type WorkbenchNote, type WorkbenchState } from "@tagent/shared";
import { collectionKind, dateOffset, overviewData } from "./workbench-overview";

const entity = {
  id: "id",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  project: "A",
};
const note = (values: Partial<WorkbenchNote> = {}): WorkbenchNote => ({
  ...entity,
  content: "一个想法",
  kind: "note",
  tags: [],
  pinned: false,
  status: "active",
  occurredOn: "2026-10-12",
  ...values,
});
const empty = (): WorkbenchState => ({
  schemaVersion: 1,
  revision: 0,
  notes: [],
  todos: [],
  events: [],
  reports: [],
});
describe("personal workbench overview data", () => {
  it("uses exclusive content categories and excludes archived, trashed and other projects", () => {
    const state = empty();
    state.notes = [
      note(),
      note({ content: "资料 https://example.com/a" }),
      note({ kind: "progress", content: "核对 https://example.com/a" }),
      note({ status: "archived" }),
      note({ status: "trashed" }),
      note({ project: "B" }),
    ];
    const data = overviewData(state, "2026-10-12", "A");
    expect(data.collections).toEqual({ ideas: 1, links: 1, progress: 1 });
    expect(data.activity.at(-1)?.notes).toBe(3);
    expect(collectionKind(state.notes[2]!)).toBe("progress");
    expect(overviewData(state, "2026-10-12", "").collections.ideas).toBe(2);
  });
  it("counts completions by local completion day and only open dated items in the week", () => {
    const state = empty();
    state.todos = [
      {
        ...entity,
        title: "生活",
        area: "personal",
        dueDate: "2026-10-13",
        completedAt: null,
      },
      {
        ...entity,
        title: "工作",
        area: "work",
        dueDate: "2026-10-13",
        completedAt: new Date("2026-10-12T23:59:00").getTime(),
      },
      { ...entity, title: "未定", dueDate: "", completedAt: null },
      {
        ...entity,
        project: "B",
        title: "其他",
        dueDate: "2026-10-13",
        completedAt: null,
      },
    ];
    const data = overviewData(state, "2026-10-12", "A");
    expect([data.open, data.completed]).toEqual([2, 1]);
    expect(data.activity.at(-1)?.completed).toBe(1);
    expect(data.week[1]?.due).toBe(1);
  });
  it("includes overnight events on overlapping days but excludes the exact ending midnight", () => {
    const state = empty();
    state.events = [
      {
        ...entity,
        title: "跨天安排",
        startAt: new Date("2026-10-11T23:00:00").getTime(),
        endAt: new Date("2026-10-13T00:00:00").getTime(),
      },
    ];
    const data = overviewData(state, "2026-10-12", "A");
    expect(data.week.map((day) => day.events.length)).toEqual([
      1, 0, 0, 0, 0, 0, 0,
    ]);
    expect(data.week[0]?.date).toBe("2026-10-12");
    expect(dateOffset("2026-01-01", -1)).toBe("2025-12-31");
    expect(overviewData(empty(), "2026-01-01", "").activity[0]?.date).toBe(
      "2025-12-26",
    );
  });
});
