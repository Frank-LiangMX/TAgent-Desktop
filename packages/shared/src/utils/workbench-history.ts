import {
  workbenchDate,
  workbenchHasTag,
  type WorkbenchActivity,
  type WorkbenchState,
} from "../types/workbench";

export type WorkbenchFootprint = WorkbenchActivity & {
  legacy?: boolean;
  planned?: boolean;
  current?: boolean;
};
export const workbenchActivityLabel: Record<
  WorkbenchActivity["action"],
  string
> = {
  recorded: "记下一笔",
  edited: "修改记录",
  completed: "完成事项",
  reopened: "重新打开",
  scheduled: "计划安排",
  rescheduled: "原计划已调整",
  cancelled: "计划已取消",
  saved: "保存成果",
  finalized: "日报定稿",
};
/** Read-only view over saved facts and surviving legacy state. Never infers execution from a plan. */
export function workbenchFootprints(
  state: WorkbenchState,
  from: string,
  to = from,
  project = "",
  tag = "",
  query = "",
): WorkbenchFootprint[] {
  const activities = state.activities ?? [];
  const hidden = new Set(
    state.notes.filter((n) => n.status === "trashed").map((n) => n.id),
  );
  const result: WorkbenchFootprint[] = activities
    .filter((item) => item.entityType !== "note" || !hidden.has(item.entityId))
    .flatMap((item) => {
      if (
        item.entityType !== "event" ||
        item.startAt === undefined ||
        item.endAt === undefined
      )
        return [{ ...item, legacy: item.recovered }];
      const start = workbenchDate(item.startAt),
        end = workbenchDate(item.endAt - 1);
      if (start > to || end < from) return [];
      const cursor = new Date(`${start < from ? from : start}T12:00:00`),
        last = end > to ? to : end;
      const slots: WorkbenchFootprint[] = [];
      for (
        let count = 0;
        count < 3660 && workbenchDate(cursor.getTime()) <= last;
        count++, cursor.setDate(cursor.getDate() + 1)
      ) {
        const shown = workbenchDate(cursor.getTime());
        slots.push({
          ...item,
          id: `${item.id}:${shown}`,
          occurredOn: shown,
          at: Math.max(item.startAt, new Date(`${shown}T00:00:00`).getTime()),
          planned: true,
        });
      }
      return slots;
    });
  const keys = new Set(
    activities.flatMap((item) => [
      `${item.entityType}:${item.entityId}`,
      `${item.entityType}:${item.entityId}:${item.action}`,
    ]),
  );
  const noteVersions = new Set(
    activities
      .filter((item) => item.entityType === "note")
      .map((item) =>
        JSON.stringify([
          item.entityId,
          item.occurredOn,
          item.text,
          item.tags,
          item.project,
        ]),
      ),
  );
  const has = (id: string, type: string, action?: string) =>
    keys.has(`${type}:${id}${action ? `:${action}` : ""}`);
  for (const note of state.notes.filter((n) => n.status !== "trashed")) {
    // Current occurrence remains visible on the claimed day even if the record was edited later.
    if (
      !noteVersions.has(
        JSON.stringify([
          note.id,
          note.occurredOn,
          note.content,
          note.tags,
          note.project,
        ]),
      )
    )
      result.push({
        id: `note:${note.id}`,
        entityId: note.id,
        entityType: "note",
        revision: note.revision,
        action: "recorded",
        occurredOn: note.occurredOn,
        recordedAt: note.updatedAt,
        at: null,
        title: note.content.split("\n")[0]!.slice(0, 160),
        text: note.content,
        project: note.project,
        tags: note.tags,
        legacy: !has(note.id, "note"),
        current: has(note.id, "note"),
        sourceNoteIds:
          note.origin?.noteIds ??
          (note.origin?.noteId ? [note.origin.noteId] : []),
      });
  }
  for (const todo of state.todos.filter((t) => t.completedAt !== null))
    if (!has(todo.id, "todo", "completed"))
      result.push({
        id: `todo:${todo.id}`,
        entityId: todo.id,
        entityType: "todo",
        revision: todo.revision,
        action: "completed",
        occurredOn: workbenchDate(todo.completedAt!),
        recordedAt: todo.updatedAt,
        at: todo.completedAt,
        title: todo.title,
        text: todo.title,
        project: todo.project,
        tags: todo.tags ?? [],
        area: todo.area ?? "work",
        legacy: true,
      });
  for (const event of state.events) {
    const start = workbenchDate(event.startAt),
      end = workbenchDate(event.endAt - 1);
    if (start > to || end < from) continue;
    const last = end > to ? to : end;
    const cursor = new Date(`${start < from ? from : start}T12:00:00`);
    // Bound expansion for malformed or accidentally unbounded requests.
    for (
      let count = 0;
      count < 3660 && workbenchDate(cursor.getTime()) <= last;
      count++, cursor.setDate(cursor.getDate() + 1)
    ) {
      const shown = workbenchDate(cursor.getTime());
      result.push({
        id: `plan:${event.id}:${shown}`,
        entityId: event.id,
        entityType: "event",
        revision: event.revision,
        action: "scheduled",
        occurredOn: shown,
        recordedAt: event.updatedAt,
        at: Math.max(event.startAt, new Date(`${shown}T00:00:00`).getTime()),
        title: event.title,
        text: "计划时间段，未确认实际执行",
        project: event.project,
        tags: event.tags ?? [],
        startAt: event.startAt,
        endAt: event.endAt,
        planned: true,
      });
    }
  }
  for (const report of state.reports)
    if (!has(report.id, "report"))
      result.push({
        id: `report:${report.id}`,
        entityId: report.id,
        entityType: "report",
        revision: report.revision,
        action: report.status === "final" ? "finalized" : "saved",
        occurredOn: report.date,
        recordedAt: report.createdAt,
        at: null,
        title: `${report.date} 工作日报`,
        text: report.body,
        project: report.project,
        tags: report.tags ?? [],
        legacy: true,
      });
  return result
    .filter(
      (item) =>
        item.occurredOn >= from &&
        item.occurredOn <= to &&
        (!project || item.project === project) &&
        workbenchHasTag(item.tags, tag) &&
        `${item.title} ${item.text} ${item.tags.join(" ")}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        a.occurredOn.localeCompare(b.occurredOn) ||
        (a.at ?? -1) - (b.at ?? -1) ||
        a.recordedAt - b.recordedAt ||
        a.id.localeCompare(b.id),
    );
}
