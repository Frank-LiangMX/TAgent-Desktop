import {
  workbenchDate,
  type WorkbenchNote,
  type WorkbenchState,
} from "@tagent/shared";
import { extractWorkbenchLinks } from "./workbench-agent-request";

export type CollectionKind = "all" | "ideas" | "links" | "progress";
export function collectionKind(
  note: WorkbenchNote,
): Exclude<CollectionKind, "all"> {
  return note.kind === "progress"
    ? "progress"
    : extractWorkbenchLinks(note.content).length
      ? "links"
      : "ideas";
}
export function dateOffset(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + offset);
  return workbenchDate(value.getTime());
}
export function overviewData(
  state: WorkbenchState,
  date: string,
  project: string,
) {
  const match = (item: { project: string }) =>
    !project || item.project === project;
  const notes = state.notes.filter(
    (item) => match(item) && item.status === "active",
  );
  const todos = state.todos.filter(match);
  const events = state.events.filter(match);
  const activity = Array.from({ length: 7 }, (_, i) => {
    const day = dateOffset(date, i - 6);
    return {
      date: day,
      notes: notes.filter((item) => item.occurredOn === day).length,
      completed: todos.filter(
        (item) =>
          item.completedAt !== null && workbenchDate(item.completedAt) === day,
      ).length,
    };
  });
  const monday = dateOffset(
    date,
    -((new Date(`${date}T12:00:00`).getDay() + 6) % 7),
  );
  const week = Array.from({ length: 7 }, (_, i) => {
    const day = dateOffset(monday, i);
    const start = new Date(`${day}T00:00:00`).getTime();
    const end = new Date(`${dateOffset(day, 1)}T00:00:00`).getTime();
    return {
      date: day,
      events: events
        .filter((item) => item.startAt < end && item.endAt > start)
        .sort((a, b) => a.startAt - b.startAt),
      due: todos.filter(
        (item) =>
          item.completedAt === null &&
          (item.startAt != null &&
          item.endAt != null &&
          item.endAt > item.startAt
            ? item.startAt < end && item.endAt > start
            : item.dueDate === day),
      ).length,
    };
  });
  return {
    activity,
    week,
    completed: todos.filter((item) => item.completedAt !== null).length,
    open: todos.filter((item) => item.completedAt === null).length,
    overdue: todos.filter(
      (item) =>
        item.completedAt === null &&
        (item.startAt != null && item.endAt != null && item.endAt > item.startAt
          ? item.endAt <= new Date(`${workbenchDate()}T00:00`).getTime()
          : !!item.dueDate && item.dueDate < workbenchDate()),
    ).length,
    collections: {
      ideas: notes.filter((item) => collectionKind(item) === "ideas").length,
      links: notes.filter((item) => collectionKind(item) === "links").length,
      progress: notes.filter((item) => collectionKind(item) === "progress")
        .length,
    },
  };
}
export type OverviewData = ReturnType<typeof overviewData>;
