# Agent 协作室 Stage 3 实现说明

> 分支：`feature/collab-room`
> 上游规格：`docs/plans/agent-collaboration-room/00-MASTER.md` · `02-RUNTIME-A2A-SPEC.md`（§8 幂等 / §9 并发预算 / §14 故障恢复）· `03-IMPLEMENTATION-PHASES.md` §5 Stage 3
> 范围：多成员并行 + 协调者路由的纵向可演示闭环。**不**做完整 A2A mailbox / 协调者自动派工 / CLI backend（留 S4+）。
> 前置：S1 房间壳 + 落盘 + CRUD、S2 单成员真实 turn 闭环（见 `S1/S2-IMPLEMENT-NOTES.md`）。

## 0. 退出条件对照

| 退出条件 | 实现位置 |
| --- | --- |
| 无 @ 只唤醒协调者（保留 S2 行为） | `appendUserMessage` 用 `parseCollaborationMentions` 解析文本；无命中 → `targetMemberIds=[]` → `triggerRunForMessage` 的 `resolveTargetMembers` 回落 `[coordinator]` |
| @成员名 / @displayName 只唤醒被点名成员（可多个） | `parseCollaborationMentions`（精确匹配 displayName，忽略大小写；末尾标点剥离）→ `targetMemberIds` → 每目标一个 run |
| 多个点名并行扇出（受 maxConcurrentRuns；同成员串行） | `triggerRunForMessage` 每目标创建 queued run（幂等键 `triggerMessageId:memberId`）→ `RoomScheduler.enqueue`；房间级并发 + 成员内至多 1 running + FIFO |
| 一方 failed 不取消另一方；结果各自落盘 | 每个 run 独立 `executeRun` 状态机；failed 落系统警告、done 落成员消息；互不干扰（见 multi 测试「一方 failed 不取消另一方」） |
| 房间头部可见活跃 run 数 / maxConcurrent；成员状态 idle/running | `CollaborationRoomsPage` 头部「并发 x/y」「排队 N」+ 成员状态条（空闲/思考中/排队中，以 runs 为准） |
| 重启后并发队列/running 恢复策略与 S2 一致（interrupted，无假 running） | `recoverInterruptedRuns`（未改）：遗留 queued/running → `failed(INTERRUPTED)`，成员回 idle；调度器为内存态，重启即空，不跨重启保留队列 |

## 1. 做了什么

### A. Shared（`packages/shared/src/types/`）

| 文件 | 作用 |
| --- | --- |
| `collaboration-room.ts` | 新增纯函数 `parseCollaborationMentions(text, members): string[]` + 常量 `COLLABORATION_MENTION_ALL='all'`：`@all`→全部成员（含协调者，按顺序去重）；`@displayName`→精确匹配忽略大小写、末尾中英文标点剥离；未命中返回 `[]`（调用方回落协调者）。无 DB、无时间依赖，纯函数可单测。 |
| `collaboration-room-channels.ts` | 新增 `ADD_MEMBER` 通道 + `AddCollaborationMemberInput = { roomId } & CreateCollaborationMemberInput`；返回类型注释补 `ADD_MEMBER → CollaborationMember`。 |
| `collaboration-room.test.ts` | +9 用例：无 @ / @displayName / 英文忽略大小写 / @all / @all+具体去重 / 无匹配忽略 / 末尾标点剥离 / 重复 @ 去重 / 常量值。 |

### B. Main（`apps/electron/src/main/lib/collaboration/`）

