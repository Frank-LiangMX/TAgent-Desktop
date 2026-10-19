import { type WorkbenchTodo, workbenchDate } from "@tagent/shared";
import type { CSSProperties } from "react";
import { ChartBarHorizontal, ArrowRight, Plus } from "@phosphor-icons/react";
import { Button } from "@tagent/ui";
import { dateOffset } from "./workbench-overview";
import { taskDuration, taskInterval, taskProgress } from "./workbench-calendar";

export function WorkbenchGantt({
  todos,
  days,
  onTodo,
  onCreate,
}: {
  todos: WorkbenchTodo[];
  days: string[];
  onTodo: (todo: WorkbenchTodo) => void;
  onCreate?: () => void;
}) {
  const start = new Date(`${days[0]}T00:00:00`).getTime();
  const end = new Date(
    `${dateOffset(days[days.length - 1]!, 1)}T00:00:00`,
  ).getTime();
  const rows = todos
    .map((todo) => {
      const planned = taskInterval(todo);
      const interval =
        planned ??
        (todo.dueDate && !todo.dueTime
          ? {
              start: new Date(`${todo.dueDate}T00:00`).getTime(),
              end: new Date(`${dateOffset(todo.dueDate, 1)}T00:00`).getTime(),
            }
          : null);
      const point = todo.dueDate
        ? new Date(`${todo.dueDate}T${todo.dueTime || "00:00"}`).getTime()
        : null;
      return {
        todo,
        interval,
        start: interval?.start ?? point,
        end: interval?.end ?? point,
      };
    })
    .filter(
      (row) =>
        row.start !== null &&
        row.end !== null &&
        (row.interval
          ? row.start < end && row.end > start
          : row.start >= start && row.start < end),
    )
    .sort((a, b) => a.start! - b.start!);
  const format = (at: number) =>
    new Date(at).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const unscheduled = todos.filter(
    (todo) => !todo.dueDate && !taskInterval(todo),
  );
  const month = days.length > 7;
  if (!rows.length)
    return (
      <section className="wb-gantt wb-gantt-empty" aria-label="任务进度甘特图">
        <div className="wb-gantt-empty-icon">
          <ChartBarHorizontal size={28} weight="light" />
        </div>
        <h4>{month ? "这个月" : "这一周"}还没有排期任务</h4>
        <p>
          {unscheduled.length
            ? `${unscheduled.length} 项待办尚未安排日期，选一项开始排期。`
            : "为待办设置起止日期，在这里查看任务跨度与完成进度。"}
        </p>
        {unscheduled[0] ? (
          <Button variant="outline" onClick={() => onTodo(unscheduled[0]!)}>
            安排待办
            <ArrowRight size={15} />
          </Button>
        ) : (
          onCreate && (
            <Button variant="outline" onClick={onCreate}>
              <Plus size={15} />
              新增待办
            </Button>
          )
        )}
      </section>
    );
  return (
    <section className="wb-gantt" aria-label="任务进度甘特图">
      <div className="wb-gantt-scroll scrollbar-thin">
        <div
          className="wb-gantt-grid"
          style={
            {
              "--gantt-days": days.length,
              "--gantt-today": days.indexOf(workbenchDate()),
              minWidth: month ? 720 : 600,
            } as CSSProperties
          }
        >
          <div className="wb-gantt-heading">
            <strong>
              任务 <span>{rows.length}</span>
            </strong>
            <div className="wb-gantt-dates" data-month={month || undefined}>
              {days.map((day) => (
                <span
                  key={day}
                  data-today={day === workbenchDate() || undefined}
                  data-weekend={
                    [0, 6].includes(new Date(`${day}T12:00`).getDay()) ||
                    undefined
                  }
                >
                  <b>{Number(day.slice(8))}</b>
                  {!month && (
                    <small>
                      {new Date(`${day}T12:00`).toLocaleDateString("zh-CN", {
                        weekday: "short",
                      })}
                    </small>
                  )}
                </span>
              ))}
            </div>
          </div>
          {rows.map(({ todo, interval, start: from, end: to }) => {
            const left =
              ((Math.max(start, from!) - start) / (end - start)) * 100;
            const width =
              ((Math.min(end, to!) - Math.max(start, from!)) / (end - start)) *
              100;
            const progress = taskProgress(todo);
            const visibleProgress = interval
              ? Math.max(
                  0,
                  Math.min(
                    100,
                    ((Math.min(
                      end,
                      interval.start +
                        ((interval.end - interval.start) * progress) / 100,
                    ) -
                      Math.max(start, interval.start)) /
                      (Math.min(end, interval.end) -
                        Math.max(start, interval.start))) *
                      100,
                  ),
                )
              : 0;
            const label = `${todo.title}，${interval ? `${format(interval.start)} 至 ${format(interval.end)}，持续 ${taskDuration(interval.end - interval.start)}` : `${todo.dueDate}，未设置持续时间`}，完成 ${progress}%`;
            return (
              <div key={todo.id} className="wb-gantt-row">
                <button
                  className="wb-gantt-task"
                  onClick={() => onTodo(todo)}
                  aria-label={`编辑任务：${todo.title}`}
                >
                  <span className="wb-gantt-task-title">
                    <strong>{todo.title}</strong>
                    <span>{progress}%</span>
                  </span>
                  <span>
                    {interval
                      ? `${workbenchDate(interval.start).slice(5)} — ${workbenchDate(interval.end - 1).slice(5)} · ${taskDuration(interval.end - interval.start)}`
                      : `${todo.dueDate.slice(5)} · 计划时点`}
                    {todo.completedAt !== null && " · 已完成"}
                  </span>
                </button>
                <div className="wb-gantt-track">
                  <button
                    className={`wb-gantt-bar${interval ? "" : " is-point"}`}
                    title={label}
                    aria-label={label}
                    style={{
                      left: `${left}%`,
                      width: interval ? `${width}%` : undefined,
                    }}
                    data-compact={width < 8 || undefined}
                    onClick={() => onTodo(todo)}
                  >
                    {interval && (
                      <span
                        className="wb-gantt-fill"
                        style={{ width: `${visibleProgress}%` }}
                      />
                    )}
                    <span className="wb-gantt-bar-label">{todo.title}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="wb-gantt-caption">
        <span>
          <i />
          计划区间
        </span>
        <span>
          <i className="is-progress" />
          完成进度
        </span>
        <span>点击任务可调整排期</span>
      </div>
    </section>
  );
}
