# Agent 协作室 Stage 2 实现说明

> 分支：`feature/collab-room`
> 上游规格：`docs/plans/agent-collaboration-room/00-MASTER.md` · `02-RUNTIME-A2A-SPEC.md`（§2.4 run 字段 / §3 状态机 / §8 幂等 / §12 adapter / §14 故障恢复）· `03-IMPLEMENTATION-PHASES.md` §4 Stage 2
> 范围：单成员真实 turn 纵向最小闭环。**不**做多成员并行 / A2A mailbox / worktree（留 S3+）。
> 前置：S1 房间壳 + 落盘 + CRUD（见 `S1-IMPLEMENT-NOTES.md`）。

## 0. 退出条件对照

| 退出条件 | 实现位置 |
| --- | --- |
| 用户发消息 → 协调者用独立逻辑会话真实跑一轮并回复落盘 | `appendUserMessage` → `triggerRunForMessage` → `executeRun` → `ChannelBackendAdapter.runTurn`（@tagent/pi-core seat runner 真实调用外部渠道模型）→ 落盘成员消息 |
| 时间线可见成员消息 | `CollaborationRoomsPage` member 气泡（按成员显示名）+ CHANGED 广播实时刷新 |
| 可取消 | `cancelRun` → abort AbortController + 置 cancelled；UI「思考中」气泡有取消按钮 |
| 重启后 run 中断可识别（interrupted/failed 而非假 running） | `recoverInterruptedRuns`（IPC 注册时调用）：遗留 queued/running → `failed` + `error.code='INTERRUPTED'`，成员回 idle |
| 同一用户消息不重复产生两条 Agent 发言（幂等） | `collaborationRunIdempotencyKey(triggerMessageId, memberId)` + `findRunByIdempotencyKey` 入队去重 |

## 1. 做了什么

### A. Shared（`packages/shared/src/types/`）

| 文件 | 作用 |
| --- | --- |
| `collaboration-room.ts` | `CollaborationRun` 增 `idempotencyKey` 字段；新增 `COLLABORATION_RUN_ID_PREFIX`、`collaborationRunIdempotencyKey(triggerMessageId, memberId)`、`isCollaborationRunStatus` 守卫；新增 `MemberBackendAdapter` 接口 + `MemberTurnInput`（含 channelId/modelId/signal/onTextDelta）+ `MemberTurnResult`（02-spec §12 简化版：`runTurn` 返回 `Promise<MemberTurnResult>` 而非 `AsyncIterable<MemberEvent>`，S3+ 再升级流式）。 |
| `collaboration-room-channels.ts` | 新增 `LIST_RUNS` / `CANCEL_RUN` 通道；`CollaborationRoomChangedPayload.kind` 扩展为 `created/updated/archived/message-appended/member-message-appended/run-started/run-finished/run-cancelled` + `at`；重新导出 `CollaborationRun`。 |
| `collaboration-room.test.ts` | +5 用例：run ID 前缀、`isCollaborationRunStatus` 合法/非法、幂等键稳定派生 + 不同输入不同键。 |

### B. Main（`apps/electron/src/main/lib/collaboration/`）

| 文件 | 作用 |
| --- | --- |
| `member-backend-adapter.ts`（新） | `resolveChannelBackendConfig({channelId?, modelId?})`：显式 channelId → 用该渠道（kscc-internal 走 `createKsccSeatRunner`，其余走 `createPiHttpSeatRunner`）；未绑定 → 第一个 enabled 外部（非 kscc）渠道 + 默认模型；无则抛 `MemberBackendResolveError('NO_EXTERNAL_CHANNEL', '请先配置外部渠道…')`。`ChannelBackendAdapter` 实现 `MemberBackendAdapter`：一次 turn 真实调用外部渠道/kscc 模型（与会诊 `run-moa-turn` 同路），`signal` 透传给 seat runner，120s 超时兜底。凭据在主进程解密，不进 renderer/run 记录。 |
| `collaboration-room-repository.ts` | +`runs.json` CRUD：`loadRuns/saveRuns/upsertRun/getRun/listRunsByRoom/listRunsByMember/findRunByIdempotencyKey/listRunsByStatus`；+`getMember/upsertMember`（状态机更新成员 status）。 |
| `collaboration-room-service.ts` | Stage 2 核心：`appendUserMessage` 落盘后若房间 active → 异步 `triggerRunForMessage`（不阻塞 IPC）；`triggerRunForMessage` 解析目标成员（显式点名[0] → 协调者 → 首成员）+ 幂等去重 + 创建 queued run + fire-and-forget `executeRun`；`executeRun` 状态机 queued→running→done\|failed\|cancelled（CAS 转换 race-safe），完成落盘成员消息/系统警告 + 广播 CHANGED；`cancelRun`（abort + cancelled）；`recoverInterruptedRuns`（启动恢复，标记假 running）；`awaitAllRuns`（测试用）。`create(opts?)` 可注入 adapter/broadcast。 |
| `collaboration-ipc.ts` | `registerCollaborationRoomIpc(getWindow?)`：注册 9 个通道（+`LIST_RUNS`/`CANCEL_RUN`）；`broadcast` 包装为 `win.webContents.send(CHANGED, {roomId, kind, at})`（对齐 kanban-bootstrap）；注册时调 `recoverInterruptedRuns()`。 |

