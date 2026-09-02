# 融合会话问题审查与修复记录

> 日期：2026-09-02
> 状态：本轮核心问题已修复，P2 优化项保留跟踪
> 审查范围：单会话 ↔ 协作室桥接、融合会话主区、成员运行调度、来源会话投影
> 相关规格：[14-SESSION-COLLAB-BRIDGE-SPEC](./14-SESSION-COLLAB-BRIDGE-SPEC.md)
> 上位规格：[16-FUSION-ORCHESTRATION-HARDENING-SPEC](./16-FUSION-ORCHESTRATION-HARDENING-SPEC.md)

## 1. 结论

融合会话的主链路已经具备可用底座：进房摘要、退出 handoff、房间调度、
成员级运行、A2A mailbox、任务/产物和来源会话投影均已接通。

当前主要问题集中在四类：

1. 用户快速操作时缺少幂等和发送状态保护；
2. 退出、切换和加载失败时，UI 状态与后台真实状态可能脱节；
3. 来源单会话只按 Bot 快照投影，不能完整表达房间的实际成员；
4. 排队运行持有旧配置，且 Renderer 的可用性判断比主进程宽松。

这些问题不影响正常的单次进房、发送和退出流程，但会影响连续操作、异常恢复、
多成员动态变更和长时间运行场景。建议优先处理 P1 项，再补 P2 的一致性和诊断
能力。

## 2. P1 问题

### P1-1：退出协作不会收口正在运行的 run

**位置**

- `apps/electron/src/main/lib/collaboration/session-collab-bridge-service.ts:299`
- `apps/electron/src/main/lib/collaboration/collaboration-room-service.ts:1032`
- `apps/electron/src/main/lib/collaboration/collaboration-room-scheduler.ts:38`

**触发场景**

用户在一个或多个成员仍处于 `running` 时点击「结束协作」。

**现状**

`exitCollaborationWithBridge()` 会读取房间消息并生成 handoff，之后清除
`fusionRoomId`，再把房间设为 `paused`。但调度器的暂停语义只是阻止新的 queued
run，不会中止已经占用 slot 的 run。

**后果**

- handoff 只包含退出时刻之前的结果；
- 用户回到普通会话后，旧房间仍可能继续产出；
- 后续结果不会自动补进已经写回的 handoff；
- 房间虽然是 paused，后台仍可能继续写入消息和运行记录。

**建议**

退出流程应先进入明确的 `exiting` 状态，取消 queued run，并对 running run 执行
中止或等待收口。最终 handoff 应在运行收口后生成，或者明确记录“退出时仍有未完成
运行”，避免用户误以为所有工作已经包含在回写结论中。

### P1-2：快速重复发送会创建重复消息和重复运行

**位置**

- `apps/electron/src/renderer/components/collaboration/CollaborationRoomsPage.tsx:686`
- `apps/electron/src/main/lib/collaboration/collaboration-room-service.ts:1118`

**触发场景**

用户快速连续按两次 Enter，或在第一次 IPC 尚未返回时再次点击发送。

**现状**

Renderer 的 `send()` 没有 in-flight guard，也没有请求级幂等键。每次调用都会追加
一条新的用户消息。由于每条消息都有新的 `messageId`，现有的
`triggerMessageId:memberId` run 幂等键无法识别这是同一次用户操作。

**后果**

- 用户消息重复落盘；
- 协调者或多个点名成员被触发两次；
- 可能造成重复工具调用、重复文件修改或重复任务分派。

**建议**

- Renderer 在发送期间禁用输入提交和发送按钮；
- 输入发送请求生成稳定的 `idempotencyKey`；
- Main 层以该 key 对“消息落盘 + run 扇出”做幂等处理；
- 失败时释放 key 对应的 pending 状态，允许用户明确重试。

### P1-3：切换房间加载期间仍可能显示并操作旧房间

**位置**

