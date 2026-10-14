import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  CheckSquare,
  LinkSimple,
  Lightbulb,
  NotePencil,
  Plus,
  TrendUp,
} from "@phosphor-icons/react";
import { workbenchDate } from "@tagent/shared";
import {
  dateOffset,
  type CollectionKind,
  type OverviewData,
} from "./workbench-overview";

const kinds = [
  { id: "ideas", label: "随笔灵感", icon: Lightbulb },
  { id: "links", label: "链接资料", icon: LinkSimple },
  { id: "progress", label: "工作进展", icon: TrendUp },
] as const;

export function TaskOverview({
  data,
  onOpen,
  onAdd,
}: {
  data: OverviewData;
  onOpen: (filter: "all" | "open" | "done") => void;
  onAdd: () => void;
}) {
  const total = data.open + data.completed;
  const percent = total ? Math.round((data.completed / total) * 100) : 0;
  return (
    <section className="wb-panel wb-task-overview" aria-label="待办状态概览">
      <div className="wb-panel-heading">
        <h3>
          <CheckSquare size={18} />
          待办状态
        </h3>
        <button className="wb-icon" aria-label="新增待办" onClick={onAdd}>
          <Plus size={17} />
        </button>
      </div>
      <div className="wb-task-chart">
        <div className="wb-ring">
          <svg
            viewBox="0 0 120 120"
            role="img"
            aria-label={
              total
                ? `当前项目全部待办：已完成 ${data.completed}，未完成 ${data.open}，完成比例 ${percent}%`
                : "暂无待办"
            }
          >
            <circle className="wb-ring-track" cx="60" cy="60" r="48" />
            <circle
              className="wb-ring-value"
              cx="60"
              cy="60"
              r="48"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
              transform="rotate(-90 60 60)"
              opacity={percent ? 1 : 0}
            />
          </svg>
          <div aria-hidden="true">
            <strong>{total ? `${percent}%` : "—"}</strong>
            <span>{total ? "已完成" : "待安排"}</span>
          </div>
        </div>
        <div className="wb-task-counts">
          <button onClick={() => onOpen("open")}>
            <span>
              <i />
              未完成
            </span>
            <strong>{data.open}</strong>
          </button>
          <button onClick={() => onOpen("done")}>
            <span>
              <i />
              已完成
            </span>
            <strong>{data.completed}</strong>
          </button>
        </div>
      </div>
      <p className="wb-hint">
        {data.overdue
          ? `${data.overdue} 项已逾期，先看看能否重新安排。`
          : total
            ? "统计当前项目全部待办，点击状态查看详情。"
            : "把想做的事写下来，给下一步留个位置。"}
      </p>
      <button
        className="wb-panel-footer"
        onClick={() => (total ? onOpen("all") : onAdd())}
      >
        {total ? "管理全部待办" : "创建第一个待办"}
        <ArrowRight size={15} />
      </button>
    </section>
  );
}

export function WeekPlanner({
  data,
  date,
  onDate,
  onAdd,
}: {
  data: OverviewData;
  date: string;
  onDate: (date: string) => void;
  onAdd: () => void;
}) {
  const first = data.week[0]!.date,
    last = data.week[6]!.date;
  return (
    <section className="wb-panel wb-week" aria-label="周日程">
      <div className="wb-panel-heading">
        <h3>
          <CalendarBlank size={18} />
          这一周{" "}
          <span>
            {first.slice(5).replace("-", "/")} —{" "}
            {last.slice(5).replace("-", "/")}
          </span>
        </h3>
        <div className="wb-section-actions">
          <button
            className="wb-icon"
            aria-label="上一周"
            onClick={() => onDate(dateOffset(date, -7))}
          >
            <ArrowLeft size={15} />
          </button>
          <button className="wb-link" onClick={() => onDate(workbenchDate())}>
            今天
          </button>
          <button
            className="wb-icon"
            aria-label="下一周"
            onClick={() => onDate(dateOffset(date, 7))}
          >
            <ArrowRight size={15} />
          </button>
          <button className="wb-link" onClick={onAdd}>
            <Plus size={14} />
            安排日程
          </button>
        </div>
      </div>
      <div className="wb-week-grid">
        {data.week.map((day, i) => (
          <button
            key={day.date}
            className="wb-week-day"
            aria-label={`查看 ${day.date}，${day.events.length} 个日程，${day.due} 项到期待办`}
            aria-pressed={date === day.date}
            onClick={() => onDate(day.date)}
          >
            <span className="wb-week-date">
              <span>{["一", "二", "三", "四", "五", "六", "日"][i]}</span>
              <strong>{Number(day.date.slice(8))}</strong>
              {day.date === workbenchDate() && <i aria-label="今天" />}
            </span>
            <span className="wb-week-count">{day.events.length || "—"}</span>
            {day.due > 0 && (
              <span className="wb-week-mobile-due">{day.due} 待办</span>
            )}
            <span className="wb-week-items">
              {day.events.length ? (
                <>
                  <span className="wb-week-event">{day.events[0]!.title}</span>
                  {day.events.length > 1 && (
                    <small>另 {day.events.length - 1} 个日程</small>
                  )}
                </>
              ) : (
                <small>暂无日程</small>
              )}
              {day.due > 0 && (
                <small className="wb-week-due">{day.due} 项待办到期</small>
              )}
            </span>
          </button>
        ))}
      </div>
      <p className="wb-hint wb-week-hint">
        点击日期查看安排 · 本地日程暂不提供提醒
      </p>
    </section>
  );
}