接线改动：
- `main/lib/config/config-paths.ts`：+`getCollaborationRunsPath`（`collaboration/runs.json`）。
- `main/index.ts`：`registerCollaborationRoomIpc()` → `registerCollaborationRoomIpc(() => mainWindow)`（注入广播窗口）。
- `preload/index.ts`：+`listCollaborationRuns` / `cancelCollaborationRun` / `onCollaborationRoomChanged`；导入 `CollaborationRun` 类型。

### C. Renderer

| 文件 | 作用 |
| --- | --- |
| `components/collaboration/CollaborationRoomsPage.tsx` | 时间线显示 member 气泡（按成员显示名标注作者）；活跃 run 时在时间线末尾显示「思考中」气泡（成员名 + 脉冲点 + 取消按钮）；暂停房间显示「不会启动新运行」提示；空态文案更新为 Stage 2。拉取 `listCollaborationRuns`，活跃 run 即时反映。 |
| `App.tsx` | `declare global electronAPI` +3 方法签名；`newCollaborationRoom` 默认带一个协调者成员（demo 即可发消息触发真实 turn）；新增 `useEffect` 订阅 `onCollaborationRoomChanged` → `bumpCollab`（run/member/message 变更实时刷新侧栏 + 主区）。 |

文案统一用「协作室 / 成员 / 房间 / 运行」。

## 2. 如何手测

> 启动：`bun run dev`（或 `apps/electron` 下 `bun run dev`）。
> 前置：在「设置 → 渠道」中配置并启用至少一个**外部渠道**（非 kscc-internal），填 API Key + 至少一个 enabled 模型。否则发消息后成员会回复失败并提示「请先配置外部渠道」。

1. **新建房间 → 发消息 → 看到成员回复**
   - 切到 Rail「协作」→ 侧栏「新建」→ 自动创建带「协调者」成员的房间并选中。
   - 主区输入框发一条消息（Enter）→ 时间线出现①用户气泡 ②「协调者 思考中…」气泡（带取消按钮）③ 几秒后变为协调者回复气泡（真实模型回复）。
   - 侧栏该房间圆点在运行期间反映活跃状态；CHANGED 广播驱动实时刷新（无需手动点）。

2. **运行中取消**
   - 发一条会触发较长回复的消息 → 在「思考中」气泡点「取消」→ 气泡消失，run 置 `cancelled`，无成员消息；成员回 idle，可继续发新消息。

3. **重启后无假 running**
   - 发一条消息，在「思考中」时直接关闭 app（模拟崩溃，run 仍 running）。
   - 重开 app → 切到该房间 → 时间线无残留「思考中」假象；runs.json 中该 run 已是 `failed` + `error.code='INTERRUPTED'`（IPC 注册时 `recoverInterruptedRuns` 标记）。可重新发消息触发新 run。
   - 自动化等价：`collaboration-room-run.test.ts` 的「启动恢复」用例。

4. **幂等（同消息不双跑）**
   - 同一条用户消息只产生一条成员回复。即便内部对同一 `(triggerMessageId, memberId)` 重复触发，也只跑一次。
   - 自动化等价：`collaboration-room-run.test.ts` 的「幂等」用例。

5. **无外部渠道时明确失败**
   - 若未配置任何 enabled 外部渠道：发消息 → 成员「思考中」一瞬后变系统警告「成员「协调者」回复失败：没有可用的外部渠道：请在设置 → 渠道中配置并启用一个非 kscc 渠道…」，run `failed`。