- `apps/electron/src/renderer/components/collaboration/CollaborationRoomsPage.tsx:381`
- `apps/electron/src/renderer/components/collaboration/CollaborationRoomsPage.tsx:397`
- `apps/electron/src/renderer/components/collaboration/CollaborationRoomsPage.tsx:472`

**触发场景**

当前房间 A 已加载，用户快速切换到房间 B，而 B 的并行 IPC 请求尚未完成。

**现状**

`roomId` 变化时，组件会重新请求数据，但非空 `roomId` 的加载分支没有立即清空
旧的 `room` 状态。加载完成前，页面仍可能使用 A 的 `room` 渲染；`send()` 闭包
也可能继续使用旧的 `room.id`。

**后果**

- 侧栏选中 B，主区暂时显示 A；
- 用户可能把消息发进 A；
- A 的运行、成员和状态可能被误认为属于 B。

**建议**

切换 `roomId` 时立即进入 loading 状态并清空当前房间，或者在所有操作前校验
`room?.id === roomId`。加载期间应禁用发送、成员操作和工作面板操作。

### P1-4：失效融合链接没有恢复出口

**位置**

- `apps/electron/src/renderer/components/chat/Chat.tsx:3776`
- `apps/electron/src/renderer/components/chat/Chat.tsx:3784`
- `apps/electron/src/main/lib/ipc/session-service.ts:2346`
- `apps/electron/src/main/lib/ipc/session-service.ts:2399`

**触发场景**

会话仍保存 `fusionRoomId`，但协作服务未注册、房间文件被删除、房间数据损坏或
版本迁移导致关联房间不可读取。

**现状**

Chat 只要看到 `fusionRoomId` 就渲染融合壳。加载失败后页面进入空态，但 Chat
传入的 `onNewRoom` 是空函数；同时普通 Chat 的
`recoverStaleCollaborationLink()` 只在旧的发送路径触发，融合壳接管后用户无法
自然进入该路径。

**后果**

- 用户会被困在空的融合页面；
- 「新建协作室」按钮没有实际动作；
- 没有“解除失效链接并回到普通会话”的明确入口。

**建议**

融合壳加载失败时提供“解除失效关联并恢复普通会话”的操作，并保留原房间 ID 和
错误原因供诊断。恢复动作应由主进程完成 meta 清理并通知 Renderer，而不是只改
前端状态。

### P1-5：来源会话投影混用了 Bot 数量和房间成员数量

**位置**

- `apps/electron/src/main/lib/collaboration/collaboration-ipc.ts:130`
- `apps/electron/src/main/lib/collaboration/collaboration-ipc.ts:154`

**触发场景**

来源会话有 Bot A、Bot B，进入融合后再添加一个没有 `botProfileId` 的手动 Codex、
CLI 或外部渠道成员，随后移除 Bot B。

**现状**

`syncSourceSessionAfterRoomMemberChange()` 从活跃成员中只提取
`botProfileId`，再以 `botProfileIds.length` 决定来源会话是否继续保持
`multi-bot`。手动成员不会计入这个判断。

**后果**

房间实际仍有两个活跃执行成员，但来源会话会被降为 `single-bot`，并清除
`fusionRoomId`。用户会突然离开融合壳，而房间本身仍在协作。

**建议**

拆分三个概念：

- 来源会话保留的 Bot 快照；
- 房间当前活跃执行成员；
- 是否仍允许来源会话绑定融合壳。

投影不能用 `botProfileIds.length` 代替房间成员数。至少应保证“房间仍有多个活跃
执行成员”时不会静默解除融合链接。

### P1-6：退出回写失败后仍然清除链接

**位置**

- `apps/electron/src/main/lib/collaboration/session-collab-bridge-service.ts:351`
- `apps/electron/src/main/lib/collaboration/session-collab-bridge-service.ts:369`

**触发场景**

退出 handoff 已生成，但原 session 的 `appendPanelMessages()` 落盘失败。

**现状**

回写失败只打印日志，后续仍然清除 `fusionRoomId`，并将房间设为 `paused`。

**后果**

- 原会话看不到协作结论；
- 房间已经退出，用户失去正常重试入口；
- 结论可能永久丢失。