export function CollectionOverview({
  data,
  selected,
  onSelect,
  compact = false,
}: {
  data: OverviewData;
  selected: CollectionKind;
  onSelect: (kind: CollectionKind) => void;
  compact?: boolean;
}) {
  const total = Object.values(data.collections).reduce((a, b) => a + b, 0);
  return (
    <section
      className={
        compact ? "wb-collection-shortcuts" : "wb-panel wb-collection-chart"
      }
      aria-label="收集分类"
    >
      {!compact && (
        <div className="wb-panel-heading">
          <h3>
            <NotePencil size={18} />
            收集构成
          </h3>
          <span className="wb-hint">当前项目 · 未归档</span>
        </div>
      )}
      {compact && (
        <button
          className="wb-collection-all"
          aria-pressed={selected === "all"}
          onClick={() => onSelect("all")}
        >
          <NotePencil size={20} />
          <strong>全部收集</strong>
          <span>{total}</span>
        </button>
      )}
      {kinds.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className="wb-collection-kind"
          aria-pressed={selected === id}
          onClick={() => onSelect(selected === id ? "all" : id)}
        >
          <span className="wb-kind-icon">
            <Icon size={19} />
          </span>
          <span className="wb-kind-label">
            {label}
            {!compact && (
              <span className="wb-kind-track">
                <span
                  style={{
                    width: `${total ? (data.collections[id] / total) * 100 : 0}%`,
                  }}
                />
              </span>
            )}
          </span>
          <strong>
            {data.collections[id]}
            <small> 条</small>
          </strong>
        </button>
      ))}
      {!compact && (
        <p className="wb-hint">
          按内容归类，每条只计入一类。点击查看原文。
          {!total && "先记下一条内容，这里就会有变化。"}
        </p>
      )}
    </section>
  );
}

export function ActivityChart({
  data,
  onDate,
}: {
  data: OverviewData;
  onDate: (date: string) => void;
}) {
  const max = Math.max(
    1,
    ...data.activity.flatMap((day) => [day.notes, day.completed]),
  );
  const notes = data.activity.reduce((sum, day) => sum + day.notes, 0);
  const completed = data.activity.reduce((sum, day) => sum + day.completed, 0);
  return (
    <section className="wb-panel wb-activity" aria-label="近七天活动">
      <div className="wb-panel-heading">
        <h3>
          <TrendUp size={18} />近 7 天记录与行动
        </h3>
      </div>
      <p className="wb-chart-summary">
        留下 <strong>{notes}</strong> 条记录，完成 <strong>{completed}</strong>{" "}
        项待办
      </p>
      <div className="wb-chart-legend">
        <span>
          <i />
          收集记录（条）
        </span>
        <span>
          <i />
          完成待办（项）
        </span>
      </div>
      <div className="wb-bar-chart">
        {data.activity.map((day) => (
          <button
            key={day.date}
            className="wb-bar-day"
            aria-label={`${day.date}：${day.notes} 条记录，${day.completed} 项完成待办，查看当天`}
            onClick={() => onDate(day.date)}
          >
            <span className="wb-bar-pair">
              <span className="wb-bar-series">
                <small>{day.notes}</small>
                <span
                  className="wb-bar"
                  style={{ height: `${(day.notes / max) * 88}px` }}
                />
              </span>
              <span className="wb-bar-series">
                <small>{day.completed}</small>
                <span
                  className="wb-bar wb-bar-completed"
                  style={{ height: `${(day.completed / max) * 88}px` }}
                />
              </span>
            </span>
            <time>{day.date.slice(5).replace("-", "/")}</time>
          </button>
        ))}
      </div>
      <p className="wb-hint">
        {notes || completed
          ? "点击柱状图查看当天；记录不含归档和回收站。"
          : "还没有记录或完成项。先记下一件事，回顾会从这里开始。"}
      </p>
    </section>
  );
}
