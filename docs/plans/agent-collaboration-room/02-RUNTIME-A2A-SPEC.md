# Agent 协作室：Runtime 与 A2A 规格

> 上位文档：[00-MASTER](./00-MASTER.md)
> 原则：逻辑成员持久、物理进程按需；结构化 A2A、异步信箱；任务与消息分账。
> mention 守卫、上下文投影算法、房间摘要与 handoff outbox 的实现契约：[04 Hermes 机制移植](./04-HERMES-BORROW-SPEC.md)。

## 1. 运行时拓扑

```text
RoomService（持久化与查询）
    │
    ├─ RoomScheduler（公平调度、并发、预算、恢复）
    │      ├─ MemberTurnRunner A ── Pi / HTTP / CLI worker
    │      ├─ MemberTurnRunner B ── Pi / HTTP / CLI worker
    │      └─ CoordinatorRunner  ── Pi / HTTP / CLI worker
    │
    ├─ RoomMailbox（A2A 收件、回复、等待关系）
    ├─ RoomTaskBridge（room task ↔ kanban task）
    ├─ WorkspaceCoordinator（worktree / file lease / diff）
    └─ RoomEventBus（DB 先落盘，再推 IPC）
```

每个成员有独立的逻辑会话，但不要求常驻一个 OS 进程：

```text
稳定 memberSessionId
  + 成员角色/权限
  + 滚动摘要
  + 最近房间事件投影
  + 收件箱消息
  + 后端 resume token（若支持）
       ↓ 唤醒
一次 Member Turn（短命进程或 API run）
       ↓
落盘消息/工具事件/摘要/后端 token → 释放物理执行资源
```

这与当前“一任务一进程”的 CLI worker 设计兼容。长驻双工只作为后续 capability，不作为 MVP 前提。

## 2. 持久化模型

建议在 shared types + 主进程 SQLite repository 建立以下实体。字段名为设计契约，可在 migration 前细化类型。

### 2.1 `collaboration_rooms`

```ts
interface CollaborationRoom {
  id: string
  title: string
  goal: string
  workspaceId: string
  coordinatorMemberId: string
  status: 'active' | 'paused' | 'archived' | 'completed'
  maxConcurrentRuns: number
  maxA2ADepth: number       // default 4, hard max 10
  budget: RoomBudget
  attachedBoardId?: string
  createdAt: number
  updatedAt: number
}
```

### 2.2 `collaboration_members`

```ts
interface CollaborationMember {
  id: string
  roomId: string
  displayName: string
  roleId?: string
  roleSnapshot: RoleSnapshot
  backend: 'pi' | 'channel' | 'cli'
  channelId?: string
  modelId?: string
  cliWorkerId?: string
  logicalSessionId: string
  backendResumeToken?: string
  permissionProfile: 'read-only' | 'workspace-write'
  capabilities: MemberCapabilities
  status: MemberStatus
  summary?: string
  createdAt: number
  updatedAt: number
}
```

`roleSnapshot` 必须落快照，避免角色库更新后历史行为被无声改写。`backendResumeToken` 仅保存 CLI/SDK 明确支持的原生 session/thread ID；不支持时依靠宿主摘要与事件投影恢复。

### 2.3 `collaboration_messages`

```ts
interface CollaborationMessage {
  id: string
  roomId: string
  authorType: 'user' | 'member' | 'system'
  authorId: string
  kind: 'chat' | 'a2a_request' | 'a2a_reply' | 'task_event' | 'artifact' | 'warning'
  content: string
  visibility: 'room' | 'participants' | 'user_only'
  targetMemberIds: string[]
  replyToMessageId?: string
  rootMessageId: string
  causationId?: string
  runId?: string
  taskId?: string
  depth: number
  createdAt: number
}
```

### 2.4 `collaboration_runs`

```ts
interface CollaborationRun {
  id: string
  roomId: string
  memberId: string
  triggerMessageId: string
  taskId?: string
  status: 'queued' | 'running' | 'awaiting_peer' | 'awaiting_user' |
          'done' | 'failed' | 'cancelled' | 'blocked'
  attempt: number
  startedAt?: number
  finishedAt?: number
  usage?: UsageRecord
  error?: SerializedRunError
}
```

