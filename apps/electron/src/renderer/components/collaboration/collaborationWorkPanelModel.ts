/**
 * 协作室工作面板纯模型（S5 室级任务/产物面板）。
 *
 * 只做 task/artifact 的分组、相互链接、sha 短码等纯计算；不触 IPC、不读成员名（成员名
 * 由组件层用 members 解析，保持本模块可离线单测）。组件据此渲染分组、关联与「无关联」空态。
 *
 * 边界对齐 02-RUNTIME-A2A-SPEC §2.6：room task / artifact 都是主进程落盘的真值，渲染层只读
 * 其 id 字段做链接展示，绝不自行推导状态或路径。
 */
import {
  canTransitionCollaborationRoomTaskStatus,
  type CollaborationArtifact,
  type CollaborationRoomTask,
  type CollaborationRoomTaskStatus,
} from '@tagent/shared'

/** 面板展示用的状态分组顺序（与状态机枚举一致，便于稳定渲染） */
export const ROOM_TASK_STATUS_ORDER: readonly CollaborationRoomTaskStatus[] = [
  'todo',
  'in_progress',
  'blocked',
  'done',
  'failed',
] as const

/** 任务状态 → 中文标签（面板分组标题与状态徽章共用） */
export function roomTaskStatusLabel(status: CollaborationRoomTaskStatus): string {
  switch (status) {
    case 'todo':
      return '待办'
    case 'in_progress':
      return '进行中'
    case 'blocked':
      return '阻塞'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
  }
}

/**
 * 把任务按状态分到五组（保留每组内的原序，即 createdAt 升序）。
 *
 * 输入应是 service.listRoomTasks 已排好序的数组；本函数不再排序，仅分组，避免与真值层序冲突。
 */
export function groupRoomTasksByStatus(
  tasks: readonly CollaborationRoomTask[],
): Record<CollaborationRoomTaskStatus, CollaborationRoomTask[]> {
  const groups: Record<CollaborationRoomTaskStatus, CollaborationRoomTask[]> = {
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
    failed: [],
  }
  for (const t of tasks) {
    // 防御：未知状态（理论不会出现）归到 todo，避免渲染丢项
    const bucket = groups[t.status] ?? groups.todo
    bucket.push(t)
  }
  return groups
}

/** sha256 短码：取前 12 位 hex（与 artifact 时间线消息里的短码口径一致） */
export function artifactShaShort(sha256: string): string {
  return (sha256 ?? '').slice(0, 12)
}

/** 统计某任务关联的产物数量（artifact.taskId === task.id） */
export function countArtifactsForTask(
  artifacts: readonly CollaborationArtifact[],
  taskId: string,
): number {
  return artifacts.filter((a) => a.taskId === taskId).length
}

/** 找到产物关联的任务（同房间；artifact.taskId → task） */
export function findTaskForArtifact(
  tasks: readonly CollaborationRoomTask[],
  artifact: CollaborationArtifact,
): CollaborationRoomTask | undefined {
  if (!artifact.taskId) return undefined
  return tasks.find((t) => t.id === artifact.taskId)
}

/** 任务行的关联信息：关联 run / 产生消息 / 关联产物数（无则 undefined，由组件显式标「无」） */
export interface TaskLinkInfo {
  /** 关联 run ID（执行追溯） */
  runId?: string
  /** 产生该任务的消息 ID（因果追溯） */
  sourceMessageId?: string
  /** 关联产物数量 */
  artifactCount: number
}

/** 汇总任务关联信息（纯计算，不读成员） */
export function buildTaskLinkInfo(
  task: CollaborationRoomTask,
  artifacts: readonly CollaborationArtifact[],
): TaskLinkInfo {
  return {
    runId: task.runId,
    sourceMessageId: task.sourceMessageId,
    artifactCount: countArtifactsForTask(artifacts, task.id),
  }
}

/** 产物行的关联信息：关联任务标题 / 关联 run（无则 undefined，由组件显式标「无」） */
export interface ArtifactLinkInfo {
  /** 关联任务 ID */
  taskId?: string
  /** 关联任务标题（若有 taskId 但找不到任务，给 null 以便组件区分「无关联」与「任务已删」） */
  taskTitle: string | null
  /** 关联 run ID（执行追溯） */
  runId?: string
}

/** 汇总产物关联信息（纯计算，不读成员） */
export function buildArtifactLinkInfo(
  artifact: CollaborationArtifact,
  tasks: readonly CollaborationRoomTask[],
): ArtifactLinkInfo {
  const task = findTaskForArtifact(tasks, artifact)
  return {
    taskId: artifact.taskId,
    taskTitle: task ? task.title : artifact.taskId ? null : null,
    runId: artifact.runId,
  }
}

/**
 * 列出从当前状态可迁移到的合法下一状态（用于面板状态切换按钮）。
 *
 * 复用 shared 的严格状态机：自环与非法迁移一律不出现在选项里。返回顺序按状态机枚举固定，
 * 组件按此顺序渲染按钮即可。
 */
export function legalNextTaskStatuses(
  current: CollaborationRoomTaskStatus,
): CollaborationRoomTaskStatus[] {
  const all: CollaborationRoomTaskStatus[] = [...ROOM_TASK_STATUS_ORDER]
  return all.filter((s) => s !== current && canTransitionCollaborationRoomTaskStatus(current, s))
}
