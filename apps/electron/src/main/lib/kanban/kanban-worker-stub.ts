/**
 * 看板工人 Stub（Phase D 主线先通状态机）
 *
 * 会走 resolveForWorker 投影，模拟短执行后 done。
 * 后续替换为 SessionRuntime headless 真跑。
 */
import type { KanbanTask } from '@tagent/shared'
import type { KanbanWorkerRunnerResult } from './kanban-dispatcher'
import { previewWorkerResolution } from './kanban-store'

const STUB_DELAY_MS = 400

export async function runKanbanWorkerStub(task: KanbanTask): Promise<KanbanWorkerRunnerResult> {
  const resolution = previewWorkerResolution(task, task.modelId ? [task.modelId] : [])
  await new Promise((r) => setTimeout(r, STUB_DELAY_MS))

  const summary = [
    `[stub-worker] 任务「${task.title}」已由角色「${resolution.role.displayName}」模拟完成。`,
    `roleId=${resolution.role.id}`,
    `model=${task.modelId ?? resolution.modelId ?? '未分配'}`,
    `permission=${resolution.permissionMode}`,
    `tools=${resolution.tools.join(',')}`,
    '',
    '—— 工人 systemPrompt 摘要（前 400 字）——',
    resolution.systemPrompt.slice(0, 400) + (resolution.systemPrompt.length > 400 ? '…' : ''),
    '',
    '（完整 headless Agent 工人待接入 SessionRuntime）',
  ].join('\n')

  return { summary, finalStatus: 'done' }
}