| 文件 | 作用 |
| --- | --- |
| `collaboration-room-scheduler.ts`（新） | `RoomScheduler`：`runningByRoom`（房间级并发计数）+ `runningByMember`（成员内至多 1）+ FIFO `queue`。`enqueue` 入队后 drain 立即启动可启动者；`release`（executeRun finally 调）释放 slot + drain 后续；`dequeue`（cancelRun 排队中取消用）移除未启动 run；`isIdle/isMemberRunning/hasQueuedForMember` 供 `awaitAllRuns` 与成员状态同步。`getMaxConcurrentRuns` 与 `start` 回调注入；`canStart` 用 `Math.max(1, max)` 防异常值死锁。仅内存态，重启即空（与 S2 恢复策略一致）。 |
| `collaboration-room-scheduler.test.ts`（新） | 11 用例：房间 max=2/1 并发上限、成员内串行（含 max=1 严格串行）、FIFO 公平（被阻塞早条目不插队越过可启动晚条目，成员空闲后按序启动）、dequeue 排队取消 / 已 running 返回 false、跨房间独立、max=0 不死锁、release 未知 runId 安全、isIdle 初始 true。 |
| `collaboration-room-service.ts` | Stage 3 核心：①`appendUserMessage` 落盘前 `parseCollaborationMentions`→`targetMemberIds`（显式 `input.targetMemberIds` 优先）。②`triggerRunForMessage` 改为多目标：`resolveTargetMembers`（targetMemberIds 非空→按序去重跳过未知；否则→协调者→首成员），每目标建 queued run（幂等）+ `scheduler.enqueue`；入队后若成员未 running 则置 `queued`。③`executeRun` 移除各分支的 `setMemberStatus('idle')`，改在 `finally` 统一 `scheduler.release` + `syncMemberStatus`（running 不覆盖；有排队→queued；否则 idle）。④`cancelRun` 区分：`scheduler.dequeue` 命中→排队取消（不占 slot，syncMemberStatus）；未命中→running 取消（abort，executeRun finally release）。⑤`awaitAllRuns` 改为循环到 `scheduler.isIdle()`（含排队→启动→完成）。⑥新增 `addMember(roomId, input)`（displayName + 自动绑默认渠道，校验房间存在/未归档/成员数上限）。`createScheduler` 注入 `getMaxConcurrentRuns`（读 `room.maxConcurrentRuns`）+ `start`（fire-and-forget `executeRun` + `inflight.set`）。 |
| `collaboration-ipc.ts` | +`ADD_MEMBER` handler（`service.addMember`）；日志改为 10 通道 + Stage 3 描述。 |
| `collaboration-room-multi.test.ts`（新） | 9 用例：无 @→只协调者、@开发→只开发（+targetMemberIds 落盘）、@all→全部、@开发@协调者→两 run done + 两成员消息、多目标幂等（同消息再触发不双跑）、一方 failed 不取消另一方（A failed+系统警告 / B done+成员消息）、并发=1 排队（1 running+1 queued→都 done）、成员内串行（两消息各 @开发→第二件排队→都 done）、排队中 run 可取消。 |

接线改动：
- `preload/index.ts`：+`addCollaborationMember` + 导入 `AddCollaborationMemberInput`。
- `renderer/App.tsx`：`declare global electronAPI` +`addCollaborationMember` 签名（同步全局声明，避免渲染层 typecheck 报错）；`newCollaborationRoom` 默认带「协调者 + 开发」两个成员（手测即可发 @点名 / 多成员并行）；导入 `AddCollaborationMemberInput`。

### C. Renderer

| 文件 | 作用 |
| --- | --- |
| `components/collaboration/CollaborationRoomsPage.tsx` | 头部加「并发 {running}/{maxConcurrent}」「排队 N」+「添加成员」按钮（UserPlus，prompt 输入 displayName → `addCollaborationMember`，自动绑默认渠道）；新增成员状态条（每成员 chip：空闲/思考中/排队中，以 runs 为准 + 协调者标记）；时间线改为多条「思考中」气泡（每个活跃 run 一条，running 优先 queued 随后，各自取消按钮，queued 显示「等待空闲 slot」）；`cancelling` 改 `cancellingId` 按 run 区分；空态/输入框 placeholder 更新为 @点名说明。文案统一「协作室 / 成员 / 房间 / 运行」。 |

## 2. 如何手测

> 启动：`bun run dev`（或 `apps/electron` 下 `bun run dev`）。
> 前置（二选一）：kscc 内网启用且本机有 `kscc` 命令；或启用任一非 kscc 外部渠道 + API Key + 模型。新建房间时两成员各自自动绑定可用渠道（kscc 优先）。

1. **房间两个成员（协调者+开发）→ 无 @ 只协调者回**
   - Rail「协作」→ 侧栏「新建」→ 自动创建带「协调者 + 开发」两成员的房间并选中；头部成员状态条显示两成员。
   - 主区输入「帮我看下这个设计」回车（无 @）→ 仅出现「协调者 思考中…」→ 协调者回复气泡；开发状态保持空闲，未被唤醒。头部「并发 1/3」。

2. **@开发 只开发回**
   - 输入「@开发 改一下登录页」→ 仅「开发 思考中…」→ 开发回复气泡；协调者未被唤醒。落盘消息 `targetMemberIds=[开发ID]`。

3. **@协调者 @开发 两人几乎并行（或受并发=1 时排队）**
   - 默认 maxConcurrent=3：输入「@协调者 @开发 两人都评估一下」→ 时间线同时出现两条「思考中」气泡（协调者 + 开发），各自取消按钮；两成员几乎并行回复。
   - 排队演示：先「添加成员」加第三个成员，或把房间并发调小（S3 暂未提供 UI 调整，可在 `~/.tagent[-dev]/collaboration/rooms.json` 手动改 `maxConcurrentRuns:1` 后重开 app），再发 @两人 → 一条思考中 + 一条「等待空闲 slot…（排队中）」；前者完成后者再启动。

4. **一人失败不影响另一人已完成消息**
   - 构造一方失败：暂停房间后把某成员绑定的渠道禁用，或在 `channels.json` 临时清掉一个成员的 `channelId`（使其 `MemberBackendResolveError`），恢复运行后发 @两人 → 失败方变系统警告「成员「XX」回复失败：…」，另一方仍正常落盘成员消息；两 run 各自终态（failed / done），互不取消。
   - 自动化等价：`collaboration-room-multi.test.ts` 的「一方 failed 不取消另一方」用例。

