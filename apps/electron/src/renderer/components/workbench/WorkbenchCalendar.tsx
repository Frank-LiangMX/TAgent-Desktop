import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  CheckSquare,
  Clock,
  Plus,
  Sparkle,
} from "@phosphor-icons/react";
import { Button } from "@tagent/ui";
import { WorkbenchTaskTimeline } from "./WorkbenchTaskTimeline";
import { useWorkbenchMotion } from "./use-workbench-motion";
import {
  workbenchDate,
  type Automation,
  type WorkbenchEvent,
  type WorkbenchState,
  type WorkbenchTodo,
} from "@tagent/shared";
import {
  calendarDayItems,
  calendarRange,
  layoutCalendarDay,
  shiftCalendar,
  calendarTodos,
  taskInterval,
  taskProgress,
  type CalendarItem,
  type CalendarMode,
} from "./workbench-calendar";

const clock = (value: number) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
function ItemLabel({ item }: { item: CalendarItem }) {
  const Icon =
    item.kind === "todo"
      ? CheckSquare
      : item.kind === "event"
        ? CalendarBlank
        : Sparkle;
  return (
    <>
      <Icon size={13} />
      <span>{item.title}</span>
      {item.kind === "event" && item.event.todoId && (
        <CheckSquare size={11} aria-label="关联待办" />
      )}
    </>
  );
}
export function WorkbenchCalendar({
  state,
  date,
  project,
  query,
  automations,
  onDate,
  onTodo,
  onEvent,
  onCreate,
  onAutomation,
  onCreateTodo,
}: {
  state: WorkbenchState;
  date: string;
  project: string;
  query: string;
  automations: Automation[];
  onDate: (date: string) => void;
  onTodo: (todo: WorkbenchTodo) => void;
  onEvent: (event: WorkbenchEvent) => void;
  onCreate: (day: string, hour?: number) => void;
  onAutomation: () => void;
  onCreateTodo?: () => void;
}) {
  const [mode, setMode] = useState<CalendarMode>("week");
  const [gantt, setGantt] = useState(false);
  const motionRef = useWorkbenchMotion(
    `${mode}:${gantt}:${date}`,
    true,
    ".wb-month, .wb-gantt, .wb-week-hours-scroll",
  );
  const [showCompleted, setShowCompleted] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const days = useMemo(() => calendarRange(date, mode), [date, mode]);
  const items = useMemo(
    () =>
      new Map(
        days.map((day) => [
          day,
          calendarDayItems(
            state,
            day,
            project,
            query,
            showCompleted,
            automations,
          ),
        ]),
      ),
    [state, days, project, query, showCompleted, automations],
  );
  useEffect(() => {
    if (mode === "week" && scroll.current) scroll.current.scrollTop = 8 * 52;
  }, [mode]);
  const open = (item: CalendarItem) =>
    item.kind === "todo"
      ? onTodo(item.todo)
      : item.kind === "event"
        ? onEvent(item.event)
        : onAutomation();
  const itemName = (item: CalendarItem) =>
    `${item.kind === "todo" ? "待办" : item.kind === "event" ? "日程" : "自动任务下一次触发"}：${item.title}${item.at === null ? "，未设具体时间" : `，${clock(item.at)}`}`;
  const selected = items.get(date) ?? [];
  const todos = calendarTodos(state, project, query, showCompleted);
  const unscheduled = todos.filter(
    (todo) => !todo.dueDate && !taskInterval(todo),
  );
  return (
    <section ref={motionRef} className="wb-calendar" aria-label="统一日历">
      <div className="wb-calendar-toolbar">
        <div className="wb-segment" aria-label="日历视图">
          <button
            aria-pressed={!gantt && mode === "week"}
            onClick={() => {
              setMode("week");
              setGantt(false);
            }}
          >
            周视图
          </button>
          <button
            aria-pressed={!gantt && mode === "month"}
            onClick={() => {
              setMode("month");
              setGantt(false);
            }}
          >
            月视图
          </button>
          <button
            aria-pressed={gantt}
            onClick={() => {
              setMode("week");
              setGantt(true);
            }}
          >
            甘特图
          </button>
        </div>
        {!gantt && (
          <div className="wb-calendar-nav">
            <button
              className="wb-icon"
              aria-label={`日历上一${mode === "week" ? "周" : "月"}`}
              onClick={() => onDate(shiftCalendar(date, mode, -1))}
            >
              <ArrowLeft size={16} />
            </button>
            <strong>
              {mode === "month"
                ? `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`
                : `${days[0]} — ${days[6]!.slice(5)}`}
            </strong>
            <button
              className="wb-icon"
              aria-label={`日历下一${mode === "week" ? "周" : "月"}`}
              onClick={() => onDate(shiftCalendar(date, mode, 1))}
            >
              <ArrowRight size={16} />
            </button>
            <button className="wb-link" onClick={() => onDate(workbenchDate())}>
              回到今天
            </button>
          </div>
        )}
        <div className="wb-calendar-actions">
          {gantt && (
            <label className="wb-calendar-completed">
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(event) => setShowCompleted(event.target.checked)}
              />
              显示已完成
            </label>
          )}
          <Button
            size="sm"
            onClick={() =>
              gantt && onCreateTodo ? onCreateTodo() : onCreate(date)
            }
          >
            <Plus size={15} />
            {gantt ? "新增待办" : "新建日程"}
          </Button>
        </div>
      </div>
      {!gantt && (
        <div className="wb-calendar-legend">
          <span>
            <CheckSquare size={13} />
            待办 · 日期或计划区间
          </span>
          <span>
            <CalendarBlank size={13} />
            日程 · 独立时间段
          </span>
          <span>
            <Sparkle size={13} />
            自动任务 · 下一次触发
          </span>
          <label>
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(event) => setShowCompleted(event.target.checked)}
            />
            显示已完成待办
          </label>
        </div>
      )}
      {gantt ? (
        <WorkbenchTaskTimeline
          todos={todos}
          date={date}
          onDate={onDate}
          onTodo={onTodo}
          onCreate={onCreateTodo}
        />
      ) : mode === "month" ? (
        <div className="wb-month">
          <div className="wb-month-weekdays">
            {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
              (day) => (
                <span key={day}>{day}</span>
              ),
            )}
          </div>
          <div className="wb-month-grid">
            {days.map((day) => (
              <div
                key={day}
                className="wb-month-day"
                data-outside={day.slice(0, 7) !== date.slice(0, 7) || undefined}
                data-selected={day === date || undefined}
              >
                <div className="wb-month-day-heading">
                  <button
                    aria-label={`选择日期 ${day}`}
                    aria-pressed={day === date}
                    onClick={() => onDate(day)}
                  >
                    {Number(day.slice(8))}
                    {day === workbenchDate() && <span>今天</span>}
                  </button>
                  <button
                    className="wb-icon"
                    aria-label={`在 ${day} 新建日程`}
                    onClick={() => onCreate(day)}
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {(items.get(day) ?? []).slice(0, 3).map((item) => (
                  <button
                    key={`${item.kind}:${item.id}`}
                    className={`wb-calendar-item is-${item.kind}`}
                    data-done={
                      (item.kind === "todo" &&
                        item.todo.completedAt !== null) ||
                      undefined
                    }
                    aria-label={itemName(item)}
                    title={itemName(item)}
                    onClick={() => open(item)}
                  >
                    <ItemLabel item={item} />
                    <small className="wb-calendar-short">
                      {item.kind === "todo"
                        ? "待办"
                        : item.kind === "event"
                          ? "日程"
                          : "自动"}
                    </small>
                  </button>
                ))}
                {(items.get(day)?.length ?? 0) > 3 && (
                  <button className="wb-month-more" onClick={() => onDate(day)}>
                    还有 {(items.get(day)?.length ?? 0) - 3} 项
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="wb-week-calendar-head">
            <span>时间</span>
            {days.map((day) => (
              <button
                key={day}
                data-selected={day === date || undefined}
                aria-label={`选择日期 ${day}`}
                aria-pressed={day === date}
                onClick={() => onDate(day)}
              >
                <span>
                  {new Date(`${day}T12:00:00`).toLocaleDateString("zh-CN", {
                    weekday: "short",
                  })}
                </span>
                <strong>{Number(day.slice(8))}</strong>
                {day === workbenchDate() && <small>今天</small>}
              </button>
            ))}
          </div>
          <div className="wb-week-undated">
            <span>日期待办</span>
            {days.map((day) => (
              <div key={day} data-selected={day === date || undefined}>
                {(items.get(day) ?? [])
                  .filter((item) => item.at === null)
                  .map((item) => (
                    <button
                      key={item.id}
                      className="wb-calendar-item is-todo"
                      data-done={
                        (item.kind === "todo" &&
                          item.todo.completedAt !== null) ||
                        undefined
                      }
                      aria-label={itemName(item)}
                      title={itemName(item)}
                      onClick={() => open(item)}
                    >
                      <ItemLabel item={item} />
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <div className="wb-week-hours-scroll scrollbar-thin" ref={scroll}>
            <div className="wb-week-hours">
              <div className="wb-hour-labels">
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={hour} style={{ top: hour * 52 }}>
                    {String(hour).padStart(2, "0")}:00
                  </span>
                ))}
              </div>
              {days.map((day) => (
                <div
                  key={day}
                  className="wb-calendar-day-column"
                  data-selected={day === date || undefined}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <button
                      key={hour}
                      className="wb-time-slot"
                      tabIndex={-1}
                      style={{ top: hour * 52 }}
                      aria-label={`安排 ${day} ${String(hour).padStart(2, "0")}:00 日程`}
                      onClick={() => onCreate(day, hour)}
                    />
                  ))}
                  {layoutCalendarDay(items.get(day) ?? [], day).map(
                    ({ item, start, visualEnd, lane, lanes }) => (
                      <button
                        key={`${item.kind}:${item.id}`}
                        className={`wb-timed-item is-${item.kind}`}
                        data-done={
                          (item.kind === "todo" &&
                            item.todo.completedAt !== null) ||
                          undefined
                        }
                        style={{
                          top: (start / 60) * 52,
                          height: ((visualEnd - start) / 60) * 52,
                          left: `${(lane / lanes) * 100}%`,
                          width: `${100 / lanes}%`,
                        }}
                        aria-label={itemName(item)}
                        title={itemName(item)}
                        onClick={() => open(item)}
                      >
                        <span className="wb-timed-title">
                          <ItemLabel item={item} />
                        </span>
                        <small>
                          {item.kind === "event"
                            ? `${clock(item.event.startAt)}–${clock(item.event.endAt)}`
                            : item.kind === "todo" && taskInterval(item.todo)
                              ? `${clock(item.todo.startAt!)}–${clock(item.todo.endAt!)} · ${taskProgress(item.todo)}%`
                              : `${clock(item.at!)} · ${item.kind === "todo" ? "计划时点" : "下次触发"}`}
                        </small>
                      </button>
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
          <p className="wb-hint wb-calendar-mobile-hint">
            窄窗口显示所选日期的时间轴，点击上方日期切换。
          </p>
        </>
      )}
      {mode === "month" && (
        <p className="wb-hint wb-calendar-mobile-hint">
          选择日期，在下方查看当天的完整安排。
        </p>
      )}
      {!gantt && (
        <div className="wb-calendar-day-detail">
          <div className="wb-section-title">
            <h3>
              {date} 的安排{" "}
              <span className="wb-count-badge">{selected.length}</span>
            </h3>
            <button className="wb-link" onClick={() => onCreate(date)}>
              <Plus size={14} />
              安排时间
            </button>
          </div>
          {!selected.length && (
            <p className="wb-empty">
              当天没有安排。给待办设置日期，或点击日历空白时间创建日程。
            </p>
          )}
          {selected.map((item) => (
            <button
              key={`${item.kind}:${item.id}`}
              className="wb-calendar-detail-item"
              onClick={() => open(item)}
            >
              <span>{item.at === null ? "日期待办" : clock(item.at)}</span>
              <span>
                <ItemLabel item={item} />
              </span>
              <small>
                {item.kind === "todo"
                  ? "编辑待办"
                  : item.kind === "event"
                    ? item.event.todoId
                      ? "关联待办的日程"
                      : "编辑日程"
                    : "打开自动化"}
              </small>
            </button>
          ))}
        </div>
      )}
      {(!gantt || unscheduled.length > 0) && (
        <section className="wb-calendar-unscheduled" aria-label="未安排待办">
          <div className="wb-section-title">
            <h3>
              未安排待办{" "}
              <span className="wb-count-badge">{unscheduled.length}</span>
            </h3>
            <span className="wb-hint">点击设置日期和持续时间</span>
          </div>
          {!unscheduled.length && <p className="wb-hint">没有未安排的待办。</p>}
          {unscheduled.map((todo) => (
            <button
              key={todo.id}
              className="wb-calendar-detail-item"
              onClick={() => onTodo(todo)}
              aria-label={`安排待办：${todo.title}`}
            >
              <CheckSquare size={16} />
              <span>{todo.title}</span>
              <small>{taskProgress(todo)}% · 安排时间</small>
            </button>
          ))}
        </section>
      )}
      {!gantt && (
        <p className="wb-hint wb-calendar-footnote">
          <Clock size={13} />
          本地待办、日程暂无提醒或 WPS
          同步。自动任务仅显示调度器已确定的下一次触发
          {project ? "，请切换全部项目查看自动任务" : ""}。
        </p>
      )}
    </section>
  );
}
