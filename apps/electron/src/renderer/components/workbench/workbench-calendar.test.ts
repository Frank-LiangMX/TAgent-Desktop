import { describe, expect, it } from "vitest";
import type {
  Automation,
  WorkbenchEvent,
  WorkbenchState,
  WorkbenchTodo,
} from "@tagent/shared";
import {
  calendarDayItems,
  calendarRange,
  layoutCalendarDay,
  shiftCalendar,
} from "./workbench-calendar";

const day = "2026-10-12";
const at = (time: string) => new Date(`${day}T${time}`).getTime();
const base = {
  id: "id",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  project: "A",
};
const todo = (v: Partial<WorkbenchTodo> = {}): WorkbenchTodo => ({
  ...base,
  title: "评审",
  dueDate: day,
  completedAt: null,
  ...v,
});
const event = (v: Partial<WorkbenchEvent> = {}): WorkbenchEvent => ({
  ...base,
  title: "评审时间段",
  startAt: at("09:00"),
  endAt: at("10:00"),
  ...v,
});
const state = (): WorkbenchState => ({
  schemaVersion: 1,
  revision: 0,
  notes: [],
  todos: [],
  events: [],
  reports: [],
});
describe("unified local calendar", () => {
  it("keeps Monday-first grids across year boundaries and avoids month-end rollover", () => {
    expect(calendarRange("2027-01-01", "week")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
    const month = calendarRange("2026-02-28", "month");
    expect(month).toHaveLength(42);
    expect(month[0]).toBe("2026-01-26");
    expect(month.at(-1)).toBe("2026-03-08");
    expect(shiftCalendar("2026-01-31", "month", 1)).toBe("2026-02-01");
  });
  it("shows dated tasks without creating events and respects completion, project and search", () => {
    const s = state();
    s.todos = [
      todo(),
      todo({ id: "timed", dueTime: "14:30" }),
      todo({ id: "done", completedAt: 1 }),
      todo({ id: "other", project: "B" }),
      todo({ id: "undated", dueDate: "" }),
    ];
    expect(calendarDayItems(s, day, "A").map((i) => [i.id, i.at])).toEqual([
      ["id", null],
      ["timed", at("14:30")],
    ]);
    expect(calendarDayItems(s, day, "A", "评审", true)).toHaveLength(3);
    expect(calendarDayItems(s, day, "A", "missing")).toHaveLength(0);
    expect(s.events).toHaveLength(0);
  });
  it("clips overnight events and excludes their exclusive midnight end", () => {
    const s = state();
    s.events = [
      event({
        startAt: new Date("2026-10-11T23:00").getTime(),
        endAt: at("01:00"),
      }),
      event({
        id: "ended",
        startAt: new Date("2026-10-11T22:00").getTime(),
        endAt: at("00:00"),
      }),
    ];
    const items = calendarDayItems(s, day);
    expect(items).toHaveLength(1);
    expect(layoutCalendarDay(items, day)[0]).toMatchObject({
      start: 0,
      end: 60,
      visualEnd: 60,
    });
  });
  it("uses separate lanes for overlaps, while point tasks have no claimed duration", () => {
    const s = state();
    s.events = [
      event(),
      event({ id: "overlap", startAt: at("09:30"), endAt: at("11:00") }),
      event({ id: "later", startAt: at("12:00"), endAt: at("13:00") }),
    ];
    s.todos = [todo({ id: "point", dueTime: "09:45" })];
    const result = layoutCalendarDay(calendarDayItems(s, day), day);
    expect(result.filter((i) => i.start < 720).map((i) => i.lane)).toEqual([
      0, 1, 2,
    ]);
    expect(
      result.filter((i) => i.start < 720).every((i) => i.lanes === 3),
    ).toBe(true);
    expect(result.find((i) => i.item.id === "point")).toMatchObject({
      start: 585,
      end: 585,
    });
    expect(result.find((i) => i.item.id === "later")).toMatchObject({
      lane: 0,
      lanes: 1,
    });
  });
  it("shows only the enabled automation's actual next trigger, without projected recurrences", () => {
    const scheduled = {
      id: "job",
      name: "日报",
      enabled: true,
      nextRunAt: at("18:00"),
      scheduleType: "daily",
      timeOfDay: "18:00",
    } as Automation;
    const jobs = [scheduled, { ...scheduled, id: "paused", enabled: false }];
    expect(
      calendarDayItems(state(), day, "", "", false, jobs).map((i) => i.id),
    ).toEqual(["job"]);
    expect(
      calendarDayItems(state(), "2026-10-13", "", "", false, jobs),
    ).toHaveLength(0);
    expect(calendarDayItems(state(), day, "A", "", false, jobs)).toHaveLength(
      0,
    );
  });
});
