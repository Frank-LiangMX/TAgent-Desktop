import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  workbenchDate,
  normalizeWorkbenchTags,
  type WorkbenchActivity,
  type WorkbenchMutationInput,
  type WorkbenchReportSource,
  type WorkbenchState,
} from "@tagent/shared";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00`);
    return (
      Number.isFinite(parsed.getTime()) &&
      workbenchDate(parsed.getTime()) === value
    );
  }, "日期无效");
const optionalDay = z.union([day, z.literal("")]);
const content = z
  .string()
  .max(100_000)
  .refine((value) => value.trim().length > 0, "内容不能为空");
const title = z.string().trim().min(1, "标题不能为空").max(500);
const project = z.string().trim().max(120);
const id = z.string().min(1).max(100);
const tags = z
  .array(z.string().trim().min(1).max(80))
  .max(50)
  .transform(normalizeWorkbenchTags);
const epoch = z.number().int().min(0).max(8_640_000_000_000_000);
const origin = z
  .object({
    sessionId: z.string().min(1).max(250),
    toolCallId: z.string().min(1).max(250),
    noteId: id.optional(),
    noteIds: z.array(id).max(50).optional(),
  })
  .optional();
const entity = {
  id,
  revision: z.number().int().min(1),
  createdAt: epoch,
  updatedAt: epoch,
  origin,
};
const noteShape = {
  content,
  tags,
  project,
  kind: z.enum(["note", "progress"]),
  occurredOn: day,
};
const todoShape = {
  tags: tags.optional(),
  title,
  project,
  dueDate: optionalDay,
  dueTime: z
    .union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.literal("")])
    .optional(),
  noteId: id.optional(),
  area: z.enum(["work", "personal"]).optional(),
};
const eventShape = {
  title,
  project,
  startAt: epoch,
  endAt: epoch,
  tags: tags.optional(),
};
const source = z.object({
  type: z.enum(["note", "todo"]),
  id,
  revision: z.number().int().min(1),
  text: content,
});
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0),
  notes: z.array(
    z.object({
      ...entity,
      ...noteShape,
      status: z.enum(["active", "archived", "trashed"]),
      pinned: z.boolean(),
    }),
  ),
  todos: z.array(
    z.object({ ...entity, ...todoShape, completedAt: epoch.nullable() }),
  ),
  events: z.array(
    z.object({ ...entity, ...eventShape, todoId: id.optional() }),
  ),
  historyStartedAt: epoch.optional(),
  activities: z
    .array(
      z.object({
        id,
        entityId: id,
        entityType: z.enum(["note", "todo", "event", "report", "knowledge"]),
        revision: z.number().int().min(1),
        action: z.enum([
          "recorded",
          "edited",
          "completed",
          "reopened",
          "scheduled",
          "rescheduled",
          "cancelled",
          "saved",
          "finalized",
        ]),
        occurredOn: day,
        recordedAt: epoch,
        at: epoch.nullable(),
        title: z.string(),
        text: z.string(),
        project,
        tags,
        area: z.enum(["work", "personal"]).optional(),
        startAt: epoch.optional(),
        endAt: epoch.optional(),
        sourceNoteIds: z.array(id).optional(),
        knowledgeBaseId: id.optional(),
        recovered: z.boolean().optional(),
      }),
    )
    .optional(),
  reports: z.array(
    z.object({
      ...entity,
      date: day,
      tags: tags.optional(),
      project,
      body: content,
      status: z.enum(["draft", "final"]),
      sources: z.array(source),
    }),
  ),
});
const mutationSchema = z.object({
  expectedRevision: z.number().int().min(0),
  change: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("save-note"),
      id: id.optional(),
      expectedEntityRevision: z.number().int().min(1).optional(),
      ...noteShape,
      origin,
    }),
    z.object({
      type: z.literal("set-note-state"),
      id,
      status: z.enum(["active", "archived", "trashed"]).optional(),
      pinned: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("save-todo"),
      id: id.optional(),
      expectedEntityRevision: z.number().int().min(1).optional(),
      ...todoShape,
      origin,
    }),
    z.object({ type: z.literal("toggle-todo"), id }),
    z.object({
      type: z.literal("save-event"),
      id: id.optional(),
      ...eventShape,
      expectedEntityRevision: z.number().int().min(1).optional(),
      todoId: id.nullable().optional(),
      origin,
    }),
    z.object({ type: z.literal("delete-event"), id }),
    z.object({ type: z.literal("create-report"), date: day, project }),
    z.object({
      type: z.literal("record-knowledge"),
      documentId: id,
      knowledgeBaseId: id,
      noteId: id,
      title,
      tags,
    }),
    z.object({
      type: z.literal("save-report"),
      id,
      expectedEntityRevision: z.number().int().min(1),
      body: content,
      tags: tags.optional(),
      finalize: z.boolean().optional(),
    }),
  ]),
});

function atomicWrite(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Synchronous mutations are serialized by Electron's main event loop. No cache or async read/write gap. */
export class WorkbenchStore {
  constructor(
    private readonly path: string,
    private readonly clock: () => number = Date.now,
  ) {}

  read(): WorkbenchState {
    if (!existsSync(this.path))
      return {
        schemaVersion: 1,
        revision: 0,
        notes: [],
        todos: [],
        events: [],
        reports: [],
      };
    try {
      return stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      // Never silently replace damaged/unknown data with an empty store.
      throw new Error("工作台数据无法读取，原文件已保留。请从备份恢复后重试。");
    }
  }

  mutate(input: WorkbenchMutationInput): WorkbenchState {
    const { expectedRevision, change } = mutationSchema.parse(input);
    const state = this.read();
    if (state.revision !== expectedRevision)
      throw new Error("工作台内容已在其他窗口更新，请重试；你的输入已保留。");
    const now = this.clock();
    const fresh = () => ({
      id: randomUUID(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const touch = (item: { revision: number; updatedAt: number }) => {
      item.revision++;
      item.updatedAt = now;
    };
    const checkRevision = (
      item: { revision: number },
      expected: number | undefined,
    ) => {
      if (item.revision !== expected)
        throw new Error(
          "此条目已有新版本，输入已保留。请复制修改内容，重新打开最新版本后合并。",
        );
    };
    const find = <T extends { id: string }>(items: T[], target: string): T => {
      const item = items.find((item) => item.id === target);
      if (!item) throw new Error("条目不存在，请刷新后重试");
      return item;
    };
    const activities = (state.activities ??= []);
    // Seed only facts still recoverable from old state. Never invent past changes.
    if (state.historyStartedAt === undefined) {
      state.historyStartedAt = now;
      for (const todo of state.todos.filter(
        (item) => item.completedAt !== null,
      )) {
        activities.push({
          id: randomUUID(),
          entityId: todo.id,
          entityType: "todo",
          revision: todo.revision,
          action: "completed",
          occurredOn: workbenchDate(todo.completedAt!),
          recordedAt: now,
          at: todo.completedAt,
          title: todo.title,
          text: todo.title,
          project: todo.project,
          tags: todo.tags ?? [],
          area: todo.area ?? "work",
          recovered: true,
        });
      }
      for (const note of state.notes.filter(
        (item) => item.status !== "trashed",
      ))
        activities.push({
          id: randomUUID(),
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
          recovered: true,
          sourceNoteIds:
            note.origin?.noteIds ??
            (note.origin?.noteId ? [note.origin.noteId] : []),
        });
      for (const report of state.reports)
        activities.push({
          id: randomUUID(),
          entityId: report.id,
          entityType: "report",
          revision: report.revision,
          action: report.status === "final" ? "finalized" : "saved",
          occurredOn: report.date,
          recordedAt: report.updatedAt,
          at: null,
          title: `${report.date} 工作日报`,
          text: report.body,
          project: report.project,
          tags: report.tags ?? [],
          recovered: true,
        });
    }
    const log = (value: Omit<WorkbenchActivity, "id" | "recordedAt">) =>
      activities.push({ ...value, id: randomUUID(), recordedAt: now });
    const snapshot = (item: {
      id: string;
      revision: number;
      project: string;
      tags?: string[];
      origin?: { noteId?: string; noteIds?: string[] };
    }) => ({
      entityId: item.id,
      revision: item.revision,
      project: item.project,
      tags: item.tags ?? [],
      sourceNoteIds:
        item.origin?.noteIds ??
        (item.origin?.noteId ? [item.origin.noteId] : []),
    });
    const requireTags = (item: { tags?: string[]; origin?: unknown }) => {
      if (item.origin && !item.tags?.length)
        throw new Error("整理成果必须有主题标签，请补充 tags 后再保存");
    };
    if ("origin" in change && change.origin)
      for (const sourceId of new Set([
        ...(change.origin.noteIds ?? []),
        ...(change.origin.noteId ? [change.origin.noteId] : []),
      ])) {
        if (find(state.notes, sourceId).status === "trashed")
          throw new Error("来源记录已在回收站");
      }
    switch (change.type) {
      case "save-note": {
        const {
          type: _,
          id: target,
          expectedEntityRevision,
          ...values
        } = change;
        const previous = target ? find(state.notes, target) : undefined;
        requireTags({
          tags: values.tags,
          origin: values.origin ?? previous?.origin,
        });
        for (const sourceId of values.origin?.noteIds ??
          (values.origin?.noteId ? [values.origin.noteId] : [])) {
          if (find(state.notes, sourceId).status === "trashed")
            throw new Error("来源记录已在回收站");
        }
        if (target) {
          const note = find(state.notes, target);
          checkRevision(note, expectedEntityRevision);
          if (note.status === "trashed")
            throw new Error("请先从回收站恢复笔记");
          Object.assign(note, values);
          touch(note);
        } else
          state.notes.push({
            ...fresh(),
            ...values,
            status: "active",
            pinned: false,
          });
        const saved = target ? find(state.notes, target) : state.notes.at(-1)!;
        log({
          ...snapshot(saved),
          entityType: "note",
          action: target ? "edited" : "recorded",
          occurredOn: target ? workbenchDate(now) : saved.occurredOn,
          at: target ? now : null,
          title: saved.content.split("\n")[0]!.slice(0, 160),
          text: saved.content,
        });
        break;
      }
      case "set-note-state": {
        const note = find(state.notes, change.id);
        if (change.status !== undefined) note.status = change.status;
        if (change.pinned !== undefined) note.pinned = change.pinned;
        touch(note);
        break;
      }
      case "save-todo": {
        const {
          type: _,
          id: target,
          expectedEntityRevision,
          ...values
        } = change;
        if (values.dueTime && !values.dueDate)
          throw new Error("设置计划时间前，请先选择计划日期");
        if (values.noteId) {
          const note = find(state.notes, values.noteId);
          if (note.status === "trashed")
            throw new Error("回收站笔记不能转为待办");
          // A conversion retry returns the existing task; the original note stays intact.
          if (
            !target &&
            state.todos.some((item) => item.noteId === values.noteId)
          )
            return state;
        }
        const previous = target ? find(state.todos, target) : undefined;
        if (values.tags === undefined)
          values.tags =
            previous?.tags ??
            (values.noteId ? find(state.notes, values.noteId).tags : []);
        requireTags({
          tags: values.tags,
          origin: values.origin ?? previous?.origin,
        });
        if (target) {
          const todo = find(state.todos, target);
          checkRevision(todo, expectedEntityRevision);
          Object.assign(todo, values);
          todo.dueTime = values.dueTime ?? "";
          touch(todo);
          for (const event of state.events.filter(
            (item) => item.todoId === todo.id && item.project !== todo.project,
          )) {
            log({
              ...snapshot(event),
              entityType: "event",
              action: "rescheduled",
              occurredOn: workbenchDate(event.startAt),
              at: event.startAt,
              title: event.title,
              text: "关联待办的项目已调整，保留原计划",
              startAt: event.startAt,
              endAt: event.endAt,
            });
            event.project = todo.project;
            touch(event);
          }
        } else state.todos.push({ ...fresh(), ...values, completedAt: null });
        break;
      }
      case "toggle-todo": {
        const todo = find(state.todos, change.id);
        todo.completedAt = todo.completedAt === null ? now : null;
        touch(todo);
        log({
          ...snapshot(todo),
          entityType: "todo",
          action: todo.completedAt === null ? "reopened" : "completed",
          occurredOn: workbenchDate(now),
          at: now,
          title: todo.title,
          text: todo.title,
          area: todo.area ?? "work",
        });
        break;
      }
      case "save-event": {
        if (change.endAt <= change.startAt)
          throw new Error("结束时间必须晚于开始时间");
        const {
          type: _,
          id: target,
          expectedEntityRevision,
          todoId,
          ...rest
        } = change;
        const values = { ...rest, todoId: todoId || undefined };
        if (values.todoId) {
          const todo = find(state.todos, values.todoId);
          if (todo.project !== values.project)
            throw new Error("关联待办与日程须属于同一项目");
        }
        const previous = target ? find(state.events, target) : undefined;
        if (values.tags === undefined)
          values.tags =
            previous?.tags ??
            (values.todoId ? find(state.todos, values.todoId).tags : []) ??
            [];
        requireTags({
          tags: values.tags,
          origin: values.origin ?? previous?.origin,
        });
        if (
          previous &&
          (previous.startAt !== values.startAt ||
            previous.endAt !== values.endAt ||
            previous.title !== values.title ||
            previous.project !== values.project ||
            previous.todoId !== values.todoId ||
            JSON.stringify(previous.tags ?? []) !== JSON.stringify(values.tags))
        ) {
          log({
            ...snapshot(previous),
            entityType: "event",
            action: "rescheduled",
            occurredOn: workbenchDate(previous.startAt),
            at: previous.startAt,
            title: previous.title,
            text: "原安排已调整，仍是计划记录",
            startAt: previous.startAt,
            endAt: previous.endAt,
          });
        }
        if (target) {
          const event = find(state.events, target);
          checkRevision(event, expectedEntityRevision);
          Object.assign(event, values);
          touch(event);
        } else state.events.push({ ...fresh(), ...values });
        break;
      }
      case "delete-event": {
        const event = find(state.events, change.id);
        log({
          ...snapshot(event),
          entityType: "event",
          action: "cancelled",
          occurredOn: workbenchDate(event.startAt),
          at: event.startAt,
          title: event.title,
          text: "安排已取消，不代表实际执行",
          startAt: event.startAt,
          endAt: event.endAt,
        });
        state.events = state.events.filter((item) => item.id !== change.id);
        break;
      }
      case "record-knowledge": {
        const note = find(state.notes, change.noteId);
        if (note.status === "trashed") throw new Error("来源笔记已在回收站");
        if (!change.tags.length) throw new Error("知识成果必须有主题标签");
        if (
          activities.some(
            (item) =>
              item.entityType === "knowledge" &&
              item.entityId === change.documentId,
          )
        )
          return state;
        log({
          entityId: change.documentId,
          entityType: "knowledge",
          revision: 1,
          action: "saved",
          occurredOn: workbenchDate(now),
          at: now,
          title: change.title,
          text: note.content,
          project: note.project,
          tags: change.tags,
          sourceNoteIds: [note.id],
          knowledgeBaseId: change.knowledgeBaseId,
        });
        break;
      }
      case "create-report": {
        const matchesProject = (value: string) =>
          !change.project || value === change.project;
        const sources: WorkbenchReportSource[] = [
          ...state.notes
            .filter(
              (note) =>
                note.kind === "progress" &&
                note.status !== "trashed" &&
                note.occurredOn === change.date &&
                matchesProject(note.project),
            )
            .map((note) => ({
              type: "note" as const,
              id: note.id,
              revision: note.revision,
              text: note.content,
            })),
          ...Array.from(
            new Map(
              activities
                .filter(
                  (item) =>
                    item.entityType === "todo" &&
                    item.action === "completed" &&
                    item.area !== "personal" &&
                    item.occurredOn === change.date &&
                    matchesProject(item.project),
                )
                .map((item) => [item.entityId, item]),
            ).values(),
          ).map((todo) => ({
            type: "todo" as const,
            id: todo.entityId,
            revision: todo.revision,
            text: todo.title,
          })),
        ];
        if (!sources.length)
          throw new Error("这一天还没有工作进展或已完成待办，先补记再汇总。");
        const progress = sources
          .filter((item) => item.type === "note")
          .map((item) => `- ${item.text}`)
          .join("\n");
        const done = sources
          .filter((item) => item.type === "todo")
          .map((item) => `- ${item.text}`)
          .join("\n");
        const body = `# ${change.date} 工作日报${change.project ? ` · ${change.project}` : ""}\n\n${progress ? `## 工作进展\n\n${progress}\n\n` : ""}${done ? `## 已完成待办\n\n${done}\n\n` : ""}## 后续计划\n\n待补充。\n`;
        state.reports.push({
          ...fresh(),
          date: change.date,
          project: change.project,
          body,
          tags: normalizeWorkbenchTags([
            ...sources.flatMap((source) =>
              source.type === "note"
                ? find(state.notes, source.id).tags
                : (activities.find(
                    (item) =>
                      item.entityType === "todo" &&
                      item.entityId === source.id &&
                      item.action === "completed" &&
                      item.revision === source.revision,
                  )?.tags ?? []),
            ),
            change.project || "工作回顾",
          ]),
          status: "draft",
          sources,
        });
        const report = state.reports.at(-1)!;
        log({
          ...snapshot(report),
          entityType: "report",
          action: "saved",
          occurredOn: report.date,
          at: null,
          title: `${report.date} 工作日报`,
          text: report.body,
        });
        break;
      }
      case "save-report": {
        const report = find(state.reports, change.id);
        checkRevision(report, change.expectedEntityRevision);
        if (report.status === "final")
          throw new Error("定稿已保留；请重新汇总为新草稿后编辑");
        if (change.tags !== undefined) {
          if (!change.tags.length) throw new Error("回顾成果必须有主题标签");
          report.tags = change.tags;
        }
        report.tags ??= [report.project || "工作回顾"];
        report.body = change.body;
        if (change.finalize) report.status = "final";
        touch(report);
        log({
          ...snapshot(report),
          entityType: "report",
          action: change.finalize ? "finalized" : "saved",
          occurredOn: report.date,
          at: null,
          title: `${report.date} 工作日报`,
          text: report.body,
        });
        break;
      }
    }
    state.revision++;
    stateSchema.parse(state);
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path))
      atomicWrite(`${this.path}.bak`, readFileSync(this.path, "utf8"));
    atomicWrite(this.path, JSON.stringify(state, null, 2));
    return state;
  }
}