数据落盘位置：`~/.tagent-dev/collaboration/{rooms,members,messages,runs}.json`（dev；正式 `~/.tagent/collaboration/`）。

## 3. 验证结果

- `vitest run packages/shared`：24 文件 / 481 用例全过（含新增 5）。
- `vitest run apps/electron`：83 文件 / 870 用例全过（含新增 `collaboration-room-run.test.ts` 7 + `member-backend-adapter.test.ts` 12；S1 `collaboration-room-repository.test.ts` 10 仍过）。
- `tsc --noEmit -p packages/shared/tsconfig.json`：0 错误。
- `tsc --noEmit -p apps/electron/tsconfig.json`（main + preload + renderer）：0 错误。
- `build:main` + `build:preload`（esbuild）：构建成功；`dist/main.cjs` 含全部 9 个 `collaboration-room:*` 通道字符串 + `recoverInterruptedRuns` + `createPiHttpSeatRunner`（未被 tree-shake）；`dist/preload.cjs` 含全部 9 通道 + `changed`。

新增单测覆盖：
- **run 状态转换**：`run 状态转换 queued → running → done`（延迟 mock 观察 running 中态）。
- **append 后触发（mock backend）**：`appendUserMessage 触发 run → 成员消息落盘 + run done`。
- **幂等**：`同一 (triggerMessageId, memberId) 不双跑`（adapter 仅调用一次）。
- **取消**：`cancelRun 置 cancelled，不写成员消息`。
- **失败**：`adapter 抛错 → run failed + 系统警告`。
- **暂停**：`暂停房间 appendUserMessage 只落盘不触发 run`。
- **启动恢复**：`遗留 running run → failed(INTERRUPTED)，成员回 idle`。
- **adapter 解析**：12 用例覆盖显式/缺省/kscc/各类错误码 + runTurn 透传 systemPrompt/prompt/modelId/signal。

## 4. 未做（S3+ 入口）

按 `03-IMPLEMENTATION-PHASES.md` 切片，以下留后续：

- **S3 多成员并行 + 协调者**：`RoomScheduler`（房间总并发、成员内串行、公平队列、scheduler lease）、无点名路由协调者、多点名并行扇出、预算/并发上限强制、同一根消息 turns/wall/usage 限制。当前 `triggerRunForMessage` 只取首目标单成员；`maxConcurrentRuns` 记录但未强制。
- **S4 结构化 A2A 与等待恢复**：`room_send/ask/reply/publish_artifact/task_update/request_user` 工具、`CollaborationMailboxEnvelope` 真实读写、`awaiting_peer/awaiting_user`、root/causation/depth + fingerprint + 循环检测 + TTL。当前 run 状态枚举已含 `awaiting_peer/awaiting_user/blocked` 但不产生。
- **S5 任务 / 产物 / 看板**：`CollaborationRoomTask` 真实读写、room task ↔ kanban bridge、产物校验。
- **S6 并发写入与生产化**：Git worktree / 文件租约、横向 prompt injection 隔离、预算统计与硬截止、时间线虚拟化、Markdown/附件渲染、流式 onTextDelta 接 renderer。

已知 Stage 2 简化（已在代码注释标注）：
- `MemberBackendAdapter.runTurn` 返回 `Promise<MemberTurnResult>` 而非 `AsyncIterable<MemberEvent>`；流式 `onTextDelta` 已在接口留位但未接 renderer（时间线为完成态气泡，无逐字流式）。S3+ 接流式。
- 上下文投影（02-spec §7）为简化版：`systemPrompt`（角色+目标）+ `prompt`（最近 12 条 chat 消息转录 + 触发消息 + 回复指令）；未实现滚动摘要 / 信箱 / 任务投影（S3+）。
- 成员失败后回 `idle`（可重试），不进 `blocked`（无重试/换后端 UI，S3+）。
- 启动恢复**不自动重放** interrupted run（02-spec §14：避免重复副作用）；用户重新发消息触发新 run（新 messageId → 新幂等键，不冲突）。
- 空白团队（无成员）发消息静默跳过（console.warn），不写警告消息；demo 房间经 `newCollaborationRoom` 默认带协调者，故命中此路径仅为 S1 风格空白团队。
- 未绑定时默认取第一个 enabled **外部（非 kscc）**渠道（任务要求）；显式绑定 kscc-internal 亦可走 kscc runner。
- CLI backend（`backend==='cli'`）尚未实现 adapter（capabilities 全 false 占位），S3+ 接 CLI worker adapter。
