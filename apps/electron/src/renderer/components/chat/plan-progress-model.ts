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
  const nextSteps = progress.steps.map((step, stepIndex) => ({
    ...step,
    status:
      stepIndex < index
        ? ("completed" as PlanStepStatus)
        : stepIndex === index
          ? signal.status
          : step.status,
  }));
  // 无变化则返回原对象，便于调用方跳过 setState
  if (
    nextSteps.every(
      (step, stepIndex) => step.status === progress.steps[stepIndex]?.status,
    )
  ) {
    return progress;
  }
  return {
    ...progress,
    steps: nextSteps,
  };
}

/** 计划是否还有未完成步骤（失败也算未收尾，保留卡片）。 */
export function isPlanIncomplete(progress: PlanProgress | null | undefined): boolean {
  if (!progress || progress.steps.length === 0) return false;
  return progress.steps.some(
    (step) => step.status !== "completed",
  );
}

/** 运行结束但计划未做完时，把当前 running 收成 paused，避免卡片假装还在跑。 */
export function pauseActivePlanSteps(progress: PlanProgress): PlanProgress {
  let changed = false;
  const steps = progress.steps.map((step) => {
    if (step.status !== "running") return step;
    changed = true;
    return { ...step, status: "paused" as const };
  });
  return changed ? { ...progress, steps } : progress;
}

/** 新回合确实开始工作时，恢复当前暂停步骤；后续 pending 步骤保持不变。 */
export function resumePausedPlanStep(progress: PlanProgress): PlanProgress {
  const index = progress.steps.findIndex((step) => step.status !== "completed");
  if (index < 0 || progress.steps[index]?.status !== "paused") return progress;
  return {
    ...progress,
    steps: progress.steps.map((step, stepIndex) =>
      stepIndex === index ? { ...step, status: "running" as const } : step,
    ),
  };
}
/**
 * 模型不写隐藏标记时：用步骤标题是否出现在 assistant 正文里推断推进。
 * 只匹配足够长的标题，避免短词误伤；命中后将该步标为 running，并把更早步骤标完成。
 */
export function inferPlanStepSignalsFromText(
  progress: PlanProgress,
  text: string,
): PlanStepSignal[] {
  const haystack = text.trim();
  if (!haystack || progress.steps.length === 0) return [];

  let bestIndex = -1;
  for (let i = 0; i < progress.steps.length; i++) {
    const title = progress.steps[i]?.title?.trim() ?? "";
    if (title.length < 6) continue;
    if (haystack.includes(title)) bestIndex = i;
  }
  if (bestIndex < 0) return [];

  const current = progress.steps[bestIndex];
  if (!current) return [];
  // 已完成/失败不再因正文回声回退
  if (current.status === "completed" || current.status === "failed") return [];
  if (current.status === "running") return [];
  return [{ step: bestIndex + 1, status: "running" }];
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