> @all：输入「@all 一起上」→ 全部成员（含协调者）各跑一个 run，受并发上限。
> 取消排队中的 run：在「等待空闲 slot…」气泡点取消 → 该 run 置 cancelled、不启动；正在跑的另一 run 不受影响。
> 重启无假 running：运行中关闭 app → 重开 → 遗留 run 已 `failed(INTERRUPTED)`，无残留思考中气泡（与 S2 一致）。

数据落盘：`~/.tagent-dev/collaboration/{rooms,members,messages,runs}.json`（dev；正式 `~/.tagent/collaboration/`）。

## 3. 验证结果

- `vitest run packages/shared`：24 文件 / 490 用例全过（含新增 9 mention）。
- `vitest run apps/electron`：85 文件 / 892 用例全过（含新增 `collaboration-room-scheduler.test.ts` 11 + `collaboration-room-multi.test.ts` 9；S1/S2 用例全保留且过）。
- `bun run --filter='@tagent/shared' typecheck`：0 错误。
- `bun run --filter='@tagent/electron' typecheck`（main + preload + renderer）：0 错误。
- `build:main` + `build:preload`（esbuild）：构建成功；`dist/main.cjs` 含全部 10 个 `collaboration-room:*` 通道字符串 + `RoomScheduler` + `parseCollaborationMentions` + `addMember`（未被 tree-shake）；`dist/preload.cjs` 含全部 10 通道 + `addCollaborationMember` + `changed`。

新增单测覆盖：
- **mention 解析**（shared）：`@all` / `@displayName` 忽略大小写 / 末尾标点剥离 / 无匹配忽略 / 重复去重。
- **scheduler**（main，隔离）：房间并发上限（max=2/1）、成员内串行（含 max=1 严格串行）、FIFO 公平、dequeue、跨房间独立、max=0 不死锁、release 未知 runId 安全。
- **多成员集成**（main，mock adapter）：无 @→协调者、@成员→指定、@all→全部、多目标并行 + 各自成员消息、多目标幂等（同消息再触发不双跑）、一方 failed 不取消另一方、并发=1 排队、成员内串行、排队中可取消。

## 4. 未做（S4+ 入口）

按 `03-IMPLEMENTATION-PHASES.md` 切片，以下留后续：

- **S4 结构化 A2A 与等待恢复**：`room_send/ask/reply/publish_artifact/task_update/request_user` 工具、`CollaborationMailboxEnvelope` 真实读写、`awaiting_peer/awaiting_user`、root/causation/depth + fingerprint + 循环检测 + TTL、peer reply 到达后恢复发送者新 turn。当前 run 状态枚举已含 `awaiting_peer/awaiting_user/blocked` 但不产生；`MemberTurnInput.onTextDelta` 流式回调仍在接口留位但未接 renderer。
- **协调者自动拆 task 派工**：当前协调者只是「无 @ 时的默认路由目标」，不会自动拆任务并 `@` 其他成员。留 S4（A2A 工具就绪后）。
- **S5 任务 / 产物 / 看板**：`CollaborationRoomTask` 真实读写、room task ↔ kanban bridge、产物校验。
- **S6 并发写入与生产化**：Git worktree / 文件租约、横向 prompt injection 隔离、预算统计与硬截止、时间线虚拟化、Markdown/附件渲染、流式 onTextDelta 接 renderer。

已知 Stage 3 简化（已在代码注释标注）：
- mention 解析为**文本侧**精确匹配 displayName（忽略大小写）；不支持模糊/别名/ID 形式，不支持 displayName 含空格（`@\S+` 分词）。`@all` 路由全部成员（含协调者），受并发上限；未做「@all 权限档位」限制（02-spec §9 的 `@all` 受限操作留 S4+）。
- 调度器为**单实例内存态**：跨重启不保留队列；重启时遗留 queued/running 一律 `failed(INTERRUPTED)`（S2 一致，避免假 running / 重复副作用），不自动重排队。公平队列为 FIFO（同成员不插队），未做优先级/预算加权。
- 上下文投影仍为 S2 简化版（`systemPrompt` + 近 12 条 chat 转录），未实现滚动摘要 / 信箱 / 任务投影（S4+）。
- 成员失败回 `idle`（可重试），不进 `blocked`（无重试/换后端 UI，S4+）。
- 「添加成员」按钮为最小实现（prompt 输入 displayName，自动绑默认渠道，无角色/权限/CLI backend 选择）；CLI backend（`backend==='cli'`）仍未实现 adapter（capabilities 全 false 占位，S4+）。
- 房间并发上限 `maxConcurrentRuns` 在创建时设定（默认 3），S3 未提供运行时 UI 调整入口（可手改 `rooms.json` 验证排队）。
