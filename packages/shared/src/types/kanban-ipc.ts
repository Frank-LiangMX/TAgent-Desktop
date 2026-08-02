/**
 * Kanban 看板 IPC 通道常量与请求/响应类型
 *
 * 渲染进程通过 window.electronAPI.kanban.* 调用，主进程在 main/ipc.ts 注册处理器。
 * 通道命名与 automation 一致：动词:名词 形式，CHANGED 为 main→renderer 广播。
 */

import type {
  KanbanBoard,
  KanbanBoardMode,
  KanbanBoardStatus,
  KanbanTask,
  ProgressLogEntry,
  CreateKanbanTaskInput,
} from './kanban'
export const KANBAN_IPC_CHANNELS = {
  /** 列出某看板下全部任务 */
  LIST_TASKS: 'kanban:list-tasks',
  /** 获取单条任务 */
  GET_TASK: 'kanban:get-task',
  /** 获取看板信息 */
  GET_BOARD: 'kanban:get-board',
  /** 列出所有看板（B4：全局看板视图，支持 mode 过滤） */
  LIST_BOARDS: 'kanban:list-boards',
  /** 独立创建看板（不绑定会话，B4 起看板为一等实体） */
  CREATE_BOARD: 'kanban:create-board',
  /** 更新看板（标题/状态，B4） */
  UPDATE_BOARD: 'kanban:update-board',
  /** 删除看板（软删除：status='cancelled'，B4） */
  DELETE_BOARD: 'kanban:delete-board',
  /** 新建任务（B5：UI 创建任务闭环，channelId 由渲染层从全局选中渠道兜底） */
  CREATE_TASK: 'kanban:create-task',
  /** 草稿升级自动建板（按 RequirementBlock 建 task） */
  CREATE_BOARD_FROM_DRAFT: 'kanban:create-board-from-draft',
  /** 看板数据变更事件（main → renderer，任务状态变化时推送） */
  CHANGED: 'kanban:changed',
  /** 获取数字员工角色统计（缓存于内存） */
  GET_CREW_STATS: 'kanban:get-crew-stats',
  /** 看板全部任务完成事件（main → renderer，事件回流方案 B） */
  BOARD_COMPLETED: 'kanban:board-completed',
  /** 暂停看板调度（停止 tick，不清空在途任务） */
  PAUSE_BOARD: 'kanban:pause-board',
  /** 恢复看板调度 */
  RESUME_BOARD: 'kanban:resume-board',
  /** 解除任务阻塞（blocked → ready） */
  UNBLOCK_TASK: 'kanban:unblock-task',
  /** 重试失败任务（failed → ready，让 dispatcher 重新派工） */
  RETRY_TASK: 'kanban:retry-task',
  /** 中止正在执行的任务（running → cancelled，调 stopRegisteredAgent 停掉 worker SDK query） */
  ABORT_TASK: 'kanban:abort-task',
  /** 给任务写 blackboard 评论（D+2 跨任务交接通道，主会话 / UI 调用） */
  COMMENT_TASK: 'kanban:comment-task',
  /** 把已有看板绑定到会话（写回 session meta.boardId，显示团队 Tab） */
  ATTACH_BOARD_TO_SESSION: 'kanban:attach-board-to-session',
  /** 解绑会话的看板（清除 session meta.boardId，隐藏团队 Tab） */
  DETACH_BOARD_FROM_SESSION: 'kanban:detach-board-from-session',
  /** 任务进度日志实时推送（main → renderer，task_progress SDK 事件） */
  TASK_PROGRESS: 'kanban:task-progress',
} as const

/** 任务进度日志实时推送 payload（main → renderer） */
export interface TaskProgressPayload {
  /** 任务 ID */
  taskId: string
  /** 新追加的进度条目 */
  entry: ProgressLogEntry
  /** 当前完整日志列表 */
  logs: ProgressLogEntry[]
}

/** 解除阻塞输入 */
export interface UnblockKanbanTaskInput {
  /** 任务 ID */
  taskId: string
  /** 可选：解除原因（写入 metadata.unblockReason） */
  reason?: string
}

