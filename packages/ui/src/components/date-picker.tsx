import * as React from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const localDate = (year: number, month: number, day: number) => {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(12, 0, 0, 0);
  return date;
};
const dateValue = (date: Date) =>
  `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = localDate(year!, month! - 1, day!);
  return dateValue(date) === value ? date : null;
};
const shiftMonth = (date: Date, offset: number) => {
  const target = localDate(date.getFullYear(), date.getMonth() + offset, 1);
  const last = localDate(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  return localDate(
    target.getFullYear(),
    target.getMonth(),
    Math.min(date.getDate(), last),
  );
};

/** Local calendar dates remain YYYY-MM-DD strings, without UTC conversion. */
export function DatePicker({
  value,
  onValueChange,
  label,
  placeholder = "选择日期",
  clearable = false,
  disabled = false,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [cursor, setCursor] = React.useState(
    () => parseDate(value) ?? new Date(),
  );
  const calendarRef = React.useRef<HTMLTableElement>(null);
  const moveFocus = React.useRef(false);
  const today = dateValue(new Date());
  const active = dateValue(cursor);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = localDate(year, month, 1);
  const start = localDate(year, month, 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) =>
    localDate(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
  const select = (next: string) => {
    onValueChange(next);
    setOpen(false);
  };
  React.useLayoutEffect(() => {
    if (moveFocus.current) {
      calendarRef.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)
        ?.focus();
      moveFocus.current = false;
    }
  }, [active]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const offsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    let next: Date;
    if (event.key in offsets)
      next = localDate(year, month, cursor.getDate() + offsets[event.key]!);
    else if (event.key === "Home" || event.key === "End") {
      const weekday = (cursor.getDay() + 6) % 7;
      next = localDate(
        year,
        month,
        cursor.getDate() + (event.key === "Home" ? -weekday : 6 - weekday),
      );
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      next = shiftMonth(
        cursor,
        (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1),
      );
    } else return;
    event.preventDefault();
    moveFocus.current = true;
    setCursor(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setCursor(parseDate(value) ?? new Date());
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={label}
          className={cn(
            "justify-between gap-3 border-input bg-transparent px-3 font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span>{value ? value.replaceAll("-", "/") : placeholder}</span>
          <CalendarDays className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        aria-label={`${label}日历`}
        className="!z-[130] w-[280px] max-w-[calc(100vw-24px)] p-3"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          calendarRef.current
            ?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)
            ?.focus();
        }}
      >
        <div className="mb-3 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            aria-label="上个月"
            onClick={() => setCursor(shiftMonth(cursor, -1))}
          >
            <ChevronLeft />
          </Button>
          <Select
            value={String(year)}
            onValueChange={(next) =>
              setCursor(shiftMonth(cursor, (Number(next) - year) * 12))
            }
          >
            <SelectTrigger
              aria-label="年份"
              className="h-8 flex-1 gap-1 border-0 px-2 shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="!z-[140]">
              {Array.from(
                { length: 201 },
                (_, index) => year - 100 + index,
              ).map((item) => (
                <SelectItem key={item} value={String(item)}>
                  {item}年
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(month)}
            onValueChange={(next) =>
              setCursor(shiftMonth(cursor, Number(next) - month))
            }
          >
            <SelectTrigger
              aria-label="月份"
              className="h-8 w-[76px] gap-1 border-0 px-2 shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="!z-[140]">
              {Array.from({ length: 12 }, (_, index) => (
                <SelectItem key={index} value={String(index)}>
                  {index + 1}月
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            aria-label="下个月"
            onClick={() => setCursor(shiftMonth(cursor, 1))}
          >
            <ChevronRight />
          </Button>
        </div>
        <table
          ref={calendarRef}
          role="grid"
          aria-label={`${year}年${month + 1}月`}
          className="w-full table-fixed border-collapse"
          onKeyDown={onKeyDown}
        >
          <thead>
            <tr>
              {weekdays.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="h-7 text-center text-xs font-normal text-muted-foreground"
                >
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, week) => (
              <tr key={week}>
                {days.slice(week * 7, week * 7 + 7).map((day) => {
                  const key = dateValue(day);
                  const selected = key === value;
                  return (
                    <td
                      key={key}
                      role="gridcell"
                      aria-selected={selected}
                      className="p-0.5 text-center"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-date={key}
                        tabIndex={key === active ? 0 : -1}
                        aria-label={key}
                        aria-current={key === today ? "date" : undefined}
                        onClick={() => select(key)}
                        className={cn(
                          "h-8 w-full p-0 text-xs font-normal",
                          day.getMonth() !== month && "text-muted-foreground",
                          key === today &&
                            !selected &&
                            "bg-foreground/[0.06] font-medium",
                          selected &&
                            "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
                        )}
                      >
                        {day.getDate()}
                      </Button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex justify-between border-t border-border/60 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!clearable || !value}
            onClick={() => select("")}
          >
            清除
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => select(today)}
          >
            今天
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
