# 多用户融合会话与 Bot 协作：长期实现规格

> 状态：实现草案；用于持续开发与验收，不等同于已完成实现
> 日期：2026-08-20

## 0. 文档定位

本文件把“普通会话、融合会话、持久 Bot、多人协作室、Bot 侧窗、共享工作区”统一为一套可落地的产品与运行时规格。它是长期实现模块的主规格，后续代码、测试、决策和阻塞项都必须回写到实施记录。

与现有文档的关系：

- 00-MASTER、01-PRODUCT-UX-SPEC、02-RUNTIME-A2A-SPEC、03-IMPLEMENTATION-PHASES 是已有协作室设计与历史实施基础。
- 04-HERMES-BORROW-SPEC 和 05-PERSISTENT-BOTS-AND-ROOM-SEATS 记录了 Hermes 借鉴、持久 Bot、席位和记忆的讨论结论。
- ADR-0007 当前仍是历史决策，里面的“独立 Rail / 独立入口”不能直接覆盖本规格提出的统一会话入口；在代码验证完成前，不修改 ADR-0007，而把本文件视为拟议的扩展和后续修订依据。

## 0.1 当前实现校正（2026-08-23）

本规格的产品边界仍然有效，但实现状态以 [13-HANDOFF-2026-08-23](./13-HANDOFF-2026-08-23.md) 和最新 implementation log 为准。当前已接入 Room authority、远程 Gateway/HTTP/SSE、Bot execution bridge、任务/产物/审批/A2A、房间工作区事务和 Bot workspace 工具；title/goal、运行 blocked 恢复、workspace delete/move 也已进入代码与回归测试。

以下能力仍是后续交付，不应被 UI 已出现或类型已存在误认为完成：真实账户/证书/跨机器部署、跨节点单写者与持久 continuation worker、真实 Pi/KSCC/provider 进程验收、Git worktree、完整 Bot handoff/memory consolidation E2E 和打包版网络入口。RoomWorkspace 的实际内容在服务端房间目录，其他用户通过受控发布和下载获得产出；不默认反向同步到个人磁盘。
## 1. 产品结论

用户只需要理解“会话里有哪些参与者”，不需要先理解普通会话、协作室、Bot 会话三套入口：

| 参与者 | 用户体验 | 运行时
| --- | --- | --- |
| 只有用户 | 现有普通会话 | 单 AgentSession / 单 Run 路径
| 用户 + 1 个 Bot | 直接与 Bot 对话 | 与普通单 Agent 路径一致
| 用户 + 2 个以上 Bot | 融合会话；未 @ 时由默认协调 Bot 承接 | RoomSession + 任务/A2A 调度
| 用户 + 其他用户 | 多人融合会话 | 服务端权威 RoomSession
| 正式会话中临时 @ 未加入 Bot | Bot 侧窗咨询 | 独立 SidecarSession，通过桥接向主会话提交提案

核心原则：单 Bot 不引入多 Bot 的复杂度；添加第二个 Bot 时才启用协调、任务分派和 Bot 间协作。

## 2. 实体边界与生命周期

```text
Conversation（用户可见会话）
  ├─ private AgentSession（0/1 Bot 的稳定路径）
  └─ RoomSession（2+ Bot 或多用户）
       ├─ HumanMember
       ├─ RoomBotSeat ──> BotProfile（所有权属于 Bot 用户）
       ├─ RoomAgentSession ──> Run
       ├─ RoomWorkspace ──> Artifact / Task
       └─ RoomEvent / Mailbox

BotProfile（长期身份）
  ├─ 配置版本
  ├─ 私有长期记忆（active/candidate）
  └─ 多个场景下的独立 AgentSession
```

### 2.1 实体契约

