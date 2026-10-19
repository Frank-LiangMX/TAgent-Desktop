import { useMemo, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  CheckCircle,
  NotePencil,
  CalendarBlank,
  Books,
  FileText,
} from "@phosphor-icons/react";
import { Button } from "@tagent/ui";
import {
  workbenchDate,
  workbenchFootprints,
  workbenchActivityLabel,
  type WorkbenchState,
} from "@tagent/shared";

export function WorkbenchHistory({
  state,
  date,
  onDate,
  project,
  tag,
  query,
  onTag,
  onOpenNote,
  onOpenReport,
  onOpenKnowledge,
}: {
  state: WorkbenchState;
  date: string;
  onDate: (date: string) => void;
  project: string;
  tag: string;
  query: string;
  onTag: (tag: string) => void;
  onOpenNote: (id: string) => void;
  onOpenReport: (id: string) => void;
  onOpenKnowledge: (knowledgeBaseId: string, documentId: string) => void;
}) {
  const [kind, setKind] = useState<"all" | "facts" | "plans">("all");
  const [limit, setLimit] = useState(30);
  const month = date.slice(0, 7);
  const days = useMemo(() => {
    const first = new Date(`${month}-01T12:00:00`);
    first.setDate(1 - ((first.getDay() + 6) % 7));
    const last = new Date(first);
    last.setDate(first.getDate() + 41);
    const monthItems = workbenchFootprints(
      state,
      workbenchDate(first.getTime()),
      workbenchDate(last.getTime()),
      project,
      tag,
      query,
    );
    const grouped = new Map<string, typeof monthItems>();
    for (const item of monthItems) {
      const list = grouped.get(item.occurredOn) ?? [];
      list.push(item);
      grouped.set(item.occurredOn, list);
    }
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(first);
      day.setDate(first.getDate() + index);
      const value = workbenchDate(day.getTime());
      const items = grouped.get(value) ?? [];
      return {
        value,
        number: day.getDate(),
        count: items.filter((item) => item.entityType !== "event").length,
        plans: items.filter((item) => item.entityType === "event").length,
      };
    });
  }, [state, month, project, tag, query]);
  const all = useMemo(
    () => workbenchFootprints(state, date, date, project, tag, query),
    [state, date, project, tag, query],
  );
  const items = all.filter(
    (item) =>
      kind === "all" ||
      (kind === "plans"
        ? item.entityType === "event"
        : item.entityType !== "event"),
  );
  const completions = new Set(
    all
      .filter((item) => item.action === "completed")
      .map((item) => item.entityId),
  ).size;
  const notes = new Set(
    all
      .filter((item) => item.entityType === "note")
      .map((item) => item.entityId),
  ).size;
  const saved = new Set(
    all
      .filter((item) => ["report", "knowledge"].includes(item.entityType))
      .map((item) => item.entityId),
  ).size;
  const plans = all.filter((item) => item.entityType === "event").length;
  const changeMonth = (offset: number) => {
    const next = new Date(`${month}-01T12:00:00`);
    next.setMonth(next.getMonth() + offset);
    onDate(workbenchDate(next.getTime()));
    setLimit(30);
  };
  return (
    <section className="wb-history" aria-label="每日足迹">
      <div className="wb-section-title">
        <div>
          <h3>每日足迹</h3>
          <p className="wb-hint">
            这里记录新增、修改、保存和定稿等操作，同一文档可能出现多次。打开正文可查看最新版本。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onDate(workbenchDate())}
        >
          <CalendarBlank />
          回到今天
        </Button>
      </div>
      <div className="wb-history-layout">
        <div className="wb-history-month">
          <div className="wb-history-month-title">
            <Button
              variant="outline"
              size="icon-sm"
              type="button"
              aria-label="足迹上个月"
              onClick={() => changeMonth(-1)}
            >
              <CaretLeft size={16} />
            </Button>
            <strong>{month.replace("-", " 年 ")} 月</strong>
            <Button
              variant="outline"
              size="icon-sm"
              type="button"
              aria-label="足迹下个月"
              onClick={() => changeMonth(1)}
            >
              <CaretRight size={16} />
            </Button>
          </div>
          <div className="wb-history-days">
            {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
              <span key={day} className="wb-history-weekday">
                {day}
              </span>
            ))}
            {days.map((day) => (
              <button
                type="button"
                key={day.value}
                aria-label={`${day.value}，${day.count} 条足迹，${day.plans} 条计划`}
                aria-pressed={date === day.value}
                className={
                  day.value.startsWith(month) ? "" : "wb-history-other"
                }
                data-level={Math.min(day.count, 3)}
                onClick={() => {
                  onDate(day.value);
                  setLimit(30);
                }}
              >
                <span>{day.number}</span>
                <i className={day.plans ? "has-plans" : ""}>
                  {day.count || ""}
                </i>
              </button>
            ))}
          </div>
          <p className="wb-hint wb-history-legend">
            底色深浅表示足迹数量 · 圆点表示计划
          </p>
          <p className="wb-hint wb-history-boundary">
            {state.historyStartedAt
              ? `详细历史从 ${workbenchDate(state.historyStartedAt)} 开始保存。更早日期仅展示仍可核实的记录。`
              : "旧记录仅展示仍可核实的信息；下次保存起会持续保留详细历史。"}
          </p>
        </div>
        <div className="wb-history-detail">
          <div className="wb-history-date">
            <strong>{date}</strong>
            <span>
              {new Date(`${date}T12:00:00`).toLocaleDateString("zh-CN", {
                weekday: "long",
              })}
            </span>
          </div>
          <div className="wb-history-stats">
            <span>
              <CheckCircle size={17} />
              <b>{completions}</b> 完成
            </span>
            <span>
              <NotePencil size={17} />
              <b>{notes}</b> 笔记
            </span>
            <span>
              <Books size={17} />
              <b>{saved}</b> 成果
            </span>
            <span>
              <CalendarBlank size={17} />
              <b>{plans}</b> 计划记录
            </span>
          </div>
          <div className="wb-history-tabs" role="group" aria-label="足迹类型">
            {(
              [
                { id: "all", label: "全部" },
                { id: "facts", label: "实际记录" },
                { id: "plans", label: "计划安排" },
              ] as const
            ).map((option) => (
              <button
                type="button"
                key={option.id}
                aria-pressed={kind === option.id}
                onClick={() => {
                  setKind(option.id);
                  setLimit(30);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {!items.length ? (
            <p className="wb-empty">
              这一天没有符合筛选的记录。可以选择其他日期，或补记一条笔记。
            </p>
          ) : (
            <ol className="wb-history-timeline">
              {items.slice(0, limit).map((item) => (
                <li
                  key={item.id}
                  className={item.entityType === "event" ? "is-plan" : ""}
                >
                  <div className="wb-meta">
                    <time>
                      {item.at === null
                        ? "未标具体时间"
                        : new Date(item.at).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                    </time>
                    <span>
                      {item.current
                        ? "当前笔记（后续已修改）"
                        : workbenchActivityLabel[item.action]}
                    </span>
                    {item.entityType === "event" && <span>计划</span>}
                    {item.legacy && <span>原有记录</span>}
                    {item.project && <span>{item.project}</span>}
                  </div>
                  <strong>{item.title}</strong>
                  {item.entityType === "note" &&
                    workbenchDate(item.recordedAt) !== item.occurredOn && (
                      <p className="wb-hint">
                        {item.current ? "更新于" : "记录于"}{" "}
                        {workbenchDate(item.recordedAt)} · 按所填发生日期归档
                      </p>
                    )}
                  {item.startAt && item.endAt && (
                    <p className="wb-hint">
                      {new Date(item.startAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      —{" "}
                      {new Date(item.endAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      · 未确认实际执行
                    </p>
                  )}
                  {item.text !== item.title && (
                    <details>
                      <summary>
                        {item.current ? "查看当前内容" : "查看当时内容"}
                      </summary>
                      <p className="wb-history-text">{item.text}</p>
                    </details>
                  )}
                  <div className="wb-history-tags">
                    {item.tags.map((value) => (
                      <button
                        type="button"
                        key={value}
                        title={`筛选标签：${value}`}
                        onClick={() => onTag(value)}
                      >
                        #{value}
                      </button>
                    ))}
                  </div>
                  {(["note", "report", "knowledge"].includes(item.entityType) ||
                    !!item.sourceNoteIds?.length) && (
                    <div className="wb-history-actions">
                      {item.entityType === "report" &&
                        state.reports.some(
                          (report) => report.id === item.entityId,
                        ) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onOpenReport(item.entityId)}
                          >
                            <FileText />
                            打开日报
                            <CaretRight />
                          </Button>
                        )}
                      {item.entityType === "knowledge" &&
                        item.knowledgeBaseId && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              onOpenKnowledge(
                                item.knowledgeBaseId!,
                                item.entityId,
                              )
                            }
                          >
                            <Books />
                            打开知识文档
                            <CaretRight />
                          </Button>
                        )}
                      {item.entityType === "note" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onOpenNote(item.entityId)}
                        >
                          <FileText />
                          打开正文
                          <CaretRight />
                        </Button>
                      )}
                      {item.sourceNoteIds?.map((id, index) => (
                        <Button
                          type="button"
                          key={id}
                          variant="outline"
                          size="sm"
                          onClick={() => onOpenNote(id)}
                        >
                          <FileText />
                          来源 {index + 1}
                          <CaretRight />
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {items.length > limit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit(limit + 30)}
            >
              再看 30 条
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
