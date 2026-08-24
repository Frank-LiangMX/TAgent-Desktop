import type { ExecutionMode } from "@tagent/shared";

export interface AutoPlanDecision {
  shouldPlan: boolean;
  reason: "explicit_plan" | "multi_phase" | "multiple_stages" | "direct";
  signals: number;
}

export interface AutoKanbanDecision {
  shouldDispatch: boolean;
  /** 用户明确要求看板时，即使任务规模较小也尊重该选择。 */
  explicit: boolean;
  reason:
    | "explicit_request"
    | "parallel_workstreams"
    | "multi_stage_delivery"
    | "direct";
  signals: number;
}

const KANBAN_REQUEST_RE =
  /(?:用|开|创建|建立|安排|交给|启用).{0,10}(?:看板|班组|派工)|(?:看板|班组|派工).{0,10}(?:拆|分|并行|处理|执行)/is;
const KANBAN_SCALE_RE =
  /并行|并发|分工|拆(?:成|分)|批量|多(?:个|项)(?:任务|模块|文件)|多模块|全链路|端到端|长跑|长任务|parallel|workstreams?|batch/i;
const SMALL_TASK_RE =
  /单文件|一个文件|小修|微调|简单(?:修改|修复)?|只改|仅改|只需|仅需|one[- ]file|small fix|single[- ]file/i;
const INVESTIGATE_RE =
  /调查|分析|梳理|查找|搜索|阅读|确认|理解|定位|审计|排查|调研/i;
const CHANGE_RE =
  /实现|修改|新增|重构|修复|改造|编写|接入|迁移|配置|替换|优化/i;
const VERIFY_RE = /测试|验证|编译|构建|打包|检查|回归|运行用例|确认结果/i;
const DELIVERY_RE = /部署|发布|文档|提交|交付|上线/i;
const EXPLICIT_PLAN_RE =
  /计划|步骤|分阶段|阶段性|里程碑|拆解|工作流|先.+(?:然后|再|接着).+(?:最后|之后)/is;

function countDistinctSignals(prompt: string): number {
  return [INVESTIGATE_RE, CHANGE_RE, VERIFY_RE, DELIVERY_RE].filter((re) =>
    re.test(prompt),
  ).length;
}

function countListItems(prompt: string): number {
  return (prompt.match(/^\s*(?:\d+[.)]|[-*])\s+/gm) ?? []).length;
}

/**
 * 只做保守的本地路由提示，不代替模型拆计划，也不改变权限模式。
 * 目的：让明显的多阶段任务稳定触发 EnterPlanMode，避免完全依赖模型临场记忆。
 */
export function assessAutoPlan(
  prompt: string,
  mode: ExecutionMode,
  isSteer = false,
): AutoPlanDecision {
  if (mode !== "work" || isSteer)
    return { shouldPlan: false, reason: "direct", signals: 0 };

  const text = prompt.trim().slice(0, 12_000);
  if (!text) return { shouldPlan: false, reason: "direct", signals: 0 };

  const signals = countDistinctSignals(text);
  const listItems = countListItems(text);
  if (EXPLICIT_PLAN_RE.test(text) && (signals >= 2 || listItems >= 2)) {
    return { shouldPlan: true, reason: "explicit_plan", signals };
  }
  if (listItems >= 3 || signals >= 3) {
    return { shouldPlan: true, reason: "multiple_stages", signals };
  }
  if (signals >= 2 && text.length >= 48) {
    return { shouldPlan: true, reason: "multi_phase", signals };
  }
  return { shouldPlan: false, reason: "direct", signals };
}

/**
 * 判断本轮是否应把主会话切到看板派工路径。
 *
 * 这是一个高置信度提示路由，不代模型凭空生成任务：模型仍负责把目标拆成
 * 可验收任务并调用 kanban_create_board / kanban_add_task。单文件、小修和短问答
 * 保持直达，避免为了“显示团队”而增加编排成本。
 */