### 2.5 `collaboration_mailbox`

```ts
interface MailboxEnvelope {
  id: string
  roomId: string
  fromMemberId: string
  toMemberId: string
  type: 'message' | 'question' | 'reply' | 'handoff'
  requestId?: string
  payload: string
  rootMessageId: string
  causationId: string
  depth: number
  state: 'pending' | 'delivered' | 'answered' | 'cancelled' | 'expired'
  createdAt: number
  expiresAt?: number
}
```

### 2.6 任务与产物

- `collaboration_room_tasks` 只承载无看板时的轻量任务真值。
- 附加看板后，room 保存 `boardId/taskId` 引用，状态由 kanban repository 提供；room timeline 只保存投影事件。
- `collaboration_artifacts` 保存工作区相对路径、作者 member/run/task、hash、diff 或外链；绝不信任模型提供的任意绝对路径。

## 3. 成员状态机

```text
offline ── backend available ──> idle
idle ── message/task ──> queued ── scheduled ──> running
running ── ask peer ──> awaiting_peer ── reply ──> queued
running ── ask user ──> awaiting_user ── answer ──> queued
running ── success ──> done ──> idle
running ── recoverable error ──> blocked ── retry/change ──> queued
running ── fatal error ──> failed
any active ── room pause ──> paused/queue retained
```

约束：

- 同一成员同一时刻最多一个 `running` turn；后来消息进入其 mailbox/queue。
- 不同成员在 room 并发上限内运行。
- 成员 `done` 是一次 run 完成，不代表从房间永久退出；UI 随后回到 `idle`。
- `awaiting_peer` 不占执行槽和物理进程，但保留恢复 continuation。
- 无法真正 resume 的后端，用“原请求 + 滚动摘要 + peer reply + 已完成动作”重建下一 turn，防止重复副作用。

## 4. 路由规则

### 4.1 用户消息

1. 无显式目标：投递协调者。
2. 一个目标：投递该成员。
3. 多个目标：为每个成员创建独立 trigger 和 run，受房间并发上限控制。
4. `@all`：仅用户可发（协调者作为 Agent 不能靠文本升级成广播）；展开为具体成员集合并写入审计。
5. 回复消息：默认投递原作者，除非用户重新选择目标。
6. 结构化 mention（`memberId`）优先于正文扫描；`structured: []` 表示明确不点名，不再回扫文本。引用块 `<quoted_message>` 内的 `@` 不触发。displayName 忽略大小写冲突时文本兜底 fail-closed。算法见 [04 §4](./04-HERMES-BORROW-SPEC.md)。

### 4.2 成员输出

成员不能仅靠输出文本触发另一成员。只有调用宿主 A2A 工具才产生投递；正文中的 `@A` 只作为显示文本，最多由 UI 建议转为显式投递。解析器对 `sender.type === 'member'` 必须返回空目标。

### 4.3 公共与定向内容

- 房间公开消息进入所有成员可检索的 room transcript，但不自动唤醒所有成员。
- 定向 A2A 默认只投影给参与者和协调者；用户始终可在审计视图中查看。
- 机密 Agent-to-Agent 通道不在本地单用户 MVP 中提供，避免出现用户不可审计的隐藏协作。

## 5. A2A 工具协议

宿主向协作室成员暴露最小工具集：

```ts
room_send({ toMemberId, message, visibility? })
room_ask({ toMemberId, question, expected?, timeoutMs? })
room_reply({ requestId, answer })
room_publish_artifact({ taskId?, relativePath, summary })
room_task_update({ taskId, status, summary?, artifactIds? })
room_request_user({ question, options?, blocking: true })
```

语义：

- `room_send`：异步通知，不自动暂停发送者。
- `room_ask`：创建 request/envelope；当前 run 可选择结束为 `awaiting_peer`。
- `room_reply`：必须引用有效 requestId；重复回复幂等。
- `room_publish_artifact`：宿主校验路径、文件存在、hash 和权限后落盘元数据。
- `room_task_update`：只更新被授权的 room task/kanban task，不允许模型随意改别人的任务。
- `room_request_user`：进入需要人类处理的全局队列，不能伪造成普通聊天问题后继续危险操作。

所有工具调用由宿主补齐 `roomId/fromMemberId/runId/rootMessageId/causationId/depth`，模型不能自行声明这些安全字段。

