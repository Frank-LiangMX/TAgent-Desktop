import { useState } from "react";
import { ArrowLeft, ArrowRight } from "@phosphor-icons/react";
import { workbenchDate, type WorkbenchTodo } from "@tagent/shared";
import { WorkbenchGantt } from "./WorkbenchGantt";
import {
  ganttRange,
  shiftCalendar,
  type CalendarMode,
} from "./workbench-calendar";
import { useWorkbenchMotion } from "./use-workbench-motion";

export function WorkbenchTaskTimeline({
  todos,
  date,
  onDate,
  onTodo,
  onCreate,
}: {
  todos: WorkbenchTodo[];
  date: string;
  onDate: (date: string) => void;
  onTodo: (todo: WorkbenchTodo) => void;
  onCreate?: () => void;
}) {
  const [scale, setScale] = useState<CalendarMode>("month");
  const ref = useWorkbenchMotion(`${date}:${scale}`);
  return (
    <div className="wb-task-timeline">
      <div className="wb-timeline-toolbar">
        <div className="wb-timeline-period">
          <button
            className="wb-icon"
            aria-label="甘特图上一范围"
            onClick={() => onDate(shiftCalendar(date, scale, -1))}
          >
            <ArrowLeft size={16} />
          </button>
          <h3>
            {scale === "month"
              ? `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`
              : `${ganttRange(date, scale)[0]!.slice(5)} — ${ganttRange(date, scale)[6]!.slice(5)}`}
          </h3>
          <button
            className="wb-icon"
            aria-label="甘特图下一范围"
            onClick={() => onDate(shiftCalendar(date, scale, 1))}
          >
            <ArrowRight size={16} />
          </button>
        </div>
        <div className="wb-timeline-controls">
          <div className="wb-segment" aria-label="甘特图日期范围">
            <button
              aria-pressed={scale === "week"}
              onClick={() => setScale("week")}
            >
              按周
            </button>
            <button
              aria-pressed={scale === "month"}
              onClick={() => setScale("month")}
            >
              按月
            </button>
          </div>
          <button className="wb-link" onClick={() => onDate(workbenchDate())}>
            今天
          </button>
        </div>
      </div>
      <div ref={ref}>
        <WorkbenchGantt
          todos={todos}
          days={ganttRange(date, scale)}
          onTodo={onTodo}
          onCreate={onCreate}
        />
      </div>
    </div>
  );
}