export function assessAutoKanban(
  prompt: string,
  mode: ExecutionMode,
  isSteer = false,
): AutoKanbanDecision {
  if (mode !== "work" || isSteer) {
    return {
      shouldDispatch: false,
      explicit: false,
      reason: "direct",
      signals: 0,
    };
  }

  const text = prompt.trim().slice(0, 12_000);
  if (!text)
    return {
      shouldDispatch: false,
      explicit: false,
      reason: "direct",
      signals: 0,
    };

  const signals = countDistinctSignals(text);
  const listItems = countListItems(text);
  const explicit = KANBAN_REQUEST_RE.test(text);
  const small = SMALL_TASK_RE.test(text);

  if (explicit) {
    return {
      shouldDispatch: true,
      explicit: true,
      reason: "explicit_request",
      signals,
    };
  }

  if (
    !small &&
    KANBAN_SCALE_RE.test(text) &&
    (signals >= 2 || listItems >= 2 || text.length >= 80)
  ) {
    return {
      shouldDispatch: true,
      explicit: false,
      reason: "parallel_workstreams",
      signals,
    };
  }

  if (!small && signals >= 3 && text.length >= 40) {
    return {
      shouldDispatch: true,
      explicit: false,
      reason: "multi_stage_delivery",
      signals,
    };
  }

  if (!small && listItems >= 4 && text.length >= 80) {
    return {
      shouldDispatch: true,
      explicit: false,
      reason: "multi_stage_delivery",
      signals,
    };
  }

  return { shouldDispatch: false, explicit: false, reason: "direct", signals };
}

/** 为本轮模型注入看板分流指令；返回空串表示保持普通执行路径。 */
export function buildAutoKanbanPrompt(
  prompt: string,
  mode: ExecutionMode,
  isSteer = false,
): string {
  const decision = assessAutoKanban(prompt, mode, isSteer);
  if (!decision.shouldDispatch) return "";

  const qualification = decision.explicit
    ? "用户已明确要求使用看板，按用户选择执行。"
    : "本地调度器已判定这是适合拆分的长任务。";

  return `## 本轮自动看板分流（最高执行优先级）

${qualification}不要把本轮目标继续作为主会话里的串行长清单直接执行。

执行顺序：
1. 先调用 \`kanban_create_board\`，rootGoal 使用用户原始目标。
2. 再调用至少 3 次 \`kanban_add_task\`，每个任务必须有清晰标题、执行边界、验收标准和合适的 roleId（coder / analyst / reviewer / writer / generalist）。
3. 能并行的任务不要互相依赖；有前置关系时用 dependsOnTaskIds 表达。
4. 创建任务后调用 \`kanban_list_tasks\`，确认已进入调度器，然后由主会话负责汇总和处理阻塞。

看板工具成功后，主会话只做调度、整合和必要的最终验收；不要先进入 EnterPlanMode，也不要把同一批工作重新在主会话完整执行一遍。若模型判断目标实际上无法拆成 3 个有意义的任务，才回退到普通执行路径。`;
}

export function buildAutoPlanPrompt(
  prompt: string,
  mode: ExecutionMode,
  isSteer = false,
): string {
  const decision = assessAutoPlan(prompt, mode, isSteer);
  if (!decision.shouldPlan) return "";

  return `## 本轮自动阶段编排

调度器根据用户本轮请求检测到这是一个多阶段任务（${decision.reason}，${decision.signals} 类工作信号）。
请先调用 \`EnterPlanMode\`，把本轮工作整理成 3–8 个可验收步骤；然后调用 \`ExitPlanMode\` 交给 TAgent 的计划审批 UI。审批通过后按步骤执行，并在每个阶段完成时用一句短进度说明同步当前阶段。
阶段状态必须同时用隐藏标记同步：开始第 N 步输出 \`<!-- tagent-plan-step: N running -->\`，完成输出 \`<!-- tagent-plan-step: N completed -->\`，失败输出 \`<!-- tagent-plan-step: N failed -->\`，等待用户或外部回调输出 \`<!-- tagent-plan-step: N paused -->\`。每个标记单独成行；这是 TAgent 内部状态协议，HTML 注释不会展示给用户。
不要为了凑步骤拆分简单动作，也不要在计划审批前进行不可逆的写入。若当前上下文已经存在用户批准的计划，直接沿用并推进，不要重复进入计划模式。`;
}