| 实体 | 归属 | 生命周期 | 关键不变量
| --- | --- | --- | --- |
| BotProfile | Bot 所有者 | 创建、暂停、归档、删除 | 不等同于角色卡；不可携带某个房间私密上下文
| BotConfigRevision | BotProfile | 发布后不可变 | 新会话取最新；运行中的会话继续使用已绑定版本
| BotMemory | Bot 所有者 | 持续精炼；可版本化 | candidate 不进入 Prompt；active 才可检索
| Conversation | 创建者/参与者 | 活跃、归档、删除 | 是统一 UI 外壳，不强行改变原私有会话数据
| RoomSession | 服务端房间 | 活跃、暂停、归档、结束 | 是多人/多 Bot 的权威运行边界
| RoomBotSeat | RoomSession | join、pause、replace、remove | 是 Bot 的房间副本/派驻，不是 Bot 本体
| RoomAgentSession | room + seat | 可压缩、恢复、重建 | 每个房间席位独立，不能跨房间共享
| HumanMember | 用户账户 | invite、join、leave、remove | 权限与 Bot 所有权分离
| RoomWorkspace | RoomSession | 创建、锁定、归档、下载 | 服务端实际权威内容，不绑定为某个用户私有目录
| SidecarSession | 用户 + Bot + 主会话 | 打开、隐藏、结束 | 关闭窗口不等于销毁上下文；主会话是公共时间线唯一写入者

### 2.2 Bot 与席位

加入房间时创建 RoomBotSeat，至少保存：seatId、botId、ownerUserId、configRevisionId、displayNameSnapshot、roleSnapshot、roomPermissionProfile、isCoordinator、status、joinedAt、leftAt、handoffSummary。

席位是当时配置的副本：房间历史不会因 Bot 库改名而改写，Bot 私有记忆也不会因席位加入而复制给其他人。席位删除只结束该房间内的派驻关系，不删除 BotProfile。

## 3. 会话升级与统一入口

普通会话可以从 UI “添加 Bot”升级，但不能把原私有 AgentSession 原地改造成多人公共房间：

1. 读取原会话允许共享的消息摘要、用户明确选择的文件和任务信息。
2. 新建 RoomSession / RoomWorkspace / RoomAgentSession。
3. 原私有会话保留，作为来源会话只读或继续单独使用。
4. 未确认的 Bot candidate memory、私有工作目录、完整私聊历史不自动带入。

这样既保留用户“继续当前工作”的直觉，也避免误把私密上下文共享给其他 Bot 或人。

## 4. 消息路由、协调与生命周期

### 4.1 路由规则

- 0 Bot：原普通会话 Agent 直接承接。
- 1 Bot：该 Bot 是唯一承接者，不显示协调者概念，不启动 A2A。
- 2+ Bot：第一个加入且仍在席位中的 Bot 默认为协调者。
- 用户显式 @ 某 Bot：建立目标 Bot 的任务或直接回复。
- 用户未 @：交给协调者；协调者可创建任务、邀请其他席位协作，再向公共时间线汇总。
- Bot 间沟通通过受控 mailbox / task event；不把内部 prompt、隐藏思维链直接作为公共消息。
- 原始任务的回复由协调者或原任务负责人汇总；公共时间线只接受宿主校验过的正式事件。

### 4.2 席位变更

| 操作 | 行为
| --- | --- |
| 替换 Bot | 旧席位退出；新席位绑定新 config revision；生成 handoff summary；不复制私有记忆
| 删除普通 Bot | 若有运行先进入 transfer/wait/stop 决策；关闭未完成任务或转交给协调者
| 删除协调者 | 先生成 handoff；从剩余活跃 Bot 中按稳定排序提升下一位；无 Bot 时回到普通会话/归档
| Bot 所有者离线 | Bot 席位保留；任务按策略排队或暂停；不静默改扣费主体
| 房主离开 | 转移房间所有权或进入等待/归档；不把 Bot 所有权转给房主

### 4.3 状态机

BotProfile：draft -> active -> paused -> archived。

RoomBotSeat：invited -> accepted -> idle -> running / awaiting_user / blocked -> paused / removed。

SidecarSession：open -> hidden/minimized -> open；显式“结束咨询”才进入 ended。提升为标签页或正式成员时创建新的场景绑定，不把侧窗临时状态直接混入公共时间线。

## 5. 上下文、记忆和可见性

### 5.1 上下文层级

Prompt 组装顺序必须可审计：系统约束、Bot config revision、场景摘要、公共房间投影、任务上下文、工具结果、当前用户消息、允许的 active memory。candidate memory、其他用户私聊、其他房间内容和未授权本地文件必须被排除。

