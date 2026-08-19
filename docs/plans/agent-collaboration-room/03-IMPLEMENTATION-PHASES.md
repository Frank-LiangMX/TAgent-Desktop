# Agent 协作室：实施阶段、风险与验收

> 上位文档：[00-MASTER](./00-MASTER.md)
> UI：[01-PRODUCT-UX-SPEC](./01-PRODUCT-UX-SPEC.md)
> Runtime：[02-RUNTIME-A2A-SPEC](./02-RUNTIME-A2A-SPEC.md)
> Hermes 机制补强：[04-HERMES-BORROW-SPEC](./04-HERMES-BORROW-SPEC.md)
> 当前进度与交接：[HANDOFF-2026-08-17](../../dev/collaboration-room/HANDOFF-2026-08-17.md)

## 0. 当前进度（2026-08-18）

`feature/collab-room` 尚未合 main。按本文件切片，已完成 / 未完成的真实状态：

**已完成**：S1 房间壳 → S2 单成员 turn → S3 多成员并行 + 协调者路由 → S3.5-a 结构化 mention + 上下文投影 → S3.5-c 安静时间线 / run 卡 → S3.5-b 房间共享摘要 → S4-1/2 信箱纯逻辑 + host 落盘 → S4-3a peer reply 唤醒 continuation → **S4-3b 六把 adapter 工具回路（kscc bare + Anthropic 协议外部渠道原生工具桥）** → S4.5 深度停止 outbox → S5 room task 真值层 + `room_task_assign` / `room_task_update` / `room_publish_artifact` + 工作面板 + 无 `@` 自动协调闭环。

**尚未完成**：S5 看板桥（`attachedBoardId` 仅 fail-closed，无真实桥/投影）、`room_request_user`、S6 全部（Git worktree / 文件租约、prompt injection 横向隔离、预算强制、时间线虚拟化）、CLI worker 成员后端（`backend==='cli'` 占位）、权限档位在 run 侧 enforce、事务性多文件写、scheduler 跨重启持久化。

> 详细对照、边界与下一步见 [HANDOFF-2026-08-17](../../dev/collaboration-room/HANDOFF-2026-08-17.md)。

## 1. 实施策略

不要先做一个“多个头像都会回复”的 UI demo 再补底层。正确顺序是：

```text
契约与持久化
  → 房间壳与静态成员
  → 单成员独立 turn
  → 多成员并行
  → 结构化 A2A/等待恢复
  → 任务/产物/工作区安全
  → 完整恢复与体验打磨
```

每阶段都要可运行、可回滚，且不能破坏普通会话、圆桌、看板和当前 CLI worker。

## 2. Stage 0：技术 Spike 与协议实测

目标：消除“CLI 能不能恢复/调用 host 工具”的最大不确定性，不做产品 UI。

工作：

- 为已支持的 kscc、Codex、Claude 等 runner 记录真实协议事件。
- 捕获并验证原生 session/thread ID；测试第二次调用是否真的沿用上下文。
- 验证 MCP/host tool bridge 的可用性、stdout/stderr 边界、取消和超时。
- 建立 `MemberBackendCapabilities`，明确 `supportsResume/liveInput/toolBridge/structuredEvents`。
- 选择 MVP 工作区策略：优先 Git worktree；验证非 Git 降级的文件租约方案。

交付：

- `docs/dev/collaboration-room/probe-*` 原始记录和结论。
- adapter capability 单测；不支持的能力必须显式为 false。

退出条件：至少两个 backend 能完成独立 turn；至少一个 backend 能可靠调用结构化 A2A 工具。否则 MVP 先限制成员 backend，不做伪兼容。

## 3. Stage 1：领域契约、数据库与独立入口

目标：协作室成为真实一级容器，但暂不自动运行 Agent。

### Shared

建议新增：

```text
packages/shared/src/types/collaboration-room.ts
packages/shared/src/ipc/collaboration-room-channels.ts
```

定义 room/member/message/run/mailbox/task/artifact 类型、schema validator、状态转换与 IPC payload。

### Main

建议新增：

```text
apps/electron/src/main/lib/collaboration/
  collaboration-room-repository.ts
  collaboration-room-service.ts
  collaboration-event-outbox.ts
  collaboration-ipc.ts
```

完成 migration、CRUD、版本/时间戳、事件 cursor 和重启读取。

### Renderer

- `RailItem` 增加 `collaboration`，放在 chat 后。
- `railSupportsSidebar` 改为 chat/collaboration。
- `AppShell.sidebar` 按 activeRail 分别渲染 `SessionSidebar` 或 `CollaborationRoomSidebar`。
- 主区增加 `CollaborationRoomsPage` 路由分支。
- 完成房间创建、列表、选择、暂停、归档、静态消息发送。

