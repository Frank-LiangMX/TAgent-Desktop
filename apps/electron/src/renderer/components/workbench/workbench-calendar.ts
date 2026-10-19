import {
  workbenchDate,
  type Automation,
  type WorkbenchEvent,
  type WorkbenchState,
  type WorkbenchTodo,
} from "@tagent/shared";
import { dateOffset } from "./workbench-overview";

export type CalendarMode = "week" | "month";
export function ganttRange(date: string, scale: CalendarMode): string[] {
  if (scale === "week") return calendarRange(date, "week");
  const first = `${date.slice(0, 7)}-01`;
  const count = new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)),
    0,
  ).getDate();
  return Array.from({ length: count }, (_, i) => dateOffset(first, i));
}
export function taskMatchesDay(todo: WorkbenchTodo, day: string): boolean {
  const interval = taskInterval(todo);
  return interval
    ? interval.start < new Date(`${dateOffset(day, 1)}T00:00`).getTime() &&
        interval.end > new Date(`${day}T00:00`).getTime()
    : todo.dueDate === day;
}
export function taskProgress(todo: WorkbenchTodo): number {
  return todo.completedAt !== null
    ? 100
    : Math.min(99, Math.max(0, todo.progress ?? 0));
}
export function taskDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return (
    [
      days ? `${days} 天` : "",
      hours ? `${hours} 小时` : "",
      rest ? `${rest} 分钟` : "",
    ]
      .filter(Boolean)
      .join(" ") || "不足 1 分钟"
  );
}
export function taskInterval(
  todo: WorkbenchTodo,
): { start: number; end: number } | null {
  if (todo.startAt != null && todo.endAt != null && todo.endAt > todo.startAt)
    return { start: todo.startAt, end: todo.endAt };
  return null;
}
export function calendarTodos(
  state: WorkbenchState,
  project: string,
  query: string,
  showCompleted: boolean,
) {
  return state.todos.filter(
    (todo) =>
      (!project || todo.project === project) &&
      todo.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
      (showCompleted || todo.completedAt === null),
  );
}
export type CalendarItem =
  | {
      kind: "todo";
      id: string;
      title: string;
      at: number | null;
      todo: WorkbenchTodo;
    }
  | {
      kind: "event";
      id: string;
      title: string;
      at: number;
      event: WorkbenchEvent;
    }
  | {
      kind: "automation";
      id: string;
      title: string;
      at: number;
      automation: Automation;
    };
export function calendarRange(date: string, mode: CalendarMode): string[] {
  const anchor = mode === "week" ? date : `${date.slice(0, 7)}-01`;
  const monday = dateOffset(
    anchor,
    -((new Date(`${anchor}T12:00:00`).getDay() + 6) % 7),
  );
  return Array.from({ length: mode === "week" ? 7 : 42 }, (_, i) =>
    dateOffset(monday, i),
  );
}
export function shiftCalendar(
  date: string,
  mode: CalendarMode,
  amount: number,
): string {
  if (mode === "week") return dateOffset(date, amount * 7);
  const value = new Date(`${date.slice(0, 7)}-01T12:00:00`);
  value.setMonth(value.getMonth() + amount);
  return workbenchDate(value.getTime());
}
export function calendarDayItems(
  state: WorkbenchState,
  day: string,
  project = "",
  query = "",
  showCompleted = false,
  automations: Automation[] = [],
): CalendarItem[] {
  const match = (item: { project: string; title: string }) =>
    (!project || item.project === project) &&
    item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = new Date(`${dateOffset(day, 1)}T00:00:00`).getTime();
  const result: CalendarItem[] = [
    ...calendarTodos(state, project, query, showCompleted)
      .filter((todo) =>
        taskInterval(todo)
          ? taskInterval(todo)!.start < end && taskInterval(todo)!.end > start
          : todo.dueDate === day,
      )
      .map((todo) => ({
        kind: "todo" as const,
        id: todo.id,
        title: todo.title,
        at: taskInterval(todo)
          ? Math.max(start, taskInterval(todo)!.start)
          : todo.dueTime
            ? new Date(`${day}T${todo.dueTime}`).getTime()
            : null,
        todo,
      })),
    ...state.events
      .filter(
        (event) => match(event) && event.startAt < end && event.endAt > start,
      )
      .map((event) => ({
        kind: "event" as const,
        id: event.id,
        title: event.title,
        at: Math.max(start, event.startAt),
        event,
      })),
    // The existing scheduler owns recurrence. Display its next known trigger only.
    ...automations
      .filter(
        (item) =>
          !project &&
          item.enabled &&
          item.nextRunAt >= start &&
          item.nextRunAt < end &&
          item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      )
      .map((automation) => ({
        kind: "automation" as const,
        id: automation.id,
        title: automation.name,
        at: automation.nextRunAt,
        automation,
      })),
  ];
  return result.sort(
    (a, b) => (a.at ?? -1) - (b.at ?? -1) || a.title.localeCompare(b.title),
  );
}

/** Layout overlapping blocks in separate lanes; point markers reserve visual space, not task duration. */
export function layoutCalendarDay(items: CalendarItem[], day: string) {
  const dayStart = new Date(`${day}T00:00:00`).getTime();
  const dayEnd = new Date(`${dateOffset(day, 1)}T00:00:00`).getTime();
  const minute = (stamp: number) => {
    const d = new Date(stamp);
    return d.getHours() * 60 + d.getMinutes();
  };
  const positioned = items
    .filter((item) => item.at !== null)
    .map((item) => {
      const interval =
        item.kind === "event"
          ? { start: item.event.startAt, end: item.event.endAt }
          : item.kind === "todo"
            ? taskInterval(item.todo)
            : null;
      const start =
        interval && interval.start < dayStart ? 0 : minute(item.at!);
      const end = interval
        ? interval.end >= dayEnd
          ? 1440
          : minute(interval.end)
        : start;
      return {
        item,
        start,
        end,
        visualEnd: Math.min(1440, Math.max(start + 48, end)),
        lane: 0,
        lanes: 1,
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: typeof positioned = [];
  let ends: number[] = [];
  const flush = () => {
    for (const item of cluster) item.lanes = ends.length;
    cluster = [];
    ends = [];
  };
  for (const item of positioned) {
    if (cluster.length && item.start >= Math.max(...ends)) flush();
    let lane = ends.findIndex((end) => end <= item.start);
    if (lane < 0) lane = ends.length;
    item.lane = lane;
    ends[lane] = item.visualEnd;
    cluster.push(item);
  }
  flush();
  return positioned;
}