/** 写 blackboard 评论输入（D+2） */
export interface CommentKanbanTaskInput {
  /** 任务 ID */
  taskId: string
  /** 评论内容 */
  comment: string
  /** 作者（'main' / 'worker' / sessionId 等，UI 默认 'main'） */
  author: string
}

/** 草稿升级自动建板输入 */
export interface CreateBoardFromDraftInput {
  /** 主会话 ID（作为 board.parentSessionId，并写回 meta.boardId） */
  sessionId: string
  /** AI 渠道 ID（任务继承） */
  channelId: string
  /** 工作区 ID（创建工人子会话时使用，可选） */
  workspaceId?: string
  /** 看板根目标（通常是草稿标题） */
  rootGoal: string
  /** 需求块列表（每块映射为一个看板任务） */
  requirements: Array<{
    /** 需求标签（如 "R-1"） */
    label: string
    /** 需求标题 */
    title: string
    /** 需求描述 */
    description: string
    /** 验收标准（可选，拼到任务 body） */
    acceptanceCriteria?: string[]
  }>
}

/** 草稿升级自动建板返回 */
export interface CreateBoardFromDraftResult {
  /** 创建的看板 ID */
  boardId: string
  /** 创建的任务列表 */
  tasks: KanbanTask[]
  /** 看板信息 */
  board: KanbanBoard
}

/** 列出所有看板输入（B4：全局看板视图） */
export interface ListKanbanBoardsInput {
  /** 按模式过滤（可选，不填=所有模式） */
  mode?: KanbanBoardMode
  /** 按状态过滤（可选，默认只看 active） */
  status?: KanbanBoardStatus
}

/** 独立创建看板输入（B4：不绑定会话） */
export interface CreateKanbanBoardIpcInput {
  /** 用户原始目标 */
  rootGoal: string
  /** 看板展示名（可选，不填则用 rootGoal） */
  title?: string
  /** 发起会话 ID（可选，保留追溯来源） */
  parentSessionId?: string
  /** 所属模式（默认 general） */
  mode?: KanbanBoardMode
  /** AI 渠道 ID（可选，仅记录到 board.originChatId 之外的 metadata；task 创建时再指定 channelId） */
  channelId?: string
  /** 工作区 ID（可选） */
  workspaceId?: string
  /** IM 来源聊天 ID（可选） */
  originChatId?: string
  /** IM 来源桥接类型（可选） */
  originBridge?: KanbanBoard['originBridge']
}

/** 更新看板输入（B4：标题/状态；B5：并发上限/暂停） */
export interface UpdateKanbanBoardInput {
  /** 看板 ID */
  boardId: string
  /** 新标题（可选） */
  title?: string
  /** 新状态（可选） */
  status?: KanbanBoardStatus
  /** 最大并发任务数（可选，B5 per-board 并发隔离） */
  maxConcurrent?: number
  /** 是否暂停调度（可选，true 时 dispatcher 跳过该看板派工，B5） */
  paused?: boolean
}

/** 删除看板输入（B4：软删除） */
export interface DeleteKanbanBoardInput {
  /** 看板 ID */
  boardId: string
  /** 是否硬删除（true=真删，false=软删除 status='cancelled'，默认 false） */
  hard?: boolean
}

/**
 * 新建任务 IPC 输入（B5：UI 创建任务闭环）
 *
 * 与 CreateKanbanTaskInput 对齐，但 channelId 必填：
 * board 当前未存 channelId 字段，由渲染层从全局选中渠道（selectedModelAtom）兜底传入。
 */
export interface CreateKanbanTaskIpcInput extends CreateKanbanTaskInput {
  /** AI 渠道 ID（必填，任务创建后不可跨渠道） */
  channelId: string
}

/** 把已有看板绑定到会话输入 */
export interface AttachBoardToSessionInput {
  /** 会话 ID（写入 meta.boardId） */
  sessionId: string
  /** 看板 ID（必须已存在） */
  boardId: string
}

/** 解绑会话的看板输入 */
export interface DetachBoardFromSessionInput {
  /** 会话 ID（清除 meta.boardId） */
  sessionId: string
}
