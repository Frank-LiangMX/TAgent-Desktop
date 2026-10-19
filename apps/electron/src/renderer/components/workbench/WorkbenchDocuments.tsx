import { useState } from "react";
import { ArrowRight, FileText, GearSix } from "@phosphor-icons/react";
import { Button, DatePicker } from "@tagent/ui";
import { DocumentTimestamps } from "./DocumentTimestamps";
import {
  workbenchHasTag,
  type WorkbenchNote,
  type WorkbenchState,
} from "@tagent/shared";

export function workbenchDocumentKind(
  note: WorkbenchNote,
): "日报" | "周报" | null {
  const title = note.content.split("\n").find((line) => line.trim()) ?? "";
  const heading = title.replace(/^#+\s*/, "");
  if (/^(?:\d{4}[-年].{0,20}\s*)?(?:工作)?日报/.test(heading)) return "日报";
  if (/^(?:\d{4}[-年].{0,20}\s*)?(?:工作)?周报/.test(heading)) return "周报";
  if (note.tags.some((tag) => /(^|\/)周报($|\/)/.test(tag))) return "周报";
  if (note.tags.some((tag) => /(^|\/)日报($|\/)/.test(tag))) return "日报";
  return null;
}
export type WorkbenchDocumentTarget = { type: "note" | "report"; id: string };
export function WorkbenchDocuments({
  state,
  project,
  tag,
  query,
  date,
  onDate,
  onOpen,
  onCreate,
  onWeek,
  onConfigureWps,
  busy,
}: {
  state: WorkbenchState;
  project: string;
  tag: string;
  query: string;
  date: string;
  onDate: (date: string) => void;
  onOpen: (target: WorkbenchDocumentTarget) => void;
  onCreate: () => void;
  onWeek: () => void;
  onConfigureWps: () => void;
  busy: boolean;
}) {
  const [kind, setKind] = useState("全部");
  const groups = new Map<string, typeof state.reports>();
  for (const report of state.reports) {
    const key = JSON.stringify([report.date, report.project]);
    groups.set(key, [...(groups.get(key) ?? []), report]);
  }
  const documents = [
    ...Array.from(groups.values()).map((versions) => {
      const report = [...versions].sort(
        (a, b) => b.createdAt - a.createdAt,
      )[0]!;
      return {
        id: report.id,
        type: "report" as const,
        kind: "日报",
        title: `${report.date} 工作日报`,
        date: report.date,
        project: report.project,
        tags: report.tags ?? [],
        content: report.body,
        status: report.status === "final" ? "已定稿" : "草稿",
        versions: versions.length,
        createdAt: report.createdAt,
        modifiedAt: report.updatedAt,
        updatedAt: Math.max(...versions.map((v) => v.updatedAt)),
      };
    }),
    ...state.notes
      .filter(
        (note) => note.status !== "trashed" && workbenchDocumentKind(note),
      )
      .map((note) => ({
        id: note.id,
        type: "note" as const,
        kind: workbenchDocumentKind(note)!,
        title:
          note.content
            .split("\n")
            .find((line) => line.trim())
            ?.replace(/^#+\s*/, "") ?? "未命名报告",
        date: note.occurredOn,
        project: note.project,
        tags: note.tags,
        content: note.content,
        status: note.status === "archived" ? "已归档" : "笔记文档",
        versions: 1,
        createdAt: note.createdAt,
        modifiedAt: note.updatedAt,
        updatedAt: note.updatedAt,
      })),
  ]
    .filter(
      (doc) =>
        (!project || doc.project === project) &&
        workbenchHasTag(doc.tags, tag) &&
        (!query ||
          `${doc.title} ${doc.content}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())) &&
        (kind === "全部" || doc.kind === kind),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <section className="wb-documents" aria-label="日报与周报文档">
      <div className="wb-section-title">
        <div>
          <h3>日报与周报</h3>
          <p className="wb-hint">
            在这里打开完整正文。每份日报的草稿与定稿集中查看，操作历史在“每日足迹”。
          </p>
        </div>
        <Button variant="outline" onClick={onConfigureWps}>
          <GearSix size={16} />
          WPS 连接与自动化
        </Button>
      </div>
      <div className="wb-documents-toolbar">
        <div className="wb-history-tabs" role="group" aria-label="报告类型">
          {["全部", "日报", "周报"].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="wb-documents-create">
          <DatePicker label="汇总日期" value={date} onValueChange={onDate} />
          <Button variant="outline" disabled={busy} onClick={onCreate}>
            汇总新草稿
          </Button>
          <Button variant="outline" onClick={onWeek}>
            让 Agent 整理周报
          </Button>
        </div>
      </div>
      <p className="wb-hint">全部日期 · {documents.length} 份文档</p>
      {!documents.length ? (
        <p className="wb-empty">
          还没有符合条件的报告。可汇总工作进展生成日报；带“日报”或“周报”标签的笔记也会出现在这里。
        </p>
      ) : (
        <div className="wb-document-list">
          {documents.map((doc) => (
            <button
              key={`${doc.type}:${doc.id}`}
              type="button"
              className="wb-document-row"
              onClick={() => onOpen({ type: doc.type, id: doc.id })}
            >
              <FileText size={24} className="wb-document-icon" />
              <span className="wb-document-info">
                <strong>{doc.title}</strong>
                <span>
                  {doc.kind} · {doc.date} · {doc.status}
                  {doc.project && ` · ${doc.project}`}
                  {doc.versions > 1 && ` · ${doc.versions} 个版本`}
                </span>
                <DocumentTimestamps
                  createdAt={doc.createdAt}
                  updatedAt={doc.modifiedAt}
                />
                <span className="wb-document-excerpt">
                  {doc.content.replace(/[#*`]/g, "").slice(0, 130)}
                </span>
              </span>
              <span className="wb-document-open">
                打开正文 <ArrowRight size={16} />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
