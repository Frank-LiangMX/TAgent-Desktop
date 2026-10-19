/** Local personal workbench. References retain the source revision and text. */
export interface WorkbenchEntity {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  origin?: {
    sessionId: string;
    toolCallId: string;
    noteId?: string;
    noteIds?: string[];
  };
}
export interface WorkbenchNote extends WorkbenchEntity {
  content: string;
  tags: string[];
  project: string;
  kind: "note" | "progress";
  occurredOn: string;
  status: "active" | "archived" | "trashed";
  pinned: boolean;
}
export interface WorkbenchTodo extends WorkbenchEntity {
  tags?: string[];
  title: string;
  project: string;
  noteId?: string;
  dueDate: string;
  /** Optional local planned time. A dated todo appears directly on the calendar. */
  dueTime?: string;
  /** Planned interval, independent of the optional deadline. Null clears the plan. */
  startAt?: number | null;
  endAt?: number | null;
  progress?: number;
  completedAt: number | null;
  /** Legacy todos without an area retain the original work-report behavior. */
  area?: "work" | "personal";
}
export interface WorkbenchEvent extends WorkbenchEntity {
  tags?: string[];
  title: string;
  project: string;
  startAt: number;
  endAt: number;
  todoId?: string;
}
export interface WorkbenchReportSource {
  type: "note" | "todo";
  id: string;
  revision: number;
  text: string;
}
export interface WorkbenchReport extends WorkbenchEntity {
  tags?: string[];
  date: string;
  project: string;
  body: string;
  status: "draft" | "final";
  sources: WorkbenchReportSource[];
}
export interface WorkbenchState {
  schemaVersion: 1;
  revision: number;
  notes: WorkbenchNote[];
  todos: WorkbenchTodo[];
  events: WorkbenchEvent[];
  reports: WorkbenchReport[];
  activities?: WorkbenchActivity[];
  historyStartedAt?: number;
}
/** Durable facts; snapshots never change when the source is edited or reopened. */
export interface WorkbenchActivity {
  recovered?: boolean;
  id: string;
  entityId: string;
  entityType: "note" | "todo" | "event" | "report" | "knowledge";
  revision: number;
  action:
    | "recorded"
    | "edited"
    | "completed"
    | "reopened"
    | "scheduled"
    | "rescheduled"
    | "cancelled"
    | "saved"
    | "finalized";
  occurredOn: string;
  recordedAt: number;
  at: number | null;
  title: string;
  text: string;
  project: string;
  tags: string[];
  area?: "work" | "personal";
  startAt?: number;
  endAt?: number;
  sourceNoteIds?: string[];
  knowledgeBaseId?: string;
}
export type WorkbenchMutation =
  | {
      type: "save-note";
      id?: string;
      expectedEntityRevision?: number;
      content: string;
      tags: string[];
      project: string;
      kind: WorkbenchNote["kind"];
      occurredOn: string;
      origin?: WorkbenchEntity["origin"];
    }
  | {
      type: "set-note-state";
      id: string;
      status?: WorkbenchNote["status"];
      pinned?: boolean;
    }
  | {
      type: "save-todo";
      id?: string;
      expectedEntityRevision?: number;
      title: string;
      project: string;
      dueDate: string;
      tags?: string[];
      dueTime?: string;
      startAt?: number | null;
      endAt?: number | null;
      progress?: number;
      area?: "work" | "personal";
      noteId?: string;
      origin?: WorkbenchEntity["origin"];
    }
  | { type: "toggle-todo"; id: string }
  | {
      type: "save-event";
      id?: string;
      expectedEntityRevision?: number;
      title: string;
      project: string;
      startAt: number;
      tags?: string[];
      endAt: number;
      todoId?: string | null;
      origin?: WorkbenchEntity["origin"];
    }
  | { type: "delete-event"; id: string }
  | { type: "create-report"; date: string; project: string }
  | {
      type: "record-knowledge";
      documentId: string;
      knowledgeBaseId: string;
      noteId: string;
      title: string;
      tags: string[];
    }
  | {
      type: "save-report";
      id: string;
      expectedEntityRevision: number;
      body: string;
      tags?: string[];
      finalize?: boolean;
    };
export interface WorkbenchMutationInput {
  expectedRevision: number;
  change: WorkbenchMutation;
}
export const WORKBENCH_IPC = {
  READ: "workbench:read",
  MUTATE: "workbench:mutate",
  EXPORT: "workbench:export",
  CHANGED: "workbench:changed",
} as const;
export interface WorkbenchApi {
  readWorkbench: () => Promise<WorkbenchState>;
  mutateWorkbench: (input: WorkbenchMutationInput) => Promise<WorkbenchState>;
  exportWorkbench: () => Promise<{ canceled: boolean; path?: string }>;
  onWorkbenchChanged: (listener: () => void) => () => void;
}

/** Local calendar date, deliberately not UTC's toISOString date. */
export function workbenchDate(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Shared tag rules for input, persistence and hierarchy filtering. */
export function normalizeWorkbenchTags(values: readonly string[]): string[] {
  return [
    ...new Map(
      values
        .map((value) =>
          value
            .trim()
            .replace(/^#+/, "")
            .replace(/\s*\/\s*/g, "/"),
        )
        .filter(Boolean)
        .map((value) => [value.toLocaleLowerCase(), value]),
    ).values(),
  ];
}
export function parseWorkbenchTags(value: string): string[] {
  return normalizeWorkbenchTags(value.split(/[\s,，]+/));
}
export function workbenchHasTag(
  values: readonly string[] | undefined,
  tag: string,
): boolean {
  const target = tag.replace(/^#/, "").toLocaleLowerCase();
  return (
    !target ||
    (values ?? []).some(
      (value) =>
        value.toLocaleLowerCase() === target ||
        value.toLocaleLowerCase().startsWith(`${target}/`),
    )
  );
}