## 6. 为什么 MVP 采用异步信箱

当前本地 CLI runner 是一任务一进程，多个 CLI 的 stdin/resume 能力并不一致。若强求“Agent A 正在运行时即时收到 B 的话”，会把首版绑死在长驻 PTY、协议适配和进程恢复上。

MVP 流程：

```text
A turn 调用 room_ask(B)
  → 宿主持久化 question
  → A run 结束为 awaiting_peer，释放进程
  → B 空闲时被信箱唤醒并回复
  → 宿主把 reply 加入 A 的 continuation
  → A 新 turn 恢复，继续完成任务
```

将来某个 backend 声明 `supportsLiveInput=true` 时，可以在不改变房间协议的情况下优化为实时投递；异步语义仍是可靠降级路径。

## 7. 上下文投影

每次 Member Turn 输入只包含必要上下文，避免把全房间历史和所有工具流灌给每个人：

1. 房间目标与不可变规则。
2. 成员岗位快照、能力、权限和当前任务。
3. 房间滚动摘要：已确认决定、接口、风险、未决事项。
4. 最近 N 条公开消息。
5. 该成员最近 N 条私有信箱/回复。
6. 当前 trigger 和相关 task/artifact。
7. 已执行动作摘要，特别是等待恢复时的副作用清单。

摘要必须标明是系统生成的二级信息；关键验收、文件路径和任务状态从结构化真值重新注入，不能只信摘要。

投影算法（自己→assistant，别人→user 前缀，剥路由 `@`，围栏内保留）见 [04 §5](./04-HERMES-BORROW-SPEC.md)。房间共享摘要由独立总结者维护，按有效公开发言计数，lease + generation CAS；Agent 自称完成不得升级为已验证事实。见 [04 §6](./04-HERMES-BORROW-SPEC.md)。

Handoff 使用现有 mailbox 信封作 outbox：宿主在投递前签发 `attemptId`，忽略模型自报 depth。TAgent MVP 禁止 unlimited 深度。已开始的调用在重启后标 `outcome_unknown`，不得自动重放。见 [04 §7](./04-HERMES-BORROW-SPEC.md)。

## 8. 调度、公平性与幂等

调度器规则：

- 房间内总并发 `maxConcurrentRuns`，默认 3；每成员并发 1。
- 用户直接消息 > 等待用户恢复 > peer reply 恢复 > 已就绪任务 > 背景总结。
- 同优先级按入队时间，防止高频成员饿死其他成员。
- 每个 trigger 生成稳定 idempotency key；进程崩溃恢复时不得重复发布消息、创建任务或提交产物。
- 先写 DB event/outbox，再推 renderer IPC；renderer 丢事件后可按 cursor 重放。
- scheduler lease 防止应用异常恢复时同一 run 被重复认领。

协调者不拥有绕过限制的“超级权限”。它可以拆分、指派和汇总，但创建成员、扩大权限、增加预算、`@all` 风暴等动作仍由宿主策略或用户确认控制。

## 9. 防循环与成本边界

每条触发链携带：

- `rootMessageId`：最初用户/系统根消息。
- `causationId`：直接父事件。
- `depth`：跨成员 A2A 深度，默认上限 4，硬上限 10。
- 规范化内容 fingerprint：检测 A→B→A 的近重复问答。

默认限制：

- 成员不能给自己发 A2A。
- 同一 request 只能有一个有效终态回复。
- 同一路径短时间重复 2 次警告，3 次阻断并通知用户。
- 每根消息设最大 Agent turns、最大 wall time 和最大用量。
- 达到 80% 用量提示；达到 100% 暂停新运行，不突然杀掉正在提交关键产物的 turn，除非用户配置硬截止。
- Agent 不能自行提高这些上限。

## 10. 工作区并发安全

多个进程指向同一 `cwd` 并不等于安全协作。MVP 至少实现下列一种策略，并在创建房间时明确展示：

### 推荐：成员 worktree/隔离目录

- 每个可写成员在房间下拥有独立 worktree/branch。
- 协调者或用户负责集成；产物卡展示 diff 和基线。
- 优点：隔离清楚、可回滚；代价：非 Git 项目和大仓库需要降级。

