import { useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileDiff,
  ListChecks,
  LoaderCircle,
  PauseCircle,
} from "lucide-react";
import type { PlanProgress } from "./plan-progress-model";

interface PlanProgressCardProps {
  progress: PlanProgress;
}

export function PlanProgressCard({
  progress,
}: PlanProgressCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const completed = progress.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const current =
    progress.steps.find((step) => step.status === "running") ??
    progress.steps.find((step) => step.status === "failed") ??
    progress.steps.find((step) => step.status === "paused") ??
    progress.steps.find((step) => step.status === "pending");
  const CurrentIcon =
    current?.status === "failed"
      ? CircleAlert
      : current?.status === "paused"
        ? PauseCircle
        : LoaderCircle;
  const currentLabel =
    current?.status === "failed"
      ? "阶段失败"
      : current?.status === "paused"
        ? "等待继续"
        : "当前步骤";
  const currentIndex = current ? progress.steps.indexOf(current) : -1;
  const fileSummary = progress.filesChanged;

  return (
    <div
      className="session-plan-progress pointer-events-auto"
      role="status"
      aria-live="polite"
      aria-label={
        progress.title + "，" + completed + "/" + progress.steps.length + " 步已完成"
      }
    >
      <div className="session-plan-progress__head">
        <div className="session-plan-progress__title-wrap">
          <span className="session-plan-progress__icon" aria-hidden>
            {current?.status === "failed" ? (
              <CircleAlert size={14} />
            ) : current?.status === "paused" ? (
              <PauseCircle size={14} />
            ) : (
              <ListChecks size={14} />
            )}
          </span>
          <span className="session-plan-progress__current-title">
            {current?.title ?? progress.title}
          </span>
          <span className="session-plan-progress__count">
            {currentIndex >= 0
              ? "第 " + (currentIndex + 1) + " / " + progress.steps.length + " 步"
              : completed + "/" + progress.steps.length}
          </span>
          {fileSummary && fileSummary.count > 0 ? (
            <span
              className="session-plan-progress__files"
              title="本轮文件变更"
            >
              <FileDiff size={12} aria-hidden />
              <span>{fileSummary.count} 个文件已更改</span>
              {typeof fileSummary.additions === "number" ? (
                <span className="session-plan-progress__files-add">
                  +{fileSummary.additions}
                </span>
              ) : null}
              {typeof fileSummary.deletions === "number" ? (
                <span className="session-plan-progress__files-del">
                  -{fileSummary.deletions}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="session-plan-progress__toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? "折叠执行计划" : "展开执行计划"}
        >
          <ChevronDown size={14} className={expanded ? "rotate-180" : ""} />
        </button>
      </div>

      {expanded && current ? (
        <div className="session-plan-progress__current">
          <CurrentIcon
            size={13}
            className={
              "session-plan-progress__spinner " +
              (current.status === "running" ? "" : "is-static")
            }
          />
          <span className="session-plan-progress__current-label">
            {currentLabel}
          </span>
          <span className="session-plan-progress__current-title">
            {current.title}
          </span>
        </div>
      ) : null}

      {expanded ? (
        <div className="session-plan-progress__details">
          <div className="session-plan-progress__details-title">
            <span>{progress.title}</span>
            <span>
              {completed}/{progress.steps.length} 已完成
            </span>
          </div>
          <div className="session-plan-progress__steps">
            {progress.steps.map((step, index) => (
              <div
                key={step.id}
                className={"session-plan-progress__step is-" + step.status}
              >
                <span
                  className="session-plan-progress__step-mark"
                  aria-hidden
                >
                  {step.status === "completed" ? (
                    <Check size={11} />
                  ) : step.status === "failed" ? (
                    <CircleAlert size={11} />
                  ) : step.status === "paused" ? (
                    <PauseCircle size={11} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="session-plan-progress__step-title">
                  {step.title}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}