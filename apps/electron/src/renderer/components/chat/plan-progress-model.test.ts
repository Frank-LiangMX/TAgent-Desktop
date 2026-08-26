import { describe, expect, it } from "vitest";
import {
  applyPlanStepSignal,
  inferPlanStepSignalsFromText,
  isPlanIncomplete,
  parsePlanProgress,
  pauseActivePlanSteps,
  resumePausedPlanStep,
  type PlanProgress,
} from "./plan-progress-model";

function samplePlan(): PlanProgress {
  return {
    title: "执行计划",
    steps: [
      { id: "plan-step-0", title: "梳理现有权限模式切换逻辑", status: "running" },
      { id: "plan-step-1", title: "补齐 ExitPlanMode 审批横幅", status: "pending" },
      { id: "plan-step-2", title: "加回归测试并手测批准路径", status: "pending" },
    ],
  };
}

describe("parsePlanProgress", () => {
  it("parses markdown numbered lists into steps with first running", () => {
    const progress = parsePlanProgress(`## 修复计划
1. 梳理现有权限模式切换逻辑
2. 补齐 ExitPlanMode 审批横幅
3. 加回归测试并手测批准路径
`);
    expect(progress?.title).toBe("修复计划");
    expect(progress?.steps).toHaveLength(3);
    expect(progress?.steps[0]?.status).toBe("running");
    expect(progress?.steps[1]?.status).toBe("pending");
    expect(progress?.steps[2]?.status).toBe("pending");
  });
});

describe("applyPlanStepSignal", () => {
  it("marks earlier steps completed when a later step starts", () => {
    const next = applyPlanStepSignal(samplePlan(), {
      step: 2,
      status: "running",
    });
    expect(next.steps.map((s) => s.status)).toEqual([
      "completed",
      "running",
      "pending",
    ]);
  });
});

describe("plan incompleteness helpers", () => {
  it("detects incomplete plans and pauses running steps", () => {
    const plan = samplePlan();
    expect(isPlanIncomplete(plan)).toBe(true);
    const paused = pauseActivePlanSteps(plan);
    expect(paused.steps[0]?.status).toBe("paused");
    expect(isPlanIncomplete(paused)).toBe(true);
    const done = applyPlanStepSignal(
      applyPlanStepSignal(
        applyPlanStepSignal(plan, { step: 1, status: "completed" }),
        { step: 2, status: "completed" },
      ),
      { step: 3, status: "completed" },
    );
    expect(isPlanIncomplete(done)).toBe(false);
  });
});

describe("resumePausedPlanStep", () => {
  it("only resumes the first incomplete paused step", () => {
    const paused = pauseActivePlanSteps(samplePlan());
    const resumed = resumePausedPlanStep(paused);
    expect(resumed.steps.map((step) => step.status)).toEqual([
      "running",
      "pending",
      "pending",
    ]);
  });
});
describe("inferPlanStepSignalsFromText", () => {
  it("advances when a later step title appears in assistant text", () => {
    const plan = samplePlan();
    expect(
      inferPlanStepSignalsFromText(
        plan,
        "接下来开始：补齐 ExitPlanMode 审批横幅，把 Banner 接上。",
      ),
    ).toEqual([{ step: 2, status: "running" }]);
  });

  it("ignores short or already-active titles", () => {
    const plan = samplePlan();
    expect(inferPlanStepSignalsFromText(plan, "随便聊聊权限")).toEqual([]);
    expect(
      inferPlanStepSignalsFromText(
        plan,
        "仍在梳理现有权限模式切换逻辑，尚未完成。",
      ),
    ).toEqual([]);
  });
});