**建议**

回写失败时保留融合绑定，或持久化一个 `handoff_pending` 状态。只有确认回写成功
后，才清除 `fusionRoomId` 和暂停房间。也可以提供“重试写回”而不重新执行成员
任务的专用动作。

## 3. P2 问题

### P2-1：进房摘要取消会留下半成品房间

`enterCollaborationWithBridge()` 先创建房间并写入 `fusionRoomId`，之后才调用摘要
模型。如果 `AbortSignal` 触发，房间和链接已经落盘，但前情提要没有写入。

位置：

- `apps/electron/src/main/lib/collaboration/session-collab-bridge-service.ts:174`
- `apps/electron/src/main/lib/collaboration/session-collab-bridge-service.ts:197`

建议把摘要结果作为提交房间链接前的准备阶段，或在取消/失败时清理绑定并标记可重试。

### P2-2：排队 run 使用旧的房间和成员配置

调度器入队时保存完整的 `room` 和 `member` 快照：

- `apps/electron/src/main/lib/collaboration/collaboration-room-scheduler.ts:23`
- `apps/electron/src/main/lib/collaboration/collaboration-room-service.ts:456`

如果 run 排队期间修改了手动成员的渠道、模型、CLI worker、权限，或修改了房间预算，
真正启动时仍可能使用旧配置。

建议 `executeRun()` 启动前按 `roomId`、`memberId` 和 `runId` 重新读取当前持久化快照。

### P2-3：Renderer 的后端可用性提示比真实执行条件宽松

Renderer 目前把以下条件视为可执行：

- Codex：始终可执行；
- CLI：存在 `cliWorkerId` 即可执行；
- 渠道：存在 `channelId` 即可执行。

但 Main 侧还会检查 Runtime、worker 是否启用、渠道是否启用、API Key 和模型是否有效。

位置：

- `apps/electron/src/renderer/components/collaboration/CollaborationRoomsPage.tsx:631`
- `apps/electron/src/main/lib/collaboration/member-backend-adapter.ts:614`

建议增加一个主进程统一的成员后端状态接口，Renderer 直接展示真实状态和失败原因，
避免用户发送后才发现成员不可用。

### P2-4：房间初始加载的单个接口失败会清空整个页面

主区通过一个 `Promise.all()` 同时加载房间、消息、成员、运行、摘要、任务、产物、
审批和 continuation。任一请求失败，catch 分支会清空所有数据并进入空态。

位置：

- `apps/electron/src/renderer/components/collaboration/CollaborationRoomsPage.tsx:397`
- `apps/electron/src/renderer/components/collaboration/CollaborationRoomsPage.tsx:472`

建议将核心数据与增强数据拆开处理。房间、消息、成员失败才进入页面级错误；
摘要、任务、审批等失败时只让对应区域显示不可用。

### P2-5：来源会话摘录 IPC 缺少 room/session 绑定校验

Host tool 路径会从房间绑定关系注入 `sourceSessionId`，但公开的
`readCollaborationSourceExcerpt` IPC 直接把调用参数交给桥接服务，服务本身只验证
`sourceSessionId` 存在，不验证它是否属于传入 `roomId`。

位置：

- `apps/electron/src/main/lib/collaboration/collaboration-ipc.ts:712`
- `apps/electron/src/main/lib/collaboration/session-collab-bridge-service.ts:423`

在当前单窗口本地模型中风险有限，但这是边界不清的问题。建议公开 IPC 不接受任意
`sourceSessionId`，或者强制验证：

```text
room.sourceSessionId === request.sourceSessionId
```

## 4. 已确认暂时不是问题

### 4.1 Codex Runtime 不是每次打开弹窗都重新完整探测

`resolveCodexRuntimeAsync()` 使用进程级 Promise 缓存。默认调用只会在主进程生命周期
内执行一次完整异步探测，安装成功后才显式清缓存。

位置：