退出条件：重启后房间、成员配置和消息不丢；普通 Chat 侧栏与 tab 行为回归通过。

## 4. Stage 2：单成员真实运行闭环

目标：用户在房间点名一个成员，该成员使用独立逻辑会话回答，过程可取消和恢复。

工作：

- 建立 `MemberBackendAdapter`，先接入一个 Pi/channel backend 和一个验证通过的 CLI backend。
- 实现 `MemberTurnInput` 上下文投影与角色快照。
- run 状态：queued → running → done/failed/cancelled。
- 事件先落 DB/outbox，再推 IPC；renderer 可 cursor 重放。
- 成员卡、run 入口卡和详情页；工具细节默认折叠。
- 全局 listener 在离开协作页面后继续维护状态与未读。

退出条件：同一用户消息不会重复产生两个 Agent 发言；取消能杀掉对应进程树；应用重启可识别 interrupted run。

## 5. Stage 3：多成员并行与协调者

目标：实现真实多 Agent，不再由一个模型扮演多个角色。

工作：

- RoomScheduler：房间总并发、成员内串行、公平队列和 scheduler lease。
- 无点名消息路由协调者；多点名并行扇出。
- 协调者可创建 room task、指派成员和最终汇总，但受同样权限/预算限制。
- 成员状态与房间头部预算/并发可见。
- 同一根消息最大 turns、wall time 和 usage 限制。

退出条件：A/B 两成员可以使用不同模型/CLI 并行完成独立任务；任何一方失败不吞掉另一方结果；并发限制重启后仍正确。

## 5.5 Stage 3.5：Hermes 机制补强（不依赖工具回路）

目标：在 S4-3 被 pi-core 挡住时，先把路由、投影、摘要和时间线做到不丢人。真源：[04](./04-HERMES-BORROW-SPEC.md)。

工作（三个可独立 PR）：

- **S3.5-a** 结构化 mention + 引用块 / `@all` / 歧义名守卫；`projectCollaborationTurnContext` 替换 `buildTurnPrompts`。
- **S3.5-b** `summaries.json` + 有效发言阈值 + 总结者六段 prompt + CAS。无模型 fail-closed，不阻塞发言。
- **S3.5-c** 按 `runId` 收成 run 卡；去掉每人一条「思考中」灰泡。

退出条件：04 §4.5 / §5.4 / §6.7 单测绿；04 §9 手测 T1–T8 通过；普通 Chat / 会诊 / 圆桌无回归。成员正文 `@` 仍不能产生 run。

> **进度（2026-08-17）**：**S3.5-a / b / c 均已交付**。a：`resolveCollaborationMentions`（结构化优先 + 文本兜底守卫 + 成员正文 `@` 永不投递 + 引用块 mask + 同名冲突 fail closed）+ `projectCollaborationTurnContext`（自己=assistant / 别人=user + 剥 routable `@` + 摘要 + 信箱预览 + A2A 恢复段）+ `appendUserMessage.mentions`。b：`CollaborationSummaryRunner`（独立总结者，CAS 租约，六段契约 prompt，fail-closed 不阻塞发言，不占 RoomScheduler 槽）。c：`groupCollaborationTimelineItems` + `CollaborationTimeline` / `CollaborationRunCard`（一 run 一卡，流式正文，聚合成员消息）。

## 6. Stage 4：结构化 A2A 与等待恢复

目标：完成本功能与“主会话派工”的本质差异。

工作：

- host/MCP 工具：`room_send/ask/reply/publish_artifact/task_update/request_user`。
- mailbox 持久化、request/reply 幂等和 `awaiting_peer/awaiting_user`。
- peer reply 到达后恢复发送者的新 turn。
- root/causation/depth、内容 fingerprint、循环检测和 TTL。
- A2A 时间线摘要、参与者过滤、完整审计视图。

退出条件：自动化场景“A 询问 B → B 回复 → A 恢复完成”稳定通过；深度超限、自发给自己、重复 reply 和 A↔B 循环均被阻断并可解释。

S4 内部分切片（见 S4-A2A-NOTES 与 04 §7）：

- S4-1 / S4-2 已交付：纯函数 + mailbox 落盘。
- **S4-3a 已交付**：host 侧 peer reply 唤醒（B 回复 → 提问者 awaiting_peer 入队 continuation，幂等键含 requestId）。
- **S4-3b 已交付**：adapter 工具回路 —— 把 `room_send/room_ask/room_reply/room_task_assign/room_task_update/room_publish_artifact` 六把受限工具以真实 AgentTool（TypeBox schema）经原生 tool-use 协议桥接给成员 turn；kscc bare（`createKsccBareStreamFn`）与 Anthropic 协议外部渠道（`createHttpDirectStreamFn`，`isAgentCompatibleProvider`）两条路径。OpenAI-completions / google 等无原生工具能力渠道仍走纯文本 runner（fail-closed，不伪造工具）。
- **S4.5 已交付**：信封作 outbox（`attemptId` / `delivery`：outbox→dispatched→accepted，重启对已开跑 dispatch 标 `outcome_unknown`，未启动 outbox 安全重投）；深度停止可呈现卡 + 「继续一次」（`continueDepthStop`）。