### 降级：文件租约

- 成员写前声明预期路径或由工具层动态获取 lease。
- 同一文件/目录冲突时，后来者进入 `blocked`，不得静默覆盖。
- lease 有 TTL、run ownership 和崩溃回收。

### 最低安全线

若两者都不可用，只允许一个 `workspace-write` 成员并发运行；其他成员只读。不得仅用 prompt 告诉 Agent“请不要冲突”。

## 11. 权限与安全边界

- 权限是 room 上限与 member profile 的交集，成员不能越权请求宿主执行。
- CLI worker 的命令、cwd、环境变量和输出继续走现有 runner/权限治理；A2A 不成为 shell 旁路。
- 房间消息、附件和其他 Agent 输出都视为不可信输入；系统 prompt 明确区分指令来源，防止横向 prompt injection。
- 只允许已注册 workspace 的相对路径；符号链接逃逸、绝对路径和 `..` 由宿主拒绝。
- 敏感环境变量不进入房间 transcript、A2A payload 或运行详情。
- 危险工具仍走全局 permission request；一个成员获得的临时批准不能自动授权其他成员。
- 用户可见完整审计：谁触发、谁执行、用了哪个 backend、改了什么、为何等待/失败。

## 12. CLI 适配要求

现有 runner 继续负责启动、观察、取消和超时；新增一个 room adapter 层：

```ts
interface MemberBackendAdapter {
  capabilities(): {
    supportsResume: boolean
    supportsLiveInput: boolean
    supportsToolBridge: boolean
    supportsStructuredEvents: boolean
  }
  runTurn(input: MemberTurnInput, signal: AbortSignal): AsyncIterable<MemberEvent>
}
```

首轮实现应补齐：

- 捕获 Claude `session_id`、Codex `thread.started` 等原生 resume 标识；只有经过真实 probe 验证后才启用恢复。
- 不支持原生恢复的 CLI 使用宿主上下文重建，标记 `resumeMode='replay'`。
- A2A 工具优先通过受控 MCP/host bridge 暴露；无法调用工具的 CLI 只能作为 terminal worker，不能冒充完整房间成员。
- 每个成员的 backend capability 在创建页明确显示，运行时不可偷偷降级为拥有更多权限的后端。

## 13. IPC 与前后端一致性

建议新增独立 channel 族，不塞入普通 session IPC：

```text
COLLAB_ROOM_LIST / CREATE / UPDATE / ARCHIVE
COLLAB_MEMBER_ADD / UPDATE / REMOVE
COLLAB_MESSAGE_SEND / LIST
COLLAB_RUN_CANCEL / RETRY
COLLAB_ROOM_PAUSE / RESUME / STOP_ALL
COLLAB_EVENT_SUBSCRIBE / REPLAY
COLLAB_TASK_LINK / UNLINK
```

renderer 以 `eventCursor` 增量消费；切页/重启先加载 snapshot，再从 cursor 重放。所有 renderer 乐观状态最终以主进程返回的实体版本为准。

## 14. 故障恢复

应用启动恢复顺序：

1. 将无有效 scheduler lease 的 `running` run 标为 `interrupted`/可重试，不直接假定失败或完成。
2. 检查 backend resume capability、未提交 artifact 和可能存在的子进程。
3. 恢复房间 snapshot、mailbox 和等待关系。
4. 对可安全重放的 turn 自动入队；存在未知副作用的 turn 进入 `blocked`，要求用户决定重试或标记已完成。
5. 通过 outbox 重推未确认的 renderer 事件。

任何重试都必须展示“是否可能重复副作用”。文件写、git commit、外部 API 写入不能盲目自动重放。

## 15. 不变量

实现和测试必须长期维护这些不变量：

1. 一个 room 恰有一个协调者；协调者也是普通受限成员。
2. 一个 member 同时最多一个 active run。
3. 每个 Agent 输出都有 trigger 和因果链。
4. 没有结构化工具调用就没有 A2A 投递或任务状态变更。
5. room pause 后不启动新 run。
6. 达到深度/预算/并发边界时 fail closed，并向用户解释。
7. 看板已挂载时，room 不维护另一份独立任务状态。
8. 未经隔离/租约保护，不允许多个可写成员并发修改同一工作区。