- `apps/electron/src/main/lib/adapters/codex/codex-runtime-resolver.ts:499`
- `apps/electron/src/main/lib/adapters/codex/codex-runtime-resolver.ts:509`

因此，成员添加或成员设置弹窗虽然每次都会请求状态，但默认不会重复执行完整的
Codex 探测。后续可以优化 IPC 调用次数，但不属于当前融合会话的阻塞问题。

### 4.2 同一主进程内的进房重复建房不是当前确定问题

`enterCollaborationWithBridge()` 在第一次 `await` 之前同步调用
`upgradeFusionSession()`，而该函数会立即写入 `fusionRoomId`。因此同一 Electron
主进程中的第二次进房调用通常会复用已有房间。

退出流程不同：退出会在 handoff 模型调用处 `await`，所以需要独立的服务级 in-flight
锁或幂等键，不能只依赖确认框防重复点击。

## 5. 测试覆盖缺口

当前相关正常路径测试已通过，但缺少以下回归测试：

- 两次快速发送只落盘一条用户消息并只创建一组 run；
- 退出时存在 running run 的行为；
- 退出 handoff 回写失败后的状态；
- 进房摘要 abort 后的房间和 session meta；
- 切换房间加载期间禁止操作旧房间；
- Bot 成员与无 `botProfileId` 成员混合时的来源投影；
- 排队期间修改成员/房间配置后的实际执行配置；
- 单个增强数据 IPC 失败时核心房间仍可显示；
- 来源摘录 IPC 的 room/session 绑定校验。

## 6. 建议修复顺序

1. P1-1：退出时收口 running/queued run，并重新定义 handoff 时机；
2. P1-2：发送锁和消息级幂等；
3. P1-3：房间切换 loading 隔离；
4. P1-4、P1-6：失效链接恢复和 handoff 失败可重试；
5. P1-5：重做来源会话投影判定；
6. P2-1、P2-2：桥接提交和排队快照刷新；
7. P2-3、P2-4、P2-5：可用性、加载降级和 IPC 边界；
8. 为每项补最小回归测试，再进行打包版 GUI 验证。

## 7. 本轮开发结果

### 7.1 已完成

- P1-1：退出协作前取消当前房间 queued/running run，并等待在途 run 收口后再生成 handoff。
- P1-2：协作室发送增加 in-flight 锁和消息级 `idempotencyKey`，重复请求复用原消息，不重复扇出运行。
- P1-3：切换房间时立即清空旧房间投影，异步加载期间不再操作旧房间。
- P1-4：失效融合链接提供解除关联出口，恢复为普通会话；渠道缺失时提供设置页入口。
- P1-5：来源会话投影按真实活跃成员数判断，支持 Bot 与手动 Codex/CLI/外部成员混合。
- P1-6：退出 handoff 回写失败时保留 `fusionRoomId`，为重试保留入口。
- P2-2：queued run 启动前重新读取最新房间、成员、消息和 run 快照。
- P2-5：来源摘录读取强制校验 `roomId` 与房间绑定的 `sourceSessionId` 一致。
- P2-4：核心房间数据与摘要、信箱、任务、产物、审批、续跑等增强数据分层加载；
  单个增强 IPC 失败不再清空整个主区。
- P2-1：进房摘要取消或提交失败时撤销本次 `fusionRoomId` 绑定，并暂停半成品房间。
- P2-3：增加主进程权威的成员后端状态 IPC；Codex、渠道、CLI 分别按真实运行条件判断，
  Renderer 展示不可用原因。
- 新增消息幂等、混合成员投影、来源摘录绑定校验等回归测试。

### 7.2 验证结果

- 全量 Vitest：`245` 个测试文件通过、`1` 个跳过；`2817` 个测试通过、`2` 个跳过。
- 融合桥接相关定向测试：`16/16` 通过。
- workspace 类型检查：通过。
- `git diff --check`：通过。

### 7.3 后续跟踪

以下项目不阻塞本轮融合会话主链路，后续可单独迭代：

- GUI 打包版的真实多窗口、切房间、退出中运行收口验证。