## 7. Stage 5：任务、看板与产物

目标：让聊天协作能落到可验收工作，而不复制看板真值。

工作：

- 无看板时的轻量 room task；附加看板后使用 task bridge。
- 消息、run、task、artifact 双向链接。
- 成员发布产物时校验相对路径、文件、hash 和权限。
- 右侧任务/产物面板；从任务定位消息和 run。
- 看板事件投影到房间，room 不反向覆盖未经授权的 task 状态。

> **进度（2026-08-18）**：已完成「room task 真值层」（`CollaborationRoomTask` + 严格状态机 + version CAS，挂板后 fail-closed）、`room_task_update`（负责人更新状态）、`room_task_assign`（协调者分派未指派任务并自动触发目标成员）、`room_publish_artifact`（路径安全 + 实际 hash/字节数）以及右侧任务/产物工作面板。**未完成**：看板桥（`attachedBoardId` 仅作 fail-closed 标记，无真实桥与投影）、`room_request_user` 和 S6 生产化约束。

退出条件：用户能从最终结论追溯到任务、成员 run、文件和 diff；重启后链接完整；看板和房间不存在相互矛盾的状态副本。

## 8. Stage 6：并发写入与生产化

目标：在真实代码仓库安全使用。

工作：

- Git 项目成员 worktree/branch 生命周期；基线、diff、集成和清理。
- 非 Git 或禁用 worktree 时的路径租约；冲突检测、TTL 和恢复。
- prompt injection 横向隔离、权限交集、敏感信息脱敏。
- 预算统计、80% 警告、硬/软截止、离线 CLI 恢复。
- 时间线虚拟化、无障碍、reduced motion、错误恢复操作。
- 导出审计、房间归档、数据清理策略。

退出条件：并行成员不能无提示覆盖同一文件；崩溃恢复不会盲目重复有副作用操作；长时间线性能与键盘操作达标。

## 9. 推荐切片

每个切片以可测试纵向闭环提交，避免按“先把所有 UI / 再把所有 backend”横切：

| 切片 | 用户可见结果 | 关键风险 | 状态 |
| --- | --- | --- | --- |
| S1 | Rail 可进入、创建/恢复静态房间 | 导航回归、DB migration | ✅ |
| S2 | 一个独立成员可回答 | 幂等、取消、上下文隔离 | ✅ |
| S3 | 两成员并行 + 协调者 | 公平调度、成本倍增 | ✅ |
| S3.5-a | `@` 按成员 ID 投递；投影分自己/别人 | 误把成员文本当路由 | ✅ |
| S3.5-b | 成员能读到六段式房间摘要 | 摘要抢槽、注入、双跑 | ✅ |
| S3.5-c | 一 run 一卡，时间线安静 | 把 Chat 编排搬进房间 | ✅ |
| S4 | A 问 B 后等待并恢复 | continuation、副作用重复 | ✅（S4-1/2 + S4-3a/b） |
| S4.5 | 深度停止可解释、重启不重放已开跑调用 | 另起 outbox 表、unlimited | ✅ |
| S5 | 任务/产物互链 | 双真值、路径安全 | ◐（room task / assign / update / artifact / 面板已完成；看板桥未做） |
| S6 | worktree/租约 + 生产恢复 | 文件冲突、清理与崩溃 | ⬜ |

## 10. 测试矩阵

### 单元测试

- 所有状态转换与非法转换。
- mention/target 路由、结构化 mention、引用块屏蔽、歧义 displayName、`@all` 仅用户、成员正文不路由。
- 上下文投影：自己/别人角色、可见性、围栏内 `@` 保留。
- 房间摘要：有效发言计数、CAS、超预算 fail-closed。
- 时间线按 `runId` 聚合；handoff `attemptId` 去重与 `outcome_unknown`。
- 成员内串行、房间并发。
- A2A depth、request/reply 幂等、循环 fingerprint。
- budget、并发、公平队列、scheduler lease。
- 路径归一化、workspace escape、租约冲突。
- 上下文投影不泄漏其他房间定向消息。

### 集成测试

- SQLite migration、snapshot + event replay。
- 两种 backend adapter 的成功、超时、取消、崩溃和 resume/replay。
- renderer 切页/重启/事件丢失后的 cursor 补偿。
- room task 与 kanban task 的单一真值。
- 子进程树取消和未知副作用恢复。