BotProfile 的长期记忆是小而精炼的工作知识，不是无限聊天记录：

- 原始候选记忆落盘到候选区，标记来源、置信度、时间和版本。
- AI 定期或按阈值做去重、合并、分类、过时检测和摘要。
- 整理结果仍是 candidate，用户确认后才成为 active。
- active memory 每次变更保留版本和审计原因，可回滚。
- 普通一对一会话可读取该 Bot 的相关 active memory；多 Bot 房间只读取允许复用的 active memory。
- 房间消息、侧窗内容和内部 A2A 不自动升级为 Bot 全局记忆。

### 5.2 可见性

| 内容 | 默认可见范围 | 说明
| --- | --- | --- |
| 用户正式消息 | 房间成员 | 进入公共投影
| Bot 正式回复 | 房间成员 | 由宿主写入公共时间线
| 任务、进度、审批、产物 | 房间成员/按 ACL | 用结构化事件展示
| Bot 内部协调 | 摘要/任务卡 | 原始内部 prompt 和隐藏思维链不公开
| 侧窗咨询 | 发起用户 + Bot | 可提交提案，但不自动公开
| Bot 私有记忆 | Bot 所有者及其授权调用 | 不因加入房间公开

## 6. 多用户、所有权和权限

服务端保存 HumanMember 和 Bot seat；客户端只显示经过权限过滤的事件投影。Bot 的实际服务原则是“谁拥有，谁授权，谁承担模型费用”，但资源权限仍需叠加房间政策和任务范围。

有效能力集合：

```text
Bot capabilities
∩ Bot owner consent
∩ Room policy
∩ Task scope
∩ Resource owner grant
∩ 当前运行时安全策略
```

权限分工：

- 房间管理员：邀请/移除人和席位、房间策略、暂停/归档。
- Bot 所有者：Bot 配置版本、私有记忆、默认工具、是否接受房间邀请、默认预算。
- 资源所有者：个人文件是否上传/复制/挂载、是否允许写回。
- 任务负责人：任务范围内的执行与转交。

其他用户邀请某人的 Bot 必须获得 Bot 所有者确认，并明确工具范围、触发范围、预算和是否允许写入共享工作区。所有者离线时不自动转移费用或权限。

## 7. 工作区、产物与并发写入

### 7.1 实际存储

RoomWorkspace 是服务端实际存在的权威目录：自托管局域网时通常位于房间宿主/房主指定的服务端磁盘；广域网部署时位于服务端持久卷。它不是“房主个人原始目录”的别名。

推荐逻辑命名空间：/shared、/members/<userId>、/tasks/<taskId>、/artifacts、/audit。成员个人原始目录仍归成员所有，只有用户明确上传/复制/同步后才进入房间工作区。

第一阶段采用单向产出流：Bot 在服务端工作区写入 -> 服务端版本化并审计 -> 成员预览/下载。其他用户要获得实际产出，使用下载，不默认反向同步到个人磁盘。

### 7.2 并发策略

默认共享文件采用 Hermes 风格的混合策略：短时 per-path lock、expectedSha256 乐观并发校验、临时文件写入、原子 rename；提交时基线 SHA 已变化则返回 workspace_conflict，不静默覆盖。

复杂的多文件长任务使用 task worktree / task copy，完成后以结构化 Diff 和人工或协调者确认合并。workspace_diff 主要用于展示、审计和合并，不代替文件真值。

### 7.3 文件安全

- 所有 workspace path 先解析到 RoomWorkspace 根目录内，禁止路径穿越。
- 工具调用带 roomId、seatId、taskId、resourceGrantId，宿主再次鉴权。
- 个人文件不允许因“Bot 在同一个房间”而直接可读。
- 写回个人目录必须由资源所有者显式确认，第一阶段不实现自动写回。
- 删除、覆盖、下载和合并都产生审计事件；优先软删除和可恢复版本。

## 8. 运行时与双核适配

RoomSession 只依赖统一的 MemberBackendAdapter / AgentSessionHost，不直接依赖 KSCC 进程细节。KSCC 和 Pi 都必须提供同一组宿主能力：create/resume/compact/interrupt、流式事件、工具调用、结构化结果、usage、错误和恢复。

