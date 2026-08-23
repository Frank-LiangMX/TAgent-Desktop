export type PlanStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused";

export interface PlanStepSignal {
  step: number;
  status: Exclude<PlanStepStatus, "pending">;
}

export interface PlanProgressStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface PlanProgress {
  title: string;
  steps: PlanProgressStep[];
  filesChanged?: {
    count: number;
    additions?: number;
    deletions?: number;
  };
}

/** 将主进程发来的结构化阶段状态合并进当前计划。step 使用 1-based 编号。 */
export function applyPlanStepSignal(
  progress: PlanProgress,
  signal: PlanStepSignal,
): PlanProgress {
  const index = signal.step - 1;
  if (index < 0 || index >= progress.steps.length) return progress;
  return {
    ...progress,
    steps: progress.steps.map((step, stepIndex) => ({
      ...step,
      status:
        stepIndex < index
          ? "completed"
          : stepIndex === index
            ? signal.status
            : step.status,
    })),
  };
}

const STEP_RE = /^\s*(?:[-*]|\d+[.)])\s+(?:\[([ xX~✓])\]\s*)?(.+?)\s*$/;
const HEADING_RE = /^\s*#{2,6}\s+(.+?)\s*$/;

function cleanStepTitle(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从 ExitPlanMode 的 Markdown 中抽取少量可执行步骤。
 * 这里只解析已有计划，不根据普通正文猜测步骤，避免 UI 显示虚假的进度。
 */
export function parsePlanProgress(markdown: string): PlanProgress | null {
  const lines = markdown.split(/\r?\n/);
  const steps: Array<{ title: string; explicit: PlanStepStatus | null }> = [];
  let heading = "执行计划";

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch && heading === "执行计划") {
      const candidate = cleanStepTitle(headingMatch[1] ?? "");
      if (candidate && !/^plan$/i.test(candidate)) heading = candidate;
      continue;
    }

    const match = line.match(STEP_RE);
    if (!match) continue;
    const marker = (match[1] ?? "").toLowerCase();
    const title = cleanStepTitle(match[2] ?? "");
    if (!title) continue;
    steps.push({
      title,
      explicit:
        marker === "x" || marker === "✓"
          ? "completed"
          : marker === "~"
            ? "running"
            : marker
              ? "pending"
              : null,
    });
  }

  if (steps.length === 0) {
    const fallback = cleanStepTitle(
      lines
        .filter((line) => line.trim() && !/^\s*#/.test(line))
        .slice(0, 1)
        .join(""),
    );
    if (!fallback) return null;
    steps.push({ title: fallback, explicit: null });
  }

  const hasExplicitStatus = steps.some((step) => step.explicit != null);
  let activeIndex = steps.findIndex((step) => step.explicit !== "completed");
  if (activeIndex < 0) activeIndex = steps.length - 1;

  return {
    title: heading,
    steps: steps.slice(0, 12).map((step, index) => ({
      id: `plan-step-${index}`,
      title: step.title,
      status:
        hasExplicitStatus && step.explicit
          ? step.explicit
          : index < activeIndex
            ? "completed"
            : index === activeIndex
              ? "running"
              : "pending",
    })),
  };
}