### E2E 场景

1. 创建两成员房间，分别选择不同模型/CLI。
2. 一条消息点名两人，并行返回，顺序不影响数据一致性。
3. A `room_ask` B，A 等待；B 回复；A 恢复并发布文件。
4. 用户暂停房间，队列不启动；恢复后继续。
5. B 离线，房间显示排队和换后端操作。
6. 两人申请同一文件写入，后者阻塞而非覆盖。
7. 达到 A2A 深度和预算，系统停止新运行并解释。
8. 运行中强制退出应用，重启后无重复消息/重复写入。

### 普通功能回归

- 会话侧栏切换、草稿会话、tab/dock、Chat/Work。
- 会诊/圆桌 one-shot。
- SubAgent 和看板 worker。
- CLI worker 设置、探测、并行 task 和进程树 kill。

## 11. 风险登记表

| 风险 | 严重度 | 早期信号 | 必须的控制 |
| --- | --- | --- | --- |
| 把一个模型扮演多人当成多 Agent | 高 | 所有成员共享同一上下文/run | 每成员独立 logicalSessionId 和 adapter run |
| A2A 无限互聊与成本爆炸 | 高 | turn 数无根、A↔B 重复 | root/causation/depth、fingerprint、预算、turn 上限 |
| 并行覆盖文件 | 高 | 多 runner 同 cwd 写同路径 | worktree/租约；否则单写者 |
| CLI 恢复能力被误判 | 高 | 重试重复命令/文件写 | capability probe；默认 replay；副作用阻塞确认 |
| 房间与看板双真值漂移 | 高 | 同任务两种状态 | 看板挂载后只引用其 task 状态 |
| 横向 prompt injection | 高 | A 的附件诱导 B 越权 | 来源标记、工具鉴权、权限交集、消息不可信 |
| 时间线噪声过大 | 中 | 用户只看到工具日志 | 安静时间线 + run 详情渐进披露 |
| Rail/主 App 状态复杂化 | 中 | chat sidebar/tab 被协作污染 | 独立 atoms/router/sidebar，复用纯 UI 组件 |
| 成员长期上下文膨胀 | 中 | 延迟、成本和遗忘上升 | 滚动摘要 + 结构化真值重新注入 |
| 后台工作不可感知 | 中 | 用户不知道在等谁 | 全局状态、未读、waiting/blocked 显式文案 |
| 过度拟人化造成错误预期 | 中 | 用户认为员工可永久自治 | 使用“协作室/成员/运行”，展示权限和边界 |

## 12. 产品与技术红线

以下情况不能以“先做出来”为由放宽：

- 不得把现有普通 `@` 的 role prompt 投影包装成独立成员。
- 不得用 prompt 约束代替 A2A 深度、预算和文件冲突的宿主硬限制。
- 不得让 Agent 自行创建无限成员、提高权限/预算或修改安全字段。
- 不得把原始 CLI stdout 直接当结构化事件或公开房间消息。
- 不得在无法确认副作用时自动无限重试。
- 不得让 renderer 成为调度或任务真值源。
- 不得为了“实时感”先绑定一个不可靠的长驻进程架构。
- 不得让成员正文中的 `@` 产生 run 或 A2A 投递。
- 不得另起一套与 mailbox 平行的 Hermes handoff 表，也不得开放 unlimited 深度。

## 13. 上线门槛

首个公开 MVP 必须同时满足：

- S1–S4 完成，即独立房间、独立成员、多成员并行、结构化 A2A 都是真实能力。
- 至少一个安全的工作区写策略；否则 MVP 明确只读。
- 深度/预算/并发/权限/取消/重启恢复有自动化测试。
- UI 可以回答“谁在做、在等谁、任务是什么、产物在哪、为何失败”。

若只完成 S1–S3，应标为内部 Alpha“多成员房间”，不能宣传为完整“Agent 协作/数字员工”。

## 14. 实施后的目录边界

```text
packages/shared/src/
  types/collaboration-room.ts
  ipc/collaboration-room-channels.ts

apps/electron/src/main/lib/collaboration/
  repository / service / scheduler / mailbox / adapters / workspace / ipc

apps/electron/src/renderer/features/collaboration/
  pages / sidebar / timeline / composer / roster / tasks / artifacts / atoms / hooks
```

现有模块的改动应保持薄：

- `Rail.tsx`：加入口和 callback。
- `App.tsx`：加路由、侧栏分支与全局同步 hook。
- CLI runner：暴露统一 adapter/capability，不塞房间业务。
- Kanban：提供 bridge API，不知道房间时间线如何渲染。
- Chat：只增加显式“创建/打开协作室”的可选入口，不承载 room runtime。