KSCC 的 session loop 不完全由宿主控制，因此要靠宿主事件桥、运行 fencing、取消令牌和提交前权限复核；Pi 核若是宿主可控 loop，则复用同一事件契约，通常实现更直接。两者都不能越过 RoomEventStore 直接写公共时间线。

正式事件流：

```text
用户消息 / @ / 工具结果
  -> Router
  -> RoomTask + RunScheduler
  -> AgentSessionHost（KSCC 或 Pi）
  -> Host Event Adapter
  -> Permission / schema / budget gate
  -> RoomEventStore（唯一公共写入者）
  -> 推送给客户端
```

侧窗桥接：Sidecar 只读取主会话的 public projection；Bot 生成结构化 proposal；主会话 Agent 或宿主验证后决定是否采用；采用时由主会话产生正式消息/任务，不允许侧窗进程直接插入公共消息表。

## 9. 现有代码复用与最小新增边界

优先复用：

- packages/shared/src/types/collaboration-room.ts 的 room/member/message/task 状态与校验。
- packages/shared/src/types/collaboration-a2a.ts 的 mailbox / A2A 信封。
- apps/electron/src/main/lib/collaboration/ 的房间服务、任务、产物、审批、A2A、workspace diff 和审计能力。
- 现有 session-service、agent adapter、memory consolidation 和 renderer 会话/侧栏状态。

需要新增或演进：

1. HumanMember、BotProfile、BotConfigRevision、BotMemoryRecord。
2. RoomBotSeat 与 RoomAgentSession，解耦当前 member 与 Bot 源身份。
3. RoomWorkspace 实体和 room-scoped path/resource grant。
4. Conversation participant model 与普通会话升级派生流程。
5. RoomEvent projection、Router 和公共写入 gate。
6. SidecarSession、floating window 状态、bridge proposal IPC。
7. 多用户鉴权、邀请、在线状态、owner consent 和费用归属。

现有 CollaborationMember 可以先兼容读取，迁移时补 seatId、botId、ownerUserId 等字段，禁止一次性破坏旧房间 JSON/数据库数据。

## 10. 实施切片与验收门

### Phase A：领域模型和兼容迁移

- [x] 加共享类型和 schema，不接 UI（已落地；RoomEvent/RoomWorkspace/Bot seat/memory 契约已存在）。
- [x] 旧 CollaborationRoom 数据可读；新字段有安全默认值。
- [x] BotProfile / revision / memory candidate-active 的 CRUD 和审计测试（本地持久化范围）。

验收：类型测试、旧 fixture 读取、权限拒绝测试通过。

### Phase B：单 Bot 融合路径

- [x] Conversation participant 选择（统一会话页）。
- [x] 1 Bot 复用现有普通 Agent 路径。
- [x] Bot profile snapshot 和场景 AgentSession 绑定（单 Bot/RoomBotSeat 快照）。

验收：用户能从同一会话页添加/替换/删除唯一 Bot，历史不丢，未启动 A2A。

### Phase C：多 Bot 协调路径

- [x] 默认协调者、@ 路由、任务和 mailbox（复用本地 CollaborationRoomService）。
- [x] 公共事件唯一写入者和结构化内部协调摘要（本地 RoomEvent 账本；服务端事务 gate 仍未完成）。
- [x] 席位替换/删除/协调者转交（本地房间范围）。

验收：无 @ 由协调者承接；@ 精确路由；失败、取消、重复投递幂等。

### Phase D：多用户和共享工作区

- [ ] HumanMember、邀请、owner consent、离线策略（本地状态机和授权已完成；真实账户、网络邀请、离线策略未完成）。
- [ ] RoomWorkspace、ACL、下载、短锁 + SHA 冲突（本地 RoomWorkspace/下载/路径与 SHA 已完成；协议层 ACL 判定已落地 `fusion-room-acl.ts`，服务端 ACL/短锁冲突协议未完成）。
- [x] 服务端实际工作区与个人原始目录隔离（本地服务目录已完成；远程服务端部署未完成）。

验收：跨用户 Bot 能访问已授权共享资源，不能读取私有文件；并发冲突可见且不覆盖。

