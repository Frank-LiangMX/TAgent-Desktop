/**
 * Goal 任务完成闸门（轻量规则版 + 可选异步 LLM shell）
 *
 * 完整 LLM judge 可后接；此处先挡「空摘要 / 无证据糊弄」。
 * P0：async 包装记录 KanbanJudgeResult；LLM 路径明确 stub，fail-open。
 */
import type { KanbanJudgeResult, KanbanTask } from '@tagent/shared'
import { updateTask } from './kanban-store'

export interface GoalJudgeResult {
  ok: boolean
  reason: string
  /** 规范化的 judge 元数据（写入 task.metadata.judgeResult） */
  judgeResult?: KanbanJudgeResult
}

function toKanbanJudgeResult(
  ok: boolean,
  reason: string,
  extra?: Partial<KanbanJudgeResult>,
): KanbanJudgeResult {
  return {
    verdict: ok ? 'done' : 'continue',
    reason,
    judgedAt: Date.now(),
    ...extra,
  }
}

/**
 * 对 complete / worker done 的摘要做验收（同步规则，主路径）
 */
export function judgeGoalComplete(
  task: Pick<KanbanTask, 'goalMode' | 'acceptanceCriteria' | 'title' | 'body'>,
  summary: string | undefined | null,
): GoalJudgeResult {
  if (task.goalMode !== true) {
    const judgeResult = toKanbanJudgeResult(true, '非 goal 任务', { verdict: 'skipped' })
    return { ok: true, reason: '非 goal 任务', judgeResult }
  }

  const s = (summary ?? '').trim()
  // 明显敷衍（整句仅完成语）
  const fluff = /^(完成|done|ok|好了|已完成|finished|完成了|搞定)[.!。！\s]*$/i
  if (!s || fluff.test(s)) {
    const reason = 'goal 任务拒绝敷衍完成语，请补充可验收证据'
    return { ok: false, reason, judgeResult: toKanbanJudgeResult(false, reason) }
  }

  // 中文场景：约 30 字起算「有内容」
  if (s.length < 30) {
    const reason = 'goal 任务摘要过短：请写清做了什么、如何验证、结果是什么'
    return { ok: false, reason, judgeResult: toKanbanJudgeResult(false, reason) }
  }

  const criteria = task.acceptanceCriteria?.trim()
  if (criteria && s.length < 50) {
    const reason = 'goal 任务有验收标准：摘要需对照标准写清验证步骤与结果'
    return { ok: false, reason, judgeResult: toKanbanJudgeResult(false, reason) }
  }

  const reason = 'goal 规则验收通过'
  return { ok: true, reason, judgeResult: toKanbanJudgeResult(true, reason) }
}

export interface JudgeGoalCompleteAsyncOpts {
  /**
   * 规则通过后是否尝试 LLM 复核。
   * P0：无轻量 LLM 依赖时 skip + fail-open（reason=llm_judge_skipped）。
   */
  preferLlm?: boolean
  /** 若提供 taskId，会把 judgeResult 写入 metadata */
  taskId?: string
}

/**
 * 异步 goal 闸门：规则优先；LLM 路径 P0 stub（fail-open）。
 *
 * 1. 先跑同步规则；失败直接返回
 * 2. 规则通过且 goalMode + preferLlm → 尝试 LLM；当前无实现则 fail-open 并记录 llm_judge_skipped
 * 3. 可选写入 task.metadata.judgeResult
 */
export async function judgeGoalCompleteAsync(
  task: Pick<
    KanbanTask,
    'id' | 'goalMode' | 'acceptanceCriteria' | 'title' | 'body' | 'metadata' | 'judgeModel'
  >,
  summary: string | undefined | null,
  opts?: JudgeGoalCompleteAsyncOpts,
): Promise<GoalJudgeResult> {
  const rule = judgeGoalComplete(task, summary)
  let result: GoalJudgeResult = rule

  if (
    rule.ok &&
    task.goalMode === true &&
    opts?.preferLlm === true
  ) {
    // P0 stub：未接入轻量 LLM，fail-open 保留规则通过
    const judgeResult: KanbanJudgeResult = {
      verdict: 'done',
      reason: 'llm_judge_skipped',
      failOpen: true,
      judgedAt: Date.now(),
      modelId: task.judgeModel,
    }
    result = {
      ok: true,
      reason: 'goal 规则通过；LLM judge 未接入（llm_judge_skipped）',
      judgeResult,
    }
  }

  const taskId = opts?.taskId ?? ('id' in task ? task.id : undefined)
  if (taskId && result.judgeResult) {
    try {
      const current = task.metadata ?? {}
      updateTask(taskId, {
        metadata: {
          ...current,
          judgeResult: result.judgeResult,
        } as KanbanTask['metadata'],
      })
    } catch (err) {
      console.warn('[goal-judge] 写入 judgeResult 失败:', err)
    }
  }

  return result
}