### Phase E：Sidecar 和统一 UI

- [x] @ 未加入 Bot 打开侧窗，拖拽、缩放、吸边球、隐藏/结束（桌面本地范围）。
- [x] bridge IPC 只提交 proposal，主会话决定是否落公共时间线。
- [x] 侧窗提升为标签页/正式成员（本地统一会话入口）。

验收：关闭窗口不丢逻辑会话；未确认内容不污染主会话；主会话仍稳定。

### Phase F：记忆精炼、恢复和多核回归

- [x] candidate -> active 的用户确认流。
- [ ] KSCC/Pi 统一 adapter contract、恢复/fencing、费用审计（RoomSession 权威核心与本地 CollaborationRoomService fencing 已接入；真实双核 create/resume/compact/interrupt、心跳、恢复、远程费用审计和 usage 回写未完成）。
- [ ] 崩溃恢复、长上下文压缩、权限动态收紧。

验收：同一 Bot 在多场景并行不串记忆；重启可恢复；权限收紧立即生效；模型费用归属正确。

## 11. 测试矩阵

| 类别 | 必测场景
| --- | --- |
| 路由 | 0/1/2+ Bot、@、无 @、协调者移除、重复消息
| 身份 | 同 Bot 多房间并行、配置版本固定、替换不复制私密记忆
| 记忆 | candidate 不入 prompt、确认入 active、合并去重、回滚
| 权限 | Bot owner、room admin、resource owner、task scope 交集
| 多用户 | 邀请/接受/拒绝、离线、退出、房主转移、跨用户 Bot
| 工作区 | 路径穿越、SHA 冲突、原子写、锁超时、任务副本合并、下载
| 运行时 | KSCC resume/compact/interrupt、Pi loop、fence、超时、重试幂等
| Sidecar | 开关/拖拽/缩放/吸边、桥接提案、拒绝落盘、提升成员
| 回归 | 旧普通会话、旧协作室 fixture、现有 artifact/approval/A2A/workspace 测试

## 12. 风险和暂不承诺

- KSCC 的 loop 可控性有限，不能把“永久 Bot session”作为可靠业务真值；必须保持场景 AgentSession 与可恢复摘要。
- 多用户文件共享的隐私边界比 UI 更重要，任何默认共享都需要 ACL 和审计验证。
- 将普通会话升级为 RoomSession 会改变数据可见性，必须派生而不是原地变更。
- Sidecar 的 UX 可以先实现，但跨进程/跨窗口 IPC、取消、主会话回写和崩溃恢复必须先做契约测试。
- Bot 的长期记忆如果自动激活，会带来错误固化；本规格明确要求用户确认。
- “谁拥有 Bot 谁付费”需要账户、额度、离线策略和服务器部署模型支持，不能只在前端显示。

## 13. 未验证假设

- 当前仓库尚无完整的多用户账户/服务端 RoomEventStore；需要先盘点已有 IPC 和持久层。
- 现有 CollaborationMember 的 roleSnapshot/capabilities/permissionProfile 可作为兼容迁移入口，但不应继续承载 BotProfile 的全局身份。
- Hermes Studio 的短锁、expected SHA、临时文件和原子替换可借鉴其机制，但需在本项目存储层和并发模型中重新测试。
- KSCC 与 Pi 的 adapter 事件能力还需要用真实 CLI/运行时验证，不能仅凭模型选择器推断。

## 14. 参考

- docs/plans/agent-collaboration-room/00-MASTER.md
- docs/plans/agent-collaboration-room/02-RUNTIME-A2A-SPEC.md
- docs/plans/agent-collaboration-room/03-IMPLEMENTATION-PHASES.md
- docs/plans/agent-collaboration-room/04-HERMES-BORROW-SPEC.md
- docs/plans/agent-collaboration-room/05-PERSISTENT-BOTS-AND-ROOM-SEATS.md
- docs/decisions/ADR-0007-agent-collaboration-room.md
- F:/hermes-studio/packages/server/src/services/hermes/group-chat/remote-workspace-files.ts
- F:/hermes-studio/packages/server/src/routes/hermes/group-chat.ts
